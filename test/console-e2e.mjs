/**
 * 控制台、私人会话权限、人格、技能的端到端测试。
 *
 * 在临时 DSH_HOME 下合成会话日志（3 个你自己的会话、1 个 QQ 群、1 个 QQ 私聊、1 个 QQ 群派出的子代理）
 * 和一份 QQ 群语料，用假的 llm / tools / skills / connection 服务跑真实的 apply()、真实的控制台
 * HTTP 服务。不碰用户的 ~/.dsh，不调用真实模型。
 *
 * 运行：node test/console-e2e.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { buildWorld, consoleClient, agentFor, OWNER_LINES, QQ_GROUP, QQ_GROUP_LINE } from './fixtures/console-world.mjs'

delete process.env.DSH_PROMPT_ADAPT_CONSOLE
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-console-e2e-'))

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function heading(text) {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`)
}

/** 直接发 HTTP 请求（fetch 改不了 Host / Origin / sec-fetch-* 这些头）。 */
function raw(base, { method = 'GET', path: target, headers = {}, body }) {
  const url = new URL(target, base)
  const payload = body === undefined ? null : Buffer.from(body, 'utf8')
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method,
      path: url.pathname + url.search,
      headers: { ...(payload ? { 'content-length': payload.length } : {}), ...headers },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(payload ?? undefined)
  })
}

const world = await buildWorld({ home })
const { service, headers } = world
const base = world.consoleUrl
const port = Number(new URL(base).port)

heading('A. 启动：控制台、两个提示段、工具门控、技能来源')
{
  check('控制台在 127.0.0.1 上启动', /^http:\/\/127\.0\.0\.1:\d+$/.test(base ?? ''), String(base))
  check('登录密钥文件存在且不为空', fs.existsSync(world.keyFile) && fs.readFileSync(world.keyFile, 'utf8').trim().length >= 32)
  check('注册了画像段与人格段', Boolean(world.section('dsh-prompt-adapt:effective-profile')) && Boolean(world.section('dsh-prompt-adapt:persona')))
  await world.waitFor(() => world.guards.length > 0 && world.skillProviders.length > 0, 5000)
  check('工具门控挂上了（一次）', world.guards.length === 1, `${world.guards.length} 个`)
  check('技能来源登记了（一次）', world.skillProviders.length === 1, `${world.skillProviders.length} 个`)
  const scanned = await world.waitFor(() => service.getState().lastSignals != null)
  check('首轮扫描完成', scanned)
}

heading('B. 学习只用你自己的会话')
{
  const totals = service.getState().lastSignals?.totals ?? {}
  check('真人发言只数你自己的 3 个会话（每个 6 条）', totals.humanMessages === OWNER_LINES.length * 3, JSON.stringify(totals))
  check('会话数是 3（QQ 群、QQ 私聊、子代理都不算）', totals.sessions === 3, String(totals.sessions))
  const result = await service.regenerateNow()
  check('画像生成成功', result?.ok === true, result?.error ?? '')
  const call = world.llm.calls.find(item => item.kind === 'profile')
  check('生成提示词里没有 QQ 群里别人说的话', call && !call.prompt.includes('/etc/passwd') && !call.prompt.includes('来自 QQ'))
  check('生成提示词里有你自己的话（JSON 字符串形式）', call?.prompt.includes(JSON.stringify(OWNER_LINES[0])))
  const ids = (result.profile?.entries ?? []).map(entry => entry.id)
  check('新条目的 id 由插件分配（不是模型写的 new-1）', ids.length === 4 && ids.every(id => /^n\d+$/.test(id)), ids.join(','))
}

heading('C. 注入只进你自己的会话')
{
  const profileSection = world.section('dsh-prompt-adapt:effective-profile')
  const ownerText = profileSection.text({ agent: agentFor(headers.owner) })
  check('你自己的会话拿到画像', ownerText.includes('关于这个用户') && ownerText.includes('不要顺手重构'))
  check('标题写的是"推测"，不是"已经确认"', ownerText.includes('推测') && !ownerText.includes('已经确认'))
  check('QQ 群会话拿不到画像', profileSection.text({ agent: agentFor(headers.group) }) === '')
  check('QQ 私聊会话拿不到画像', profileSection.text({ agent: agentFor(headers.friend) }) === '')
  check('QQ 群派出的子代理拿不到画像', profileSection.text({ agent: agentFor(headers.subagent) }) === '')
  check('诊断类组装（没有 agent）照旧', profileSection.text({}) === ownerText)
  service.setMode('custom')
  service.setCustomText('我的私人系统提示：家里的 Wi-Fi 密码别告诉别人')
  check('模式 2 的自定义文本同样不进 QQ 会话', profileSection.text({ agent: agentFor(headers.group) }) === '')
  check('模式 2 的自定义文本进你自己的会话', profileSection.text({ agent: agentFor(headers.owner) }).includes('我的私人系统提示'))
  service.setMode('auto')
}

heading('D. 工具门控')
{
  const guard = world.guards[0]
  const run = (header, name, args = {}) => guard({ agent: agentFor(header), name, arguments: args })
  check('你自己的会话不受限', run(headers.owner, 'bash', { command: 'ls' }) === undefined)
  check('QQ 群会话不能用 bash', typeof run(headers.group, 'bash', { command: 'ls' }) === 'string')
  check('QQ 群会话不能读文件（仅聊天）', typeof run(headers.group, 'read', { file_path: 'a.txt' }) === 'string')
  check('QQ 群会话能往本群发消息', run(headers.group, 'qq_send', { chat_type: 'group', chat_id: QQ_GROUP, text: 'hi' }) === undefined)
  check('QQ 群会话不能往别的群发消息', typeof run(headers.group, 'qq_send', { chat_type: 'group', chat_id: '999', text: 'hi' }) === 'string')
  check('QQ 群会话不能清空记忆', typeof run(headers.group, 'qq_memory', { chat_type: 'group', chat_id: QQ_GROUP, forget: 'all' }) === 'string')
  check('QQ 群派出的子代理同样受限', typeof run(headers.subagent, 'bash', { command: 'ls' }) === 'string')
  check('没有 agent 的调用不拦（宿主内部调用）', guard({ name: 'bash', arguments: {} }) === undefined)
}

const client = consoleClient(base)

heading('E. 控制台登录与请求校验')
{
  const page = await client.request('GET', '/')
  check('没登录访问首页 → 跳到登录页', page.status === 303 && page.headers.get('location') === '/login')
  check('没登录调接口 → 401', (await client.api('GET', '/overview')).status === 401)
  const loginPage = await client.request('GET', '/login')
  check('登录页可以打开，带 CSP', loginPage.status === 200 && /script-src 'self'/.test(loginPage.headers.get('content-security-policy') ?? ''))
  check('登录页显示密钥文件的位置', loginPage.text.includes('console-key'))
  check('GET 带 key 参数不能登录（只接受表单提交）', (await client.request('GET', '/login?key=whatever')).status === 200 && !client.cookie)
  check('错误的密钥 → 401', (await client.loginWithKey('wrong-key')).status === 401 && !client.cookie)
  const key = fs.readFileSync(world.keyFile, 'utf8').trim()
  const login = await client.loginWithKey(key)
  check('正确的密钥 → 303 + 会话 cookie', login.status === 303 && client.cookie.startsWith('pa_console='))
  check('cookie 是 HttpOnly + SameSite=Strict', /HttpOnly/.test(login.headers.get('set-cookie')) && /SameSite=Strict/.test(login.headers.get('set-cookie')))
  check('登录后首页 200', (await client.request('GET', '/')).status === 200)
  check('页面脚本能取到', (await client.request('GET', '/page-privacy.js')).status === 200)
  check('不存在的文件 → 404', (await client.request('GET', '/nope.js')).status === 404)
  check('路径里带 .. 拿不到 lib 下的文件', (await client.request('GET', '/../console-server.js')).status !== 200)

  const cookieHeader = { cookie: client.cookie }
  const badHost = await raw(base, { path: '/api/overview', headers: { ...cookieHeader, host: `attacker.example:${port}` } })
  check('Host 不是本机 → 403（挡 DNS rebinding）', badHost.status === 403)
  const crossSite = await raw(base, { path: '/api/overview', headers: { ...cookieHeader, host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' } })
  check('跨站请求 → 403', crossSite.status === 403)
  const csrf = await client.refreshCsrf()
  const noCsrf = await raw(base, { method: 'PUT', path: '/api/privacy', headers: { ...cookieHeader, host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{"overrides":{}}' })
  check('写操作缺 CSRF 头 → 403', noCsrf.status === 403)
  const badOrigin = await raw(base, { method: 'PUT', path: '/api/privacy', headers: { ...cookieHeader, host: `127.0.0.1:${port}`, origin: 'http://evil.example', 'x-pa-csrf': csrf, 'content-type': 'application/json' }, body: '{"overrides":{}}' })
  check('写操作 Origin 不一致 → 403', badOrigin.status === 403)
  const textPlain = await raw(base, { method: 'PUT', path: '/api/privacy', headers: { ...cookieHeader, host: `127.0.0.1:${port}`, 'x-pa-csrf': csrf, 'content-type': 'text/plain' }, body: '{"overrides":{}}' })
  check('写操作不是 JSON → 415', textPlain.status === 415)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitJob(c, id) {
  for (let index = 0; index < 300; index += 1) {
    const result = await c.api('GET', `/jobs/${id}`)
    if (result.json?.job && result.json.job.status !== 'running') return result.json.job
    await sleep(50)
  }
  return null
}

heading('F. 控制台改权限：立即生效，并写审计')
{
  const before = await client.api('GET', '/privacy')
  check('GET /privacy 返回生效规则与会话列表',
    before.status === 200 && before.json.policy.effective['qq-group'].tier === 'chat' && before.json.sessions.length >= 6,
    `status=${before.status} sessions=${before.json?.sessions?.length}`)
  const kinds = Object.fromEntries((before.json?.sessions ?? []).map(row => [row.id, row.kind]))
  check('会话分类：你自己的 / QQ 群 / QQ 私聊 / 子代理',
    kinds['owner-a'] === 'owner' && kinds['qq-group-sess'] === 'qq-group' && kinds['qq-private-sess'] === 'qq-private' && kinds['sub-of-qq'] === 'subagent',
    JSON.stringify(kinds))
  const put = await client.api('PUT', '/privacy', { overrides: { classes: { 'qq-group': { tier: 'safe' } }, sessions: { 'owner-b': { private: true } } } })
  check('PUT /privacy 成功', put.status === 200 && put.json?.policy?.effective?.['qq-group']?.tier === 'safe', put.text.slice(0, 200))
  const guard = world.guards[0]
  check('改成「受限」后，QQ 群能读自己工作区里的文件',
    guard({ agent: agentFor(headers.group), name: 'read', arguments: { file_path: 'notes.md' } }) === undefined)
  check('但仍不能读工作区以外的文件',
    typeof guard({ agent: agentFor(headers.group), name: 'read', arguments: { file_path: path.join(home, 'prompt-adapt', 'state.json') } }) === 'string')
  check('也仍不能用 bash', typeof guard({ agent: agentFor(headers.group), name: 'bash', arguments: { command: 'ls' } }) === 'string')
  const invalid = await client.api('PUT', '/privacy', { overrides: { classes: { 'qq-group': { tier: 'root' } } } })
  check('非法的权限等级被拒（400），原设置不变', invalid.status === 400 && service.getPrivacy().effective['qq-group'].tier === 'safe', invalid.text.slice(0, 120))
  check('模型那一侧的调用者改不了策略', service.updatePrivacy({}, 'model').ok === false)
  const audit = await client.api('GET', '/audit')
  check('审计里有这次修改，来源是本机控制台', audit.json.items.some(item => item.type === 'policy' && item.actor === 'console'))
  check('审计里有被拦下的工具调用', audit.json.items.some(item => item.type === 'deny' && item.tool === 'bash'))
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'prompt-adapt', 'privacy.json'), 'utf8'))
  check('策略落盘到 privacy.json', saved.classes['qq-group'].tier === 'safe' && saved.updatedBy === 'console')
  await service.rescanNow()
  const totals = service.getState().lastSignals?.totals ?? {}
  check('标成私密的会话不再参与学习', totals.sessions === 2 && totals.humanMessages === OWNER_LINES.length * 2, JSON.stringify(totals))
}

heading('G. DSH 设置页的接口：要 DSH 自己的登录')
{
  const hostPath = p => `${new URL(world.hostBase).pathname}${p}`
  const dsh = { 'x-test-dsh-auth': 'ok' }
  const noAuth = await raw(world.hostBase, { path: hostPath('/state') })
  check('没有 DSH 登录 → 401', noAuth.status === 401, `status=${noAuth.status}`)
  const state = await raw(world.hostBase, { path: hostPath('/state'), headers: dsh })
  const json = JSON.parse(state.text)
  check('有 DSH 登录 → 200，带权限摘要与控制台地址',
    state.status === 200 && json.privacy?.classes?.['qq-group']?.tier === 'safe' && json.console?.url === base,
    `status=${state.status}`)
  check('/state 里没有登录密钥的位置', !state.text.includes('console-key'))
  const body = JSON.stringify({ overrides: { classes: { 'qq-group': { tier: 'safe' }, 'qq-private': { tier: 'safe' } }, sessions: { 'owner-b': { private: true } } } })
  const unauthorized = await raw(world.hostBase, { method: 'PUT', path: hostPath('/privacy'), headers: { 'content-type': 'application/json' }, body })
  check('没有 DSH 登录改不了权限', unauthorized.status === 401 && service.getPrivacy().effective['qq-private'].tier === 'chat')
  const authorized = await raw(world.hostBase, { method: 'PUT', path: hostPath('/privacy'), headers: { ...dsh, 'content-type': 'application/json' }, body })
  check('经 DSH 登录的设置页能改权限', authorized.status === 200 && service.getPrivacy().effective['qq-private'].tier === 'safe', authorized.text.slice(0, 160))
  const audit = await client.api('GET', '/audit')
  check('审计记下来源是 DSH 设置页', audit.json.items.some(item => item.type === 'policy' && item.actor === 'dsh-settings'))

  const ticket = await raw(world.hostBase, { method: 'POST', path: hostPath('/console/ticket'), headers: dsh })
  const ticketJson = JSON.parse(ticket.text)
  check('DSH 设置页能拿到一次性控制台链接', ticket.status === 200 && /\/login\?ticket=/.test(ticketJson.url ?? ''), ticket.text.slice(0, 160))
  const noAuthTicket = await raw(world.hostBase, { method: 'POST', path: hostPath('/console/ticket') })
  check('没有 DSH 登录拿不到票据', noAuthTicket.status === 401)
  const visitor = consoleClient(base)
  const ticketPath = new URL(ticketJson.url).pathname + new URL(ticketJson.url).search
  const enter = await visitor.request('GET', ticketPath)
  check('用票据登录：先落到本站页面再跳转（SameSite=Strict 的 cookie 才会带上）',
    enter.status === 200 && enter.text.includes('http-equiv="refresh"') && visitor.cookie.startsWith('pa_console='))
  const me = await visitor.request('GET', '/api/me')
  check('票据登录后能用控制台，来源记为 DSH 设置页', me.status === 200 && me.json.via === 'dsh-settings')
  const reuse = await consoleClient(base).request('GET', ticketPath)
  check('票据只能用一次', reuse.status === 401)
}

heading('H. 人格：模仿群友、试聊、按反馈修订、只注入绑定的会话')
{
  const chats = await client.api('GET', '/qq/chats')
  check('QQ 语料库里能看到这个群', chats.json.chats.some(chat => chat.key === `group:${QQ_GROUP}`), JSON.stringify(chats.json.chats))
  const members = await client.api('GET', `/qq/members?chat=group:${QQ_GROUP}&days=30`)
  const xiaoming = members.json.members.find(member => member.senderId === '10001')
  check('群成员按发言数排序，小明在里面', xiaoming && xiaoming.messages >= 6 && members.json.members[0].messages >= members.json.members.at(-1).messages, JSON.stringify(members.json.members.map(m => [m.names[0], m.messages])))
  check('合并转发里的人也算（只有名字）', members.json.members.some(member => member.memberId === 'name:路人甲'))
  const source = { chatType: 'group', chatId: QQ_GROUP, memberId: '10001', memberName: '小明', days: 30 }
  const noConsent = await client.api('POST', '/personas', { name: '小明风格', kind: 'member', source })
  check('没确认征得同意 → 400', noConsent.status === 400 && /同意/.test(noConsent.json?.error ?? ''))
  const created = await client.api('POST', '/personas', { name: '小明风格', kind: 'member', source, consent: true })
  check('创建成功', created.status === 200 && created.json.persona?.id, created.text.slice(0, 160))
  const id = created.json.persona.id
  const generate = await client.api('POST', `/personas/${id}/generate`)
  const generated = await waitJob(client, generate.json?.job?.id)
  check('生成任务完成，得到 v1', generated?.status === 'done' && generated.result?.version === 1, JSON.stringify(generated))
  const generatePrompt = world.llm.calls.find(call => call.kind === 'persona-generate')?.prompt ?? ''
  check('生成提示词用的是小明的发言', generatePrompt.includes('哈哈哈哈笑死') && generatePrompt.includes('离谱'))
  check('生成提示词去掉了 QQ 插件的分诊尾巴', !generatePrompt.includes('[分诊'))
  const enabled = await client.api('PATCH', `/personas/${id}`, { enabled: true, bindings: [{ kind: 'chat', key: `group:${QQ_GROUP}` }] })
  check('启用并绑定到这个群', enabled.status === 200 && enabled.json.persona.enabled === true)
  const personaSection = world.section('dsh-prompt-adapt:persona')
  const groupText = personaSection.text({ agent: agentFor(headers.group) })
  check('这个群的会话拿到人格段', groupText.includes('说话风格：小明风格') && groupText.includes('爱用感叹号'))
  check('人格段写明不冒充本人、不编造经历', groupText.includes('你不是小明本人') && groupText.includes('不要编造'))
  check('同一个版本两次渲染结果相同', personaSection.text({ agent: agentFor(headers.group) }) === groupText)
  check('你自己的会话没有绑定，拿不到人格段', personaSection.text({ agent: agentFor(headers.owner) }) === '')
  check('子代理不注入人格', personaSection.text({ agent: agentFor(headers.subagent) }) === '')
  const reply = await client.api('POST', `/personas/${id}/test`, { message: '电脑开不了机怎么办', history: [] })
  check('试聊有回复', reply.status === 200 && reply.json.reply.includes('哈哈哈'), reply.text.slice(0, 160))
  const testCall = world.llm.calls.findLast(call => call.kind === 'persona-test')
  check('试聊用的 system 就是会被注入的人格文本', testCall?.system?.startsWith(groupText))
  const feedback = await client.api('POST', `/personas/${id}/feedback`, { version: 1, message: '电脑开不了机怎么办', reply: reply.json.reply, note: '他不怎么用感叹号', rating: 'bad' })
  check('记下一条反馈', feedback.status === 200 && feedback.json.feedback?.id)
  const refine = await client.api('POST', `/personas/${id}/refine`, {})
  const refined = await waitJob(client, refine.json?.job?.id)
  check('按反馈修订得到 v2', refined?.status === 'done' && refined.result?.version === 2, JSON.stringify(refined))
  const refinePrompt = world.llm.calls.find(call => call.kind === 'persona-refine')?.prompt ?? ''
  check('修订提示词里带着那条反馈', refinePrompt.includes('他不怎么用感叹号'))
  const detail = await client.api('GET', `/personas/${id}`)
  const persona = detail.json.persona
  check('反馈标记为已用于 v2', persona.feedback.every(item => item.appliedIn === 2))
  check('模型建议的记忆先当候选，不直接注入',
    persona.memory.some(item => item.status === 'candidate') && !personaSection.text({ agent: agentFor(headers.group) }).includes('老大'))
  const adopted = await client.api('PATCH', `/personas/${id}`, { memory: persona.memory.map(item => ({ ...item, status: 'active' })) })
  check('采用记忆后注入里带上', adopted.status === 200 && personaSection.text({ agent: agentFor(headers.group) }).includes('老大'))
  const back = await client.api('PATCH', `/personas/${id}`, { activeVersion: 1 })
  check('可以切回旧版本', back.status === 200 && personaSection.text({ agent: agentFor(headers.group) }).includes('爱用感叹号'))
}

heading('I. 技能：只从你自己的会话整理，模型自评决定启用还是候选')
{
  const before = await client.api('GET', '/skills')
  check('可以整理的会话只有你自己的（私密的那个除外）', before.json.eligible === 2, `eligible=${before.json.eligible}`)
  const mine = await client.api('POST', '/skills/mine')
  const done = await waitJob(client, mine.json?.job?.id)
  check('整理完成：1 个启用、1 个候选',
    done?.status === 'done' && done.result.created.includes('check-before-commit') && done.result.candidates.includes('powershell-utf8-io'),
    JSON.stringify(done?.result ?? done))
  const prompt = world.llm.calls.find(call => call.kind === 'skills')?.prompt ?? ''
  check('整理用的摘要里没有 QQ 会话的内容', !prompt.includes('/etc/passwd') && !prompt.includes('来自 QQ'))
  check('摘要里有你的请求和工具调用', prompt.includes('你：') && prompt.includes('调用 bash('))
  const provider = world.skillProviders[0]
  const ownerList = await provider.list({ scope: agentFor(headers.owner) })
  check('你自己的会话能看到启用的技能（带 learned- 前缀）', ownerList.map(item => item.name).join(',') === 'learned-check-before-commit', ownerList.map(item => item.name).join(','))
  const groupList = await provider.list({ scope: agentFor(headers.group) })
  check('QQ 群会话默认看不到（技能没共享）', groupList.length === 0)
  const body = await provider.get(ownerList[0], { scope: agentFor(headers.owner) })
  check('加载全文才拿到正文', body?.content?.includes('node --check'))
  check('QQ 群会话加载不到没共享的技能', (await provider.get(ownerList[0], { scope: agentFor(headers.group) })) === undefined)
  const invalidationsBefore = world.skillInvalidations
  const shared = await client.api('PATCH', '/skills/check-before-commit', { visibility: 'shared' })
  check('共享之后 QQ 群会话能看到', shared.status === 200 && (await provider.list({ scope: agentFor(headers.group) })).length === 1)
  check('改动后通知 DSH 刷新技能目录', world.skillInvalidations > invalidationsBefore)
  const edited = await client.api('PATCH', '/skills/check-before-commit', { body: '## 步骤\n1. 我手动改过的版本，提交前跑 node --check。' })
  check('手动编辑后标记为你改过', edited.status === 200 && edited.json.skill.editedByUser === true)
  const again = await client.api('POST', '/skills/mine')
  check('没有新会话时不重复整理', again.status === 409 || again.json?.ok === false, again.text.slice(0, 120))
  const workbench = service.host.workbench
  check('这个环境关了自动整理', workbench.maybeAutoMine().skipped === true)
  workbench.config.skills.autoMine = true
  const auto = workbench.maybeAutoMine()
  check('打开自动整理后，刚整理过就不会再跑（按间隔）', auto.skipped === true && /间隔/.test(auto.reason), JSON.stringify(auto))
  service.host.skills.state.mining.lastRunAt = Date.now() - 48 * 3600_000
  const due = workbench.maybeAutoMine()
  check('到了间隔但新会话不够 3 个，也不跑', due.skipped === true && /新会话/.test(due.reason), JSON.stringify(due))
  workbench.config.skills.autoMine = false
}

heading('J. 画像：引文核对、置顶、删除与恢复')
{
  const profile = await client.api('GET', '/profile')
  const entries = profile.json.state.profile.entries
  const evidence = profile.json.evidence
  const fake = entries.find(entry => entry.claim.includes('失败用例'))
  const real = entries.find(entry => entry.claim.includes('不要顺手重构'))
  check('找不到出处的引文被标出来', evidence[fake.id]?.status === 'missing', JSON.stringify(evidence[fake.id]))
  check('能在你的发言里找到的引文标为已核对', evidence[real.id]?.status === 'found', JSON.stringify(evidence[real.id]))
  const pin = await client.api('POST', '/profile/entry/pin', { id: real.id, claim: real.claim })
  check('置顶成功', pin.status === 200)
  const del = await client.api('POST', '/profile/entry/delete', { id: fake.id, claim: fake.claim })
  check('删除成功', del.status === 200 && !service.getState().profile.entries.some(entry => entry.id === fake.id))
  const mark = service.getState().entryMarks.find(item => item.status === 'deleted')
  const restore = await client.api('POST', '/profile/entry/restore', { key: mark.key })
  check('从已删除里放回画像', restore.status === 200 && service.getState().profile.entries.some(entry => entry.claim === fake.claim))
  const noConfirm = await client.api('POST', '/profile/clear', { confirm: '好' })
  check('清空画像要输入确认文字', noConfirm.status === 400 && service.getState().profile !== null)
  const overview = await client.api('GET', '/overview')
  check('概览页数据齐全', overview.status === 200 && overview.json.personas.enabled === 1 && overview.json.skills.active === 1 && overview.json.qq.corpusChats === 1,
    JSON.stringify({ personas: overview.json.personas, skills: overview.json.skills, qq: overview.json.qq }))
}

heading('K. 退出登录与更换密钥')
{
  const logout = await client.request('POST', '/api/logout', { headers: { 'x-pa-csrf': await client.refreshCsrf() } })
  check('退出登录', logout.status === 200)
  check('退出后接口 401', (await client.api('GET', '/overview')).status === 401)
  const oldKey = fs.readFileSync(world.keyFile, 'utf8').trim()
  const fresh = consoleClient(base)
  await fresh.loginWithKey(oldKey)
  const rotated = await fresh.request('POST', '/api/console/rotate-key', { headers: { 'x-pa-csrf': await fresh.refreshCsrf() } })
  check('换一把登录密钥', rotated.status === 200 && fs.readFileSync(world.keyFile, 'utf8').trim() !== oldKey)
  check('旧密钥失效', (await consoleClient(base).loginWithKey(oldKey)).status === 401)
  check('换密钥后原来的登录也失效', (await fresh.api('GET', '/overview')).status === 401)
}

world.close()
console.log(`\n${'='.repeat(72)}\n结果：${pass} 通过 / ${fail} 失败\n临时目录：${home}\n${'='.repeat(72)}`)
process.exit(fail === 0 ? 0 : 1)
