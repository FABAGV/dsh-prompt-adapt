/**
 * 控制台的 JSON 接口（挂在 console-server 的 `/api/*` 下，只有登录后的本机浏览器能调）。
 *
 * 这里只做参数校验和转发：画像操作走 `promptAdapt` 服务，权限走 `PrivacyPolicy.update(…, 'console')`，
 * 人格与技能走各自的仓库和 `Workbench`。
 */
import { isHumanMessage, humanText } from './signals.js'
import { listCorpusChats, listMembers, readChatRecords } from './qq-corpus.js'
import { CLASS_INFO, TIER_INFO } from './privacy.js'
import { exposedName } from './skills.js'
import { renderPersonaText } from './persona.js'

const MARK_ACTIONS = { pin: 'pinEntry', seal: 'sealEntry', delete: 'deleteEntry' }

function ok(json = {}) {
  return { status: 200, json: { ok: true, ...json } }
}

function fail(status, error, extra = {}) {
  return { status, json: { ok: false, error, ...extra } }
}

function fromResult(result, extra = {}) {
  if (result?.ok) return ok({ ...result, ...extra })
  return fail(result?.status ?? 409, String(result?.error ?? '操作失败'), result?.job ? { job: result.job } : {})
}

const normalize = text => String(text ?? '').replace(/^\s*\[\d+\]\s*/, '').replace(/[\s「」『』“”"'‘’，。,.！!？?：:；;（）()【】\[\]、…\-—]/g, '')

/**
 * 每条画像条目的引文能不能在你自己的发言里逐字找到。找不到的条目很可能来自别处
 * （子代理的委派 prompt、QQ 群聊）或是模型改写过，值得你回看。
 */
export function evidenceReport(entries, sessions) {
  const corpus = []
  for (const events of sessions.values()) {
    for (const event of events) if (isHumanMessage(event)) corpus.push(normalize(humanText(event)))
  }
  const haystack = corpus.join('\u0001')
  const out = {}
  for (const entry of entries ?? []) {
    const quotes = Array.isArray(entry?.evidence) ? entry.evidence : []
    let found = 0
    let checked = 0
    for (const quote of quotes) {
      const parts = String(quote).split(/…|\.\.\./).map(normalize).filter(part => part.length >= 4)
      if (parts.length === 0) continue
      checked += 1
      if (parts.every(part => haystack.includes(part))) found += 1
    }
    out[entry.id] = { quotes: quotes.length, checked, found, status: checked === 0 ? 'unknown' : found === checked ? 'found' : found === 0 ? 'missing' : 'partial' }
  }
  return out
}

/**
 * @param {object} deps
 * @param {object} deps.service `PromptAdaptService`
 * @param {import('./privacy.js').PrivacyPolicy} deps.policy
 * @param {import('./sessions.js').SessionScanner} deps.scanner
 * @param {import('./persona.js').PersonaStore} deps.personas
 * @param {import('./skills.js').SkillStore} deps.skills
 * @param {import('./workbench.js').Workbench} deps.workbench
 * @param {import('./jobs.js').JobRunner} deps.jobs
 * @param {() => Map<string, object[]>} deps.learnableSessions 允许学习的会话（画像材料同一口径）
 * @param {() => object} deps.consoleInfo
 * @param {object} deps.config
 */
export function createConsoleApi(deps) {
  const { service, policy, scanner, personas, skills, workbench, jobs, config } = deps
  const routes = []
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler })

  const sessionRows = () => scanner.sessionSummaries().map(item => {
    const rule = policy.ruleFor({ ...item, id: item.id })
    return {
      id: item.id,
      title: item.title,
      cwd: item.cwd,
      createdAt: item.createdAt,
      lastAt: item.lastAt,
      userMessages: item.userMessages,
      kind: rule.kind,
      parentKind: rule.parentKind,
      chatKey: rule.chatKey,
      tier: rule.tier,
      learn: rule.learn,
      injectProfile: rule.injectProfile,
      skills: rule.skills,
      private: rule.private,
      override: policy.overrides.sessions[item.id] ?? null,
    }
  }).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

  route('GET', /^\/overview$/, () => {
    const state = service.getState()
    const rows = sessionRows()
    const byKind = {}
    for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
    const audit = policy.recentAudit(200)
    const dayAgo = Date.now() - 24 * 3600_000
    const allSkills = skills.list()
    return ok({
      console: deps.consoleInfo(),
      profile: {
        version: state.profile?.version ?? null,
        entries: state.profile?.entries?.length ?? 0,
        generatedAt: state.profile?.generatedAt ?? null,
        mode: state.mode,
        lastRun: state.lastRun,
        trigger: state.trigger,
        injection: state.injection,
      },
      privacy: {
        enforcing: policy.enforcing,
        sessions: byKind,
        deniedLastDay: audit.filter(item => item.type === 'deny' && item.at >= dayAgo).length,
        lastPolicyChange: audit.find(item => item.type === 'policy') ?? null,
        effective: policy.describe().effective,
      },
      personas: {
        total: personas.list().length,
        enabled: personas.list().filter(item => item.enabled).length,
      },
      skills: {
        enabled: config.skills.enabled,
        autoMine: config.skills.autoMine,
        active: allSkills.filter(item => item.status === 'active').length,
        candidate: allSkills.filter(item => item.status === 'candidate').length,
        lastRunAt: skills.state.mining.lastRunAt,
        lastError: skills.state.mining.lastError,
      },
      qq: { corpusChats: listCorpusChats(workbench.corpusRoot()).length },
      jobs: jobs.running(),
    })
  })

  // ── 画像 ─────────────────────────────────────────────────────────
  route('GET', /^\/profile$/, () => {
    const state = service.getState()
    let evidence = {}
    try {
      evidence = evidenceReport(state.profile?.entries ?? [], deps.learnableSessions())
    } catch {
      evidence = {}
    }
    return ok({ state, evidence })
  })
  route('POST', /^\/profile\/regenerate$/, () => {
    const started = jobs.start({ kind: 'profile', key: 'profile', label: '重新生成画像' }, async () => {
      const result = await service.regenerateNow()
      if (!result?.ok && !result?.skipped) throw new Error(result?.error ?? '生成失败')
      return { version: result?.profile?.version ?? null, skipped: result?.skipped === true, reason: result?.reason ?? null }
    })
    return fromResult(started)
  })
  route('POST', /^\/profile\/mode$/, ({ body }) => {
    if (body?.mode !== 'auto' && body?.mode !== 'custom') return fail(400, "mode 只能是 'auto' 或 'custom'")
    service.setMode(body.mode)
    return ok({ mode: body.mode })
  })
  route('PUT', /^\/profile\/custom$/, ({ body }) => {
    if (typeof body?.text !== 'string') return fail(400, 'text 必须是字符串')
    if (body.text.length > 200_000) return fail(413, '自定义文本最多 20 万字')
    service.setCustomText(body.text)
    return ok({ length: body.text.length })
  })
  route('POST', /^\/profile\/entry\/(pin|seal|delete)$/, ({ body, match }) => {
    const id = typeof body?.id === 'string' ? body.id : ''
    const claim = typeof body?.claim === 'string' ? body.claim : ''
    const key = typeof body?.key === 'string' ? body.key : ''
    if (!id && !claim && !key) return fail(400, '需要 id、claim 或 key')
    return fromResult(service[MARK_ACTIONS[match[1]]](id, claim, key))
  })
  route('POST', /^\/profile\/entry\/(unpin|unseal|restore)$/, ({ body }) => {
    if (typeof body?.key !== 'string' || !body.key) return fail(400, '需要 key')
    return fromResult(service.clearMark(body.key))
  })
  route('POST', /^\/profile\/clear$/, ({ body }) => {
    if (body?.confirm !== '清空画像') return fail(400, '请在确认框里输入「清空画像」')
    service.clearProfile()
    return ok()
  })

  // ── 权限 ─────────────────────────────────────────────────────────
  route('GET', /^\/privacy$/, () => ok({ policy: policy.describe(), sessions: sessionRows() }))
  route('PUT', /^\/privacy$/, ({ body }) => {
    const result = policy.update(body?.overrides, 'console')
    if (!result.ok) return fail(400, result.error)
    return ok({ policy: policy.describe() })
  })
  route('GET', /^\/sessions$/, () => ok({ sessions: sessionRows(), classes: CLASS_INFO, tiers: TIER_INFO }))
  route('GET', /^\/audit$/, ({ query }) => ok({ items: policy.recentAudit(Number(query.get('limit')) || 200) }))

  // ── QQ 语料 ──────────────────────────────────────────────────────
  route('GET', /^\/qq\/chats$/, () => ok({ chats: listCorpusChats(workbench.corpusRoot()) }))
  route('GET', /^\/qq\/members$/, ({ query }) => {
    const [chatType, chatId] = String(query.get('chat') ?? '').split(':')
    const days = Number(query.get('days')) || config.persona.corpusDays
    const records = readChatRecords(workbench.corpusRoot(), { chatType, chatId, days })
    const members = listMembers(records).slice(0, 200).map(member => ({
      memberId: member.memberId,
      senderId: member.senderId,
      names: member.names,
      messages: member.messages,
      lastTs: member.lastTs,
    }))
    return ok({ members, records: records.length })
  })

  // ── 人格 ─────────────────────────────────────────────────────────
  const personaView = persona => persona && {
    ...persona,
    /** 当前版本实际会被注入的文本（与试聊用的是同一份）。 */
    preview: renderPersonaText(persona),
    runningJob: jobs.running().find(job => job.key === `persona:${persona.id}`) ?? null,
    lastJob: jobs.list().find(job => job.key === `persona:${persona.id}`) ?? null,
  }
  route('GET', /^\/personas$/, () => ok({ personas: personas.list().map(personaView) }))
  route('POST', /^\/personas$/, ({ body }) => {
    const result = personas.create(body ?? {})
    if (!result.ok) return fail(400, result.error)
    policy.record({ type: 'persona', actor: 'console', action: 'create', persona: result.persona.id, name: result.persona.name, kind: result.persona.kind, source: result.persona.source })
    return ok({ persona: personaView(result.persona) })
  })
  route('GET', /^\/personas\/([a-z0-9]+)$/, ({ match }) => {
    const persona = personas.get(match[1])
    return persona ? ok({ persona: personaView(persona) }) : fail(404, '找不到这个人格')
  })
  route('PATCH', /^\/personas\/([a-z0-9]+)$/, ({ match, body }) => {
    const before = personas.get(match[1])
    const wasEnabled = before?.enabled
    const result = personas.update(match[1], body ?? {})
    if (!result.ok) return fail(400, result.error)
    if (body?.enabled !== undefined || body?.bindings !== undefined) {
      policy.record({ type: 'persona', actor: 'console', action: 'update', persona: match[1], enabled: result.persona.enabled, wasEnabled, bindings: result.persona.bindings })
    }
    return ok({ persona: personaView(result.persona) })
  })
  route('DELETE', /^\/personas\/([a-z0-9]+)$/, ({ match }) => {
    const result = personas.remove(match[1])
    if (result.ok) policy.record({ type: 'persona', actor: 'console', action: 'delete', persona: match[1] })
    return fromResult(result)
  })
  route('POST', /^\/personas\/([a-z0-9]+)\/generate$/, ({ match }) => fromResult(workbench.startGenerate(match[1])))
  route('POST', /^\/personas\/([a-z0-9]+)\/refine$/, ({ match, body }) => fromResult(workbench.startRefine(match[1], body?.feedbackIds)))
  route('POST', /^\/personas\/([a-z0-9]+)\/test$/, async ({ match, body, signal }) => {
    try {
      return fromResult(await workbench.testChat(match[1], body ?? {}, signal))
    } catch (error) {
      return fail(502, String(error?.message ?? error))
    }
  })
  route('POST', /^\/personas\/([a-z0-9]+)\/feedback$/, ({ match, body }) => fromResult(personas.addFeedback(match[1], body ?? {})))
  route('DELETE', /^\/personas\/([a-z0-9]+)\/feedback\/([a-z0-9]+)$/, ({ match }) => fromResult(personas.removeFeedback(match[1], match[2])))

  // ── 技能 ─────────────────────────────────────────────────────────
  const skillView = skill => ({ ...skill, exposedName: exposedName(skill.name) })
  route('GET', /^\/skills$/, () => {
    let eligible = 0
    try {
      eligible = workbench.eligibleSessions().length
    } catch {
      eligible = 0
    }
    return ok({
      skills: skills.list().map(skillView),
      mining: skills.state.mining,
      eligible,
      config: config.skills,
      runningJob: jobs.running().find(job => job.key === 'skills-mine') ?? null,
    })
  })
  route('POST', /^\/skills\/mine$/, () => fromResult(workbench.startMining({ auto: false })))
  route('PATCH', /^\/skills\/([a-z0-9-]+)$/, ({ match, body }) => {
    const result = skills.update(match[1], body ?? {})
    if (!result.ok) return fail(400, result.error)
    if (body?.visibility !== undefined || body?.status !== undefined) {
      policy.record({ type: 'skill', actor: 'console', action: 'update', skill: match[1], status: result.skill.status, visibility: result.skill.visibility })
    }
    return ok({ skill: skillView(result.skill) })
  })
  route('DELETE', /^\/skills\/([a-z0-9-]+)$/, ({ match }) => {
    const result = skills.remove(match[1])
    if (result.ok) policy.record({ type: 'skill', actor: 'console', action: 'delete', skill: match[1] })
    return fromResult(result)
  })

  // ── 后台任务 ─────────────────────────────────────────────────────
  route('GET', /^\/jobs$/, () => ok({ jobs: jobs.list() }))
  route('GET', /^\/jobs\/([a-f0-9]+)$/, ({ match }) => {
    const job = jobs.get(match[1])
    return job ? ok({ job }) : fail(404, '找不到这个任务')
  })
  route('POST', /^\/jobs\/([a-f0-9]+)\/cancel$/, ({ match }) => (jobs.cancel(match[1]) ? ok() : fail(409, '任务已经结束了')))

  return {
    async handle({ method, path, query, body, signal }) {
      let methodMismatch = false
      for (const item of routes) {
        const match = item.pattern.exec(path)
        if (!match) continue
        if (item.method !== method) {
          methodMismatch = true
          continue
        }
        try {
          return await item.handler({ match, query, body, signal })
        } catch (error) {
          deps.log?.error?.(`[console] ${method} ${path} 出错：${error?.message ?? error}`)
          return fail(500, String(error?.message ?? error))
        }
      }
      return methodMismatch ? fail(405, '不支持的方法') : fail(404, `没有这个接口：${method} ${path}`)
    },
  }
}
