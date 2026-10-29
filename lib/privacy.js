/**
 * 会话分级与权限策略（私人会话权限管理）。
 *
 * 做三件事：
 *   1. 给会话分类：自己的会话（owner）、子代理（subagent）、QQ 群（qq-group）、QQ 私聊（qq-private）。
 *      QQ 会话的唯一可靠标记是工作区目录名 `qq-<group|private>-<号>`（dsh-whale-inurqq 的命名，
 *      lib/dsh/bridge.js:186-201）；会话头里没有别的字段能区分。
 *   2. 按策略回答：这个会话能不能拿来学习画像、注入不注入画像、能看到哪些技能、工具权限等级。
 *   3. 工具门控：`ctx.tools.guard()` 在 DSH 工具管线里强制执行，不靠提示词约束模型。
 *
 * 策略只有两个写入口：本机网页控制台（只监听 127.0.0.1，令牌登录）与 DSH 自己
 * （插件配置，或经 DSH 登录校验的设置页）。模型没有任何工具能改它；受限等级的会话
 * 也读写不到策略文件所在的目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SESSION_CLASSES = ['owner', 'subagent', 'qq-group', 'qq-private']

/** 工具权限等级。`inherit` 只用于子代理：跟随父会话。 */
export const TIERS = ['full', 'safe', 'chat']

const QQ_DIR = /^qq-(group|private)-(\d{1,12})$/i
const CHAT_KEY = /^(group|private):(\d{1,12})$/
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
const MAX_NOTE = 200
const MAX_ENTRIES = 500

/** QQ 插件里只作用于"某个会话"的工具：受限会话只能对自己所在的会话用。 */
const QQ_CHAT_TOOLS = new Set(['qq_send', 'qq_history', 'qq_memory'])

/** 仅聊天：只能回话、查本会话的 QQ 记录、加载可共享的技能。 */
const CHAT_TOOLS = ['skill', 'todo_write', 'web_search', 'qq_alive', 'qq_tasks', 'qq_send', 'qq_history', 'qq_memory']

/** 受限：在仅聊天之外，可以读写自己工作区里的文件、抓网页。没有 shell、没有子代理。 */
const SAFE_TOOLS = [
  ...CHAT_TOOLS,
  'web_fetch', 'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'str_replace_editor',
  'ask_user_question', 'present', 'plan', 'get_goal', 'create_goal', 'update_goal',
]

/** 带路径参数的工具：参数名 → 受限等级下必须落在会话工作区内。 */
const PATH_ARGS = {
  read: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  read_image: ['file_path', 'path'],
  glob: ['path'],
  grep: ['path'],
  str_replace_editor: ['path'],
}

export const TIER_INFO = {
  full: { label: '完全', summary: '不加额外限制（权限由 DSH 的权限预设决定）。' },
  safe: {
    label: '受限',
    summary: '可以读写自己工作区里的文件、搜索和抓取网页；不能执行命令、不能派子代理、不能碰工作区以外的路径。',
  },
  chat: { label: '仅聊天', summary: '只能回话、查本会话的 QQ 记录、加载可共享的技能；其余工具一律拒绝。' },
}

export const CLASS_INFO = {
  owner: { label: '你自己的会话', hint: '在 DSH 里由你直接发起的会话。' },
  subagent: { label: '子代理', hint: '由其他会话派出的子会话，权限跟随父会话。' },
  'qq-group': { label: 'QQ 群', hint: '由 dsh-whale-inurqq 为 QQ 群建立的会话，群里任何人都能驱动它。' },
  'qq-private': { label: 'QQ 私聊', hint: '由 dsh-whale-inurqq 为 QQ 私聊建立的会话，对方能驱动它。' },
}

/**
 * 插件配置给出的默认值（DSH 设置页可改）。控制台里没有覆盖的项一律跟随它。
 * @param {object} [config] `config.privacy`
 */
export function defaultClassPolicy(config = {}) {
  const external = TIERS.includes(config.defaultExternalTier) ? config.defaultExternalTier : 'chat'
  return {
    owner: { tier: 'full', learn: true, injectProfile: true, skills: 'all' },
    subagent: { tier: 'inherit', learn: false, injectProfile: config.injectProfileIntoSubagents === true, skills: 'inherit' },
    'qq-group': { tier: external, learn: false, injectProfile: false, skills: 'shared' },
    'qq-private': { tier: external, learn: false, injectProfile: false, skills: 'shared' },
  }
}

export function emptyOverrides() {
  return { version: 1, classes: {}, chats: {}, sessions: {}, extraAllowedTools: { chat: [], safe: [] }, updatedAt: 0, updatedBy: null }
}

/**
 * 按会话头分类。`lookup(parentId)` 返回父会话的会话头（找不到返回 undefined），
 * 用来让子代理继承父会话的 QQ 身份：QQ 会话派出的子代理同样由 QQ 里的人驱动。
 * @param {{cwd?:string, origin?:string, parentSession?:string}} header
 * @param {(id:string)=>object|undefined} [lookup]
 * @returns {{kind:string, chatType?:string, chatId?:string, chatKey?:string, parentKind?:string, cwd:string|null}}
 */
export function classifySession(header, lookup) {
  const start = header ?? {}
  const cwd = typeof start.cwd === 'string' ? start.cwd : null
  const isChild = item => item.origin === 'subagent' || Boolean(item.parentSession)
  if (!isChild(start)) {
    const qq = qqChatOf(start.cwd)
    if (qq) return { kind: qq.chatType === 'group' ? 'qq-group' : 'qq-private', ...qq, cwd }
    return { kind: 'owner', cwd }
  }
  // 子代理：沿父会话往上找，直到碰到 QQ 工作区或一个不是子代理的根会话。
  let current = start
  const seen = new Set()
  for (let depth = 0; depth < 8; depth += 1) {
    const qq = qqChatOf(current.cwd)
    if (qq) return { kind: 'subagent', ...qq, parentKind: qq.chatType === 'group' ? 'qq-group' : 'qq-private', cwd }
    if (!isChild(current)) return { kind: 'subagent', parentKind: 'owner', cwd }
    const parentId = current.parentSession
    if (!parentId || seen.has(parentId) || typeof lookup !== 'function') break
    seen.add(parentId)
    const parent = lookup(parentId)
    if (!parent) break
    current = parent
  }
  // 找不到父会话时不能假定是你派的：按外部会话处理（fail closed）。
  return { kind: 'subagent', parentKind: 'unknown', cwd }
}

/** 工作区目录名 → QQ 会话；不是 QQ 工作区返回 null。 */
export function qqChatOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null
  const match = QQ_DIR.exec(path.basename(cwd.replace(/[\\/]+$/, '')))
  if (!match) return null
  const chatType = match[1].toLowerCase()
  return { chatType, chatId: match[2], chatKey: `${chatType}:${match[2]}` }
}

/**
 * 校验并规整控制台 / 设置页提交的覆盖项。只接受已知字段，未知字段丢弃；
 * 形状不对直接报错（不猜"最接近的合法值"——这是权限配置）。
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateOverrides(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '策略必须是对象' }
  const out = emptyOverrides()
  try {
    for (const [kind, raw] of Object.entries(input.classes ?? {})) {
      if (!SESSION_CLASSES.includes(kind)) throw new Error(`未知的会话类别：${kind}`)
      out.classes[kind] = pickRule(raw, kind === 'subagent')
    }
    const chats = Object.entries(input.chats ?? {})
    if (chats.length > MAX_ENTRIES) throw new Error(`QQ 会话覆盖最多 ${MAX_ENTRIES} 条`)
    for (const [key, raw] of chats) {
      if (!CHAT_KEY.test(key)) throw new Error(`QQ 会话键格式应为 group:<群号> 或 private:<QQ号>：${key}`)
      out.chats[key] = pickRule(raw, false)
    }
    const sessions = Object.entries(input.sessions ?? {})
    if (sessions.length > MAX_ENTRIES) throw new Error(`会话覆盖最多 ${MAX_ENTRIES} 条`)
    for (const [id, raw] of sessions) {
      if (!SESSION_ID.test(id)) throw new Error(`会话 id 格式不对：${id}`)
      const rule = pickRule(raw, false)
      if (raw && raw.private !== undefined) {
        if (typeof raw.private !== 'boolean') throw new Error('private 必须是布尔值')
        rule.private = raw.private
      }
      out.sessions[id] = rule
    }
    for (const tier of ['chat', 'safe']) {
      const list = input.extraAllowedTools?.[tier] ?? []
      if (!Array.isArray(list) || list.length > 50) throw new Error(`extraAllowedTools.${tier} 必须是不超过 50 项的数组`)
      out.extraAllowedTools[tier] = [...new Set(list.map(name => {
        if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw new Error(`工具名格式不对：${name}`)
        return name
      }))]
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  return { ok: true, value: out }
}

function pickRule(raw, allowInherit) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('每条规则必须是对象')
  const rule = {}
  if (raw.tier !== undefined && raw.tier !== null) {
    const ok = TIERS.includes(raw.tier) || (allowInherit && raw.tier === 'inherit')
    if (!ok) throw new Error(`未知的权限等级：${raw.tier}`)
    rule.tier = raw.tier
  }
  for (const key of ['learn', 'injectProfile']) {
    if (raw[key] === undefined || raw[key] === null) continue
    if (typeof raw[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
    rule[key] = raw[key]
  }
  if (raw.skills !== undefined && raw.skills !== null) {
    const allowed = allowInherit ? ['all', 'shared', 'none', 'inherit'] : ['all', 'shared', 'none']
    if (!allowed.includes(raw.skills)) throw new Error(`未知的技能可见范围：${raw.skills}`)
    rule.skills = raw.skills
  }
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== 'string') throw new Error('note 必须是字符串')
    rule.note = raw.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE)
  }
  return rule
}

/** `target` 是否落在 `root` 之内（含 root 本身）。Windows 上不区分大小写。 */
export function isWithin(root, target) {
  if (!root || !target) return false
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value)
  const relative = path.relative(fold(path.resolve(root)), fold(path.resolve(target)))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const AUDIT_FILE_MAX = 512 * 1024
const AUDIT_MEMORY_MAX = 500
const DENIAL_LOG_INTERVAL_MS = 60_000

/**
 * 策略仓库 + 工具门控 + 审计。
 *
 * 覆盖项落在 `<dir>/privacy.json`，审计落在 `<dir>/audit.jsonl`。写入只经 `update()`，
 * 调用方必须声明来源（`console` / `dsh-settings`），来源会写进审计。
 */
export class PrivacyPolicy {
  /**
   * @param {object} opts
   * @param {string} opts.dir 状态目录
   * @param {object} [opts.config] `config.privacy`
   * @param {string[]} [opts.protectedRoots] 受限会话一律碰不到的目录（DSH_HOME、状态目录）
   * @param {object} [opts.log]
   */
  constructor({ dir, config = {}, protectedRoots = [], log } = {}) {
    this.dir = dir
    this.file = path.join(dir, 'privacy.json')
    this.auditFile = path.join(dir, 'audit.jsonl')
    this.config = config
    this.protectedRoots = protectedRoots.filter(Boolean)
    this.log = log
    this.overrides = emptyOverrides()
    this.headers = new Map()
    this.ruleCache = new Map()
    this.audit = []
    this.lastDenialLog = new Map()
    this.listeners = new Set()
    this.#load()
  }

  get enforcing() {
    return this.config.enforceTools !== false
  }

  #load() {
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // 读不懂的策略文件不能静默当成"没有覆盖项"：那会把用户收紧过的权限放宽。
      // 留档后按默认值（默认值本身就是收紧的）继续。
      const kept = `${this.file}.corrupt-${Date.now()}`
      try {
        fs.renameSync(this.file, kept)
      } catch {
        /* 留档失败也不影响按默认值运行 */
      }
      this.log?.warn(`[privacy] 策略文件无法解析，已按默认策略运行：${error?.message ?? error}`)
      return
    }
    const checked = validateOverrides(parsed)
    if (!checked.ok) {
      this.log?.warn(`[privacy] 策略文件内容不合法，已按默认策略运行：${checked.error}`)
      return
    }
    this.overrides = {
      ...checked.value,
      updatedAt: Number(parsed.updatedAt) || 0,
      updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null,
    }
  }

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 写入覆盖项。`actor` 只接受两个来源：本机控制台与 DSH 设置页。
   * @returns {{ok:true, overrides:object} | {ok:false, error:string}}
   */
  update(next, actor) {
    if (actor !== 'console' && actor !== 'dsh-settings') {
      return { ok: false, error: '权限策略只能在本机网页控制台或 DSH 设置页里修改' }
    }
    const checked = validateOverrides(next)
    if (!checked.ok) return checked
    const before = this.overrides
    const value = { ...checked.value, updatedAt: Date.now(), updatedBy: actor }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      return { ok: false, error: `保存失败：${error?.message ?? error}` }
    }
    this.overrides = value
    this.ruleCache.clear()
    this.record({ type: 'policy', actor, changes: describeChanges(before, value) })
    for (const listener of this.listeners) {
      try {
        listener(value)
      } catch {
        /* 监听器的错误不影响策略生效 */
      }
    }
    return { ok: true, overrides: value }
  }

  /** 本地表里没有的父会话，交给它去问宿主（`ctx.agents.get(id)?.session.header`）。 */
  setHeaderResolver(resolve) {
    this.resolveHeader = typeof resolve === 'function' ? resolve : null
  }

  #lookup(id) {
    const known = this.headers.get(id)
    if (known) return known
    try {
      const live = this.resolveHeader?.(id)
      if (live?.id) {
        this.rememberHeader(live)
        return this.headers.get(id)
      }
    } catch {
      /* 宿主查不到就当未知父会话 */
    }
    return undefined
  }

  /** 记住会话头（`session/created` 与扫描到的日志都会喂进来），给子代理找父会话用。 */
  rememberHeader(header) {
    if (!header?.id) return
    const previous = this.headers.get(header.id)
    if (previous && previous.cwd === header.cwd && previous.parentSession === header.parentSession) return
    this.headers.set(header.id, {
      id: header.id,
      cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
      origin: header.origin,
      parentSession: header.parentSession,
      createdAt: header.createdAt,
    })
    this.ruleCache.delete(header.id)
  }

  classify(header) {
    return classifySession(header, id => this.#lookup(id))
  }

  /**
   * 一个会话的生效规则。优先级：会话覆盖 > QQ 会话覆盖 > 类别覆盖 > 插件配置默认值。
   * 子代理的 `inherit` 取父会话那一类（QQ 子代理带着 QQ 会话的覆盖项）。
   */
  ruleFor(header) {
    const id = header?.id
    if (id && this.ruleCache.has(id)) return this.ruleCache.get(id)
    if (header?.id) this.rememberHeader(header)
    const info = this.classify(header ?? {})
    const rule = this.#resolve(info, id)
    // 父会话暂时未知的结果不缓存：父会话头一到就要重新判。
    if (id && info.parentKind !== 'unknown') this.ruleCache.set(id, rule)
    return rule
  }

  #resolve(info, sessionId) {
    const defaults = defaultClassPolicy(this.config)
    const layer = (kind, chatKey) => {
      const merged = { ...defaults[kind], ...(this.overrides.classes[kind] ?? {}) }
      if (chatKey && (kind === 'qq-group' || kind === 'qq-private')) Object.assign(merged, this.overrides.chats[chatKey] ?? {})
      return merged
    }
    let rule = layer(info.kind, info.chatKey)
    if (info.kind === 'subagent') {
      // 父会话未知时按 QQ 私聊（外部会话）那一层处理。
      const parentKind = info.parentKind === 'unknown' ? 'qq-private' : (info.parentKind ?? 'owner')
      const parent = layer(parentKind, info.chatKey)
      if (rule.tier === 'inherit') rule.tier = parent.tier
      if (rule.skills === 'inherit') rule.skills = parent.skills
      // QQ 会话派出的子代理不许比父会话权限更大：取两者中更严的那个。
      if (parentKind !== 'owner') {
        rule.tier = stricter(rule.tier, parent.tier)
        rule.skills = narrower(rule.skills, parent.skills)
        rule.injectProfile = rule.injectProfile === true && parent.injectProfile === true
      }
    }
    const sessionOverride = sessionId ? this.overrides.sessions[sessionId] : undefined
    if (sessionOverride) rule = { ...rule, ...sessionOverride }
    if (rule.tier === 'inherit') rule.tier = 'full'
    if (rule.skills === 'inherit') rule.skills = 'all'
    return {
      kind: info.kind,
      parentKind: info.parentKind ?? null,
      chatKey: info.chatKey ?? null,
      cwd: info.cwd ?? null,
      tier: rule.tier,
      learn: rule.learn === true && sessionOverride?.private !== true,
      injectProfile: rule.injectProfile === true,
      skills: rule.skills,
      private: sessionOverride?.private === true,
    }
  }

  /** 这个会话的真人发言能不能拿来学习画像 / 整理技能。 */
  canLearn(header) {
    return this.ruleFor(header).learn
  }

  /**
   * `ctx.tools.guard()` 的判据。返回拒绝理由（模型能看到），放行返回 undefined。
   * 只读 `exec.agent.session.header`、工具名与参数；同步、无 IO（审计写盘失败也不影响判定）。
   */
  guard(exec) {
    if (!this.enforcing) return undefined
    const header = exec?.agent?.session?.header
    if (!header) return undefined
    const rule = this.ruleFor(header)
    if (rule.tier === 'full') return undefined
    const reason = this.#denial(rule, String(exec.name ?? ''), exec.arguments ?? {})
    if (reason) this.#recordDenial(header.id, rule, exec.name, reason)
    return reason
  }

  #denial(rule, name, args) {
    const extra = this.overrides.extraAllowedTools?.[rule.tier] ?? []
    const allowed = new Set([...(rule.tier === 'chat' ? CHAT_TOOLS : SAFE_TOOLS), ...extra])
    const label = TIER_INFO[rule.tier]?.label ?? rule.tier
    const prefix = `这个会话的权限等级是「${label}」（由本机控制台管理）`
    if (!allowed.has(name)) return `${prefix}，不能使用 ${name}。`
    if (QQ_CHAT_TOOLS.has(name)) {
      if (!rule.chatKey) return `${prefix}，不是 QQ 会话，不能使用 ${name}。`
      const target = `${args.chat_type === 'group' ? 'group' : 'private'}:${String(args.chat_id ?? '')}`
      if (target !== rule.chatKey) return `${prefix}，${name} 只能用于本会话所在的 QQ 会话。`
      // 仅聊天等级下，群里任何人都能驱动这个会话：只许查看和新增记忆，不许删除或改钉住状态。
      if (name === 'qq_memory' && rule.tier === 'chat' && (args.forget !== undefined || args.pin !== undefined || args.unpin !== undefined)) {
        return `${prefix}，不能删除或钉住会话记忆。`
      }
    }
    if (name === 'qq_tasks' && args.cancel_task_id !== undefined) return `${prefix}，不能取消任务。`
    if (name === 'web_fetch') {
      // 宿主进程发出的请求在本机看来来自 127.0.0.1：放行就等于让外部会话读本机接口（包括画像）。
      const problem = urlProblem(args.url)
      if (problem) return `${prefix}，${problem}`
    }
    const keys = PATH_ARGS[name]
    if (keys && rule.tier === 'safe') {
      for (const key of keys) {
        const value = args[key]
        if (value === undefined || value === null || value === '') continue
        const problem = this.#pathProblem(rule.cwd, String(value))
        if (problem) return `${prefix}，${problem}`
      }
    }
    return undefined
  }

  #pathProblem(cwd, value) {
    if (!cwd) return '没有工作区，不能访问文件。'
    if (value.startsWith('~') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return `不能访问 ${value}。`
    const resolved = path.resolve(cwd, value)
    if (!isWithin(cwd, resolved)) return `只能访问自己工作区（${cwd}）里的文件。`
    for (const root of this.protectedRoots) {
      // 工作区本身就在受保护目录里面（例如 QQ 工作区放在 DSH_HOME 下）时，这一层不算：
      // 目标已经被限制在工作区之内，其余更具体的受保护目录（会话日志、状态目录）照常检查。
      if (isWithin(root, cwd)) continue
      if (isWithin(root, resolved)) return '这个位置受保护。'
    }
    return undefined
  }

  #recordDenial(sessionId, rule, tool, reason) {
    const key = `${sessionId}|${tool}`
    const now = Date.now()
    const last = this.lastDenialLog.get(key)
    if (last && now - last.at < DENIAL_LOG_INTERVAL_MS) {
      last.suppressed += 1
      return
    }
    this.lastDenialLog.set(key, { at: now, suppressed: 0 })
    if (this.lastDenialLog.size > 2000) this.lastDenialLog.clear()
    this.record({
      type: 'deny',
      sessionId,
      kind: rule.kind,
      chatKey: rule.chatKey,
      tier: rule.tier,
      tool,
      reason,
      suppressedBefore: last?.suppressed ?? 0,
    })
  }

  /** 追加一条审计。内存留最近 500 条，文件超过 512 KB 轮转一次。 */
  record(entry) {
    const item = { at: Date.now(), ...entry }
    this.audit.push(item)
    if (this.audit.length > AUDIT_MEMORY_MAX) this.audit.splice(0, this.audit.length - AUDIT_MEMORY_MAX)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      try {
        if (fs.statSync(this.auditFile).size > AUDIT_FILE_MAX) fs.renameSync(this.auditFile, `${this.auditFile}.1`)
      } catch {
        /* 文件还不存在 */
      }
      fs.appendFileSync(this.auditFile, `${JSON.stringify(item)}\n`, 'utf8')
    } catch (error) {
      this.log?.warn(`[privacy] 审计写盘失败：${error?.message ?? error}`)
    }
    return item
  }

  /** 最近的审计记录（新的在前）。内存里不够时从文件补。 */
  recentAudit(limit = 100) {
    const wanted = Math.max(1, Math.min(500, Number(limit) || 100))
    if (this.audit.length >= wanted) return this.audit.slice(-wanted).reverse()
    let fromFile = []
    try {
      fromFile = fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).slice(-wanted).map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean)
    } catch {
      /* 还没有审计文件 */
    }
    const seen = new Set(this.audit.map(item => `${item.at}|${item.type}|${item.tool ?? ''}`))
    const merged = [...fromFile.filter(item => !seen.has(`${item.at}|${item.type}|${item.tool ?? ''}`)), ...this.audit]
    return merged.slice(-wanted).reverse()
  }

  /** 给控制台的完整视图。 */
  describe() {
    const defaults = defaultClassPolicy(this.config)
    const effective = {}
    for (const kind of SESSION_CLASSES) {
      effective[kind] = this.#resolve(kind === 'subagent' ? { kind, parentKind: 'owner' } : { kind }, undefined)
    }
    return {
      enforcing: this.enforcing,
      defaults,
      overrides: this.overrides,
      effective,
      tiers: TIER_INFO,
      classes: CLASS_INFO,
      allowedTools: { chat: CHAT_TOOLS, safe: SAFE_TOOLS },
    }
  }
}

function stricter(a, b) {
  const rank = { chat: 0, safe: 1, full: 2 }
  return (rank[a] ?? 0) <= (rank[b] ?? 0) ? a : b
}

/** 只允许抓公网 http(s)；本机、内网、链路本地地址一律不行。 */
export function urlProblem(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch {
    return '网址无法解析。'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只能抓取 http/https 网址。'
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return '不能访问本机或内网地址。'
  }
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return '不能访问本机或内网地址。'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) {
      return '不能访问本机或内网地址。'
    }
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')) {
      return '不能访问本机或内网地址。'
    }
  }
  return undefined
}

function narrower(a, b) {
  const rank = { none: 0, shared: 1, all: 2 }
  return (rank[a] ?? 0) <= (rank[b] ?? 0) ? a : b
}

/** 审计用的变化摘要：只列哪些键变了，不重复整份策略。 */
function describeChanges(before, after) {
  const changes = []
  for (const group of ['classes', 'chats', 'sessions']) {
    const keys = new Set([...Object.keys(before[group] ?? {}), ...Object.keys(after[group] ?? {})])
    for (const key of keys) {
      const a = JSON.stringify(before[group]?.[key] ?? null)
      const b = JSON.stringify(after[group]?.[key] ?? null)
      if (a !== b) changes.push({ group, key, before: before[group]?.[key] ?? null, after: after[group]?.[key] ?? null })
    }
  }
  for (const tier of ['chat', 'safe']) {
    const a = JSON.stringify(before.extraAllowedTools?.[tier] ?? [])
    const b = JSON.stringify(after.extraAllowedTools?.[tier] ?? [])
    if (a !== b) changes.push({ group: 'extraAllowedTools', key: tier, before: JSON.parse(a), after: JSON.parse(b) })
  }
  return changes
}

/**
 * dsh-whale-inurqq 投递的消息都以 `[来自 QQ 群 …，发言人 …]` / `[来自 QQ 私聊，发言人 …]` 开头
 * （lib/dsh/bridge.js:381-387），说话的是 QQ 里的人，不是你。会话被误判成你自己的会话时
 * （比如工作区目录被改过名），这一层仍能把它们挡在画像材料之外。
 */
export function isRelayedQqText(text) {
  return typeof text === 'string' && /^\s*\[来自 QQ (群 \d+|私聊)，发言人 /.test(text)
}

function firstText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const block = content.find(item => item?.type === 'text' && typeof item.text === 'string')
  return block?.text ?? ''
}

/**
 * 从学习材料里去掉 QQ 转来的发言。只作用于**不是** QQ 会话的会话：QQ 会话能走到这里，
 * 说明你在权限策略里明确允许了它参与学习（比如你自己用手机 QQ 私聊机器人），那就照常保留。
 * 返回新的 Map，事件对象不复制、不修改。
 * @param {Map<string, object[]>} sessions
 * @param {(sessionId:string)=>boolean} isQqSession
 */
export function dropRelayedQqMessages(sessions, isQqSession) {
  const out = new Map()
  for (const [id, events] of sessions) {
    if (isQqSession(id)) {
      out.set(id, events)
      continue
    }
    out.set(id, events.filter(event => !(event.type === 'user/message' && isRelayedQqText(firstText(event.message)))))
  }
  return out
}

/** 默认受保护的目录：DSH 主目录（会话日志、凭据、各插件状态都在里面）、会话日志、本插件状态目录。 */
export function defaultProtectedRoots(dshHome, stateDir, sessionsRoot) {
  return [dshHome || path.join(os.homedir(), '.dsh'), sessionsRoot, stateDir].filter(Boolean)
}
