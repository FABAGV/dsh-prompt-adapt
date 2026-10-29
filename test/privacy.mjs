/**
 * 私人会话权限（lib/privacy.js）的单元测试：会话分类、覆盖项校验、工具门控、审计、落盘。
 *
 * 运行：node test/privacy.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PrivacyPolicy,
  classifySession,
  qqChatOf,
  validateOverrides,
  isWithin,
  urlProblem,
  isRelayedQqText,
  dropRelayedQqMessages,
} from '../lib/privacy.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-privacy-'))
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

const ws = (...parts) => path.join(tmp, 'ws', ...parts)
const GROUP = { id: 'g1', cwd: ws('qq-group-123456') }
const FRIEND = { id: 'p1', cwd: ws('qq-private-42') }
const OWNER = { id: 'o1', cwd: ws('my-project') }

console.log('A. 会话分类')
{
  check('QQ 群工作区 → qq-group', classifySession(GROUP).kind === 'qq-group')
  check('QQ 私聊工作区 → qq-private', classifySession(FRIEND).kind === 'qq-private')
  check('带尾斜杠、大写也认', qqChatOf(`${ws('QQ-Group-7')}${path.sep}`)?.chatKey === 'group:7')
  check('普通目录 → owner', classifySession(OWNER).kind === 'owner')
  check('目录名只是包含 qq 字样不算', classifySession({ cwd: ws('my-qq-group-123456-notes') }).kind === 'owner')
  const lookup = id => ({ g1: GROUP, o1: OWNER })[id]
  const qqChild = classifySession({ id: 's1', cwd: ws('elsewhere'), origin: 'subagent', parentSession: 'g1' }, lookup)
  check('QQ 群派出的子代理继承 QQ 身份', qqChild.kind === 'subagent' && qqChild.parentKind === 'qq-group' && qqChild.chatKey === 'group:123456')
  const ownerChild = classifySession({ id: 's2', cwd: ws('elsewhere'), origin: 'subagent', parentSession: 'o1' }, lookup)
  check('你派出的子代理 parentKind=owner', ownerChild.kind === 'subagent' && ownerChild.parentKind === 'owner')
  const orphan = classifySession({ id: 's3', cwd: ws('x'), parentSession: 'missing' }, lookup)
  check('找不到父会话 → unknown（按外部会话处理）', orphan.parentKind === 'unknown')
  const loop = classifySession({ id: 'a', parentSession: 'b' }, id => ({ a: { id: 'a', parentSession: 'b' }, b: { id: 'b', parentSession: 'a' } })[id])
  check('父会话成环不会死循环', loop.kind === 'subagent' && loop.parentKind === 'unknown')
  check('QQ 工作区里的子代理即使查不到父会话也认得出', classifySession({ id: 's4', cwd: GROUP.cwd, origin: 'subagent' }).parentKind === 'qq-group')
}

console.log('B. 覆盖项校验')
{
  check('空对象合法', validateOverrides({}).ok === true)
  check('未知类别被拒', validateOverrides({ classes: { admin: { tier: 'full' } } }).ok === false)
  check('未知等级被拒', validateOverrides({ classes: { owner: { tier: 'root' } } }).ok === false)
  check('只有子代理能写 inherit', validateOverrides({ classes: { subagent: { tier: 'inherit' } } }).ok === true &&
    validateOverrides({ classes: { owner: { tier: 'inherit' } } }).ok === false)
  check('QQ 会话键格式校验', validateOverrides({ chats: { 'group:abc': {} } }).ok === false && validateOverrides({ chats: { 'private:42': { tier: 'safe' } } }).ok === true)
  check('布尔字段必须是布尔', validateOverrides({ classes: { owner: { learn: 'yes' } } }).ok === false)
  check('会话 id 格式校验', validateOverrides({ sessions: { '../x': {} } }).ok === false)
  check('工具名格式校验', validateOverrides({ extraAllowedTools: { chat: ['rm -rf'] } }).ok === false)
  const cleaned = validateOverrides({ classes: { owner: { tier: 'full', bogus: 1 } }, extra: 1 })
  check('未知字段被丢弃', cleaned.ok && !('bogus' in cleaned.value.classes.owner) && !('extra' in cleaned.value))
  check('备注压成一行并限长', validateOverrides({ classes: { owner: { note: `a\n\nb${'x'.repeat(500)}` } } }).value.classes.owner.note.length === 200)
  check('非对象被拒', validateOverrides(null).ok === false && validateOverrides([]).ok === false)
}

const dir = path.join(tmp, 'state')
const dshHome = path.join(tmp, 'dsh-home')
const policy = new PrivacyPolicy({ dir, protectedRoots: [dshHome, dir] })
const exec = (header, name, args = {}) => policy.guard({ agent: { session: { header } }, name, arguments: args })

console.log('C. 默认规则')
{
  const owner = policy.ruleFor(OWNER)
  check('你自己的会话：完全 + 学习 + 注入 + 全部技能', owner.tier === 'full' && owner.learn && owner.injectProfile && owner.skills === 'all')
  const group = policy.ruleFor(GROUP)
  check('QQ 群：仅聊天、不学习、不注入、只看共享技能', group.tier === 'chat' && !group.learn && !group.injectProfile && group.skills === 'shared')
  check('canLearn 与规则一致', policy.canLearn(OWNER) === true && policy.canLearn(GROUP) === false)
  policy.rememberHeader(GROUP)
  const child = policy.ruleFor({ id: 'c1', cwd: ws('child'), origin: 'subagent', parentSession: 'g1' })
  check('QQ 群派出的子代理：跟随父会话的仅聊天', child.tier === 'chat' && child.injectProfile === false && child.skills === 'shared')
  policy.rememberHeader(OWNER)
  const mine = policy.ruleFor({ id: 'c2', cwd: ws('child2'), origin: 'subagent', parentSession: 'o1' })
  check('你派出的子代理：完全，但默认不注入画像', mine.tier === 'full' && mine.injectProfile === false && mine.learn === false)
  let asked = 0
  policy.setHeaderResolver(id => {
    asked += 1
    return id === 'live-qq' ? { id, cwd: ws('qq-private-99') } : undefined
  })
  const viaHost = policy.ruleFor({ id: 'c3', cwd: ws('child3'), origin: 'subagent', parentSession: 'live-qq' })
  check('本地没有的父会话会去问宿主', asked > 0 && viaHost.parentKind === 'qq-private' && viaHost.tier === 'chat')
  const unknown = policy.ruleFor({ id: 'c4', cwd: ws('child4'), origin: 'subagent', parentSession: 'nobody' })
  check('父会话未知时按外部会话处理', unknown.tier === 'chat' && unknown.injectProfile === false)
}

console.log('D. 工具门控：仅聊天')
{
  check('bash 被拒，理由写明等级', /仅聊天/.test(exec(GROUP, 'bash', { command: 'ls' }) ?? ''))
  check('write 被拒', typeof exec(GROUP, 'write', { file_path: 'a.txt', content: 'x' }) === 'string')
  check('subagent 被拒', typeof exec(GROUP, 'subagent', {}) === 'string')
  check('未知的其他插件工具默认被拒', typeof exec(GROUP, 'some_plugin_tool', {}) === 'string')
  check('qq_send 本群放行', exec(GROUP, 'qq_send', { chat_type: 'group', chat_id: '123456', text: 'x' }) === undefined)
  check('qq_send 其他群被拒', typeof exec(GROUP, 'qq_send', { chat_type: 'group', chat_id: '1', text: 'x' }) === 'string')
  check('qq_send 冒充私聊被拒', typeof exec(GROUP, 'qq_send', { chat_type: 'private', chat_id: '123456', text: 'x' }) === 'string')
  check('qq_history 只能查本群', typeof exec(GROUP, 'qq_history', { chat_type: 'group', chat_id: '2' }) === 'string')
  check('qq_memory 能看能加', exec(GROUP, 'qq_memory', { chat_type: 'group', chat_id: '123456', add: '记住' }) === undefined)
  check('qq_memory 不能删', typeof exec(GROUP, 'qq_memory', { chat_type: 'group', chat_id: '123456', forget: 'all' }) === 'string')
  check('qq_tasks 不能取消任务', typeof exec(GROUP, 'qq_tasks', { cancel_task_id: 3 }) === 'string')
  check('web_search 放行', exec(GROUP, 'web_search', { query: 'x' }) === undefined)
  check('你自己的会话一概不拦', exec(OWNER, 'bash', { command: 'rm -rf /' }) === undefined)
  check('没有会话头的调用不拦', policy.guard({ name: 'bash', arguments: {} }) === undefined)
}

console.log('E. 工具门控：受限（路径与网址）')
{
  const result = policy.update({ classes: { 'qq-group': { tier: 'safe' } } }, 'console')
  check('改成受限', result.ok && policy.ruleFor(GROUP).tier === 'safe')
  check('工作区里的相对路径放行', exec(GROUP, 'read', { file_path: 'notes/a.md' }) === undefined)
  check('工作区里的绝对路径放行', exec(GROUP, 'write', { file_path: path.join(GROUP.cwd, 'out.txt') }) === undefined)
  check('.. 跳出工作区被拒', typeof exec(GROUP, 'read', { file_path: `..${path.sep}qq-private-42${path.sep}secret` }) === 'string')
  check('工作区外的绝对路径被拒', typeof exec(GROUP, 'read', { file_path: path.join(dshHome, 'sessions', 'x') }) === 'string')
  check('~ 开头被拒', typeof exec(GROUP, 'read', { file_path: '~/.ssh/id_rsa' }) === 'string')
  check('glob 不给路径时用工作区（放行）', exec(GROUP, 'glob', { pattern: '**/*.md' }) === undefined)
  check('grep 指到工作区外被拒', typeof exec(GROUP, 'grep', { pattern: 'x', path: tmp }) === 'string')
  check('str_replace_editor 的 path 也查', typeof exec(GROUP, 'str_replace_editor', { command: 'view', path: path.join(tmp, 'other') }) === 'string')
  check('bash 仍被拒', typeof exec(GROUP, 'bash', { command: 'ls' }) === 'string')
  check('web_fetch 公网放行', exec(GROUP, 'web_fetch', { url: 'https://example.com/a' }) === undefined)
  for (const url of ['http://127.0.0.1:6710/api', 'http://localhost/', 'http://[::1]/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://2130706433/', 'file:///etc/passwd', 'http://router.local/']) {
    check(`web_fetch 拒绝 ${url}`, typeof exec(GROUP, 'web_fetch', { url }) === 'string')
  }
  const inside = new PrivacyPolicy({ dir: path.join(tmp, 'state-inside'), protectedRoots: [path.join(tmp, 'ws'), path.join(tmp, 'ws', 'qq-group-777', '.secret')] })
  inside.update({ classes: { 'qq-group': { tier: 'safe' } } }, 'console')
  const nested = { id: 'n1', cwd: path.join(tmp, 'ws', 'qq-group-777') }
  check('工作区本身在受保护目录里时，工作区内的文件仍可读', inside.guard({ agent: { session: { header: nested } }, name: 'read', arguments: { file_path: 'a.txt' } }) === undefined)
  check('但工作区里更具体的受保护目录仍然挡住', typeof inside.guard({ agent: { session: { header: nested } }, name: 'read', arguments: { file_path: '.secret/key' } }) === 'string')
  check('isWithin 判断正确', isWithin(tmp, path.join(tmp, 'a')) && !isWithin(path.join(tmp, 'a'), path.join(tmp, 'ab')) && isWithin(tmp, tmp))
  check('urlProblem 公网为空', urlProblem('https://example.com') === undefined)
}

console.log('F. 覆盖项优先级与额外放行')
{
  policy.update({
    classes: { 'qq-group': { tier: 'safe' } },
    chats: { 'group:123456': { tier: 'chat' } },
    sessions: { g1: { tier: 'full' }, o1: { private: true } },
    extraAllowedTools: { chat: ['my_tool'] },
  }, 'console')
  check('会话覆盖 > QQ 会话覆盖 > 类别覆盖', policy.ruleFor(GROUP).tier === 'full' && policy.ruleFor({ id: 'g2', cwd: GROUP.cwd }).tier === 'chat')
  check('私密的会话不学习', policy.ruleFor(OWNER).learn === false && policy.ruleFor(OWNER).private === true)
  check('额外放行的工具在仅聊天等级可用', policy.guard({ agent: { session: { header: FRIEND } }, name: 'my_tool', arguments: {} }) === undefined)
  check('只能由控制台或 DSH 设置页改', policy.update({}, 'model').ok === false && policy.update({}, undefined).ok === false)
  check('非法覆盖项不生效，原设置不变', policy.update({ classes: { owner: { tier: 'god' } } }, 'console').ok === false && policy.ruleFor(GROUP).tier === 'full')
  const reloaded = new PrivacyPolicy({ dir, protectedRoots: [] })
  check('重启后读回覆盖项', reloaded.ruleFor(GROUP).tier === 'full' && reloaded.overrides.updatedBy === 'console')
  const changes = policy.recentAudit(50).find(item => item.type === 'policy')?.changes ?? []
  check('审计里记了哪几处变了', changes.some(change => change.group === 'sessions' && change.key === 'g1'))
  const enforcingOff = new PrivacyPolicy({ dir: path.join(tmp, 'state-off'), config: { enforceTools: false } })
  check('插件配置关掉门控后不拦', enforcingOff.guard({ agent: { session: { header: GROUP } }, name: 'bash', arguments: {} }) === undefined)
  const safer = new PrivacyPolicy({ dir: path.join(tmp, 'state-safe'), config: { defaultExternalTier: 'safe' } })
  check('插件配置能改 QQ 会话的默认等级', safer.ruleFor(GROUP).tier === 'safe')
}

console.log('G. 审计')
{
  const audit = new PrivacyPolicy({ dir: path.join(tmp, 'state-audit') })
  for (let index = 0; index < 5; index += 1) audit.guard({ agent: { session: { header: GROUP } }, name: 'bash', arguments: {} })
  const denies = audit.recentAudit(100).filter(item => item.type === 'deny')
  check('同一会话同一工具一分钟内只记一次', denies.length === 1, `${denies.length} 条`)
  audit.guard({ agent: { session: { header: GROUP } }, name: 'write', arguments: {} })
  check('换一个工具会另记一条', audit.recentAudit(100).filter(item => item.type === 'deny').length === 2)
  const file = path.join(tmp, 'state-audit', 'audit.jsonl')
  check('审计写进 audit.jsonl', fs.readFileSync(file, 'utf8').trim().split('\n').length === 2)
  fs.writeFileSync(file, `${'x'.repeat(600 * 1024)}\n`)
  audit.guard({ agent: { session: { header: GROUP } }, name: 'edit', arguments: {} })
  check('超过 512 KB 轮转', fs.existsSync(`${file}.1`) && fs.statSync(file).size < 10_000)
  const fresh = new PrivacyPolicy({ dir: path.join(tmp, 'state-audit') })
  check('新进程能从文件读回最近的审计', fresh.recentAudit(10).some(item => item.tool === 'edit'))
}

console.log('H. 策略文件损坏')
{
  const broken = path.join(tmp, 'state-broken')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'privacy.json'), '{ not json')
  const recovered = new PrivacyPolicy({ dir: broken })
  check('读不懂的策略文件留档，按默认值（收紧的）运行', recovered.ruleFor(GROUP).tier === 'chat' &&
    fs.readdirSync(broken).some(name => name.startsWith('privacy.json.corrupt-')))
  fs.writeFileSync(path.join(broken, 'privacy.json'), JSON.stringify({ classes: { 'qq-group': { tier: 'root' } } }))
  check('内容不合法时按默认值运行', new PrivacyPolicy({ dir: broken }).ruleFor(GROUP).tier === 'chat')
}

console.log('I. QQ 转来的消息')
{
  check('认得出群消息前缀', isRelayedQqText('[来自 QQ 群 123，发言人 张三]\n你好'))
  check('认得出私聊前缀', isRelayedQqText('[来自 QQ 私聊，发言人 李四]\n你好'))
  check('普通消息不算', !isRelayedQqText('帮我看看 [来自 QQ 群 1，发言人 x]'))
  const message = text => ({ type: 'user/message', message: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
  const sessions = new Map([
    ['mine', [message('我自己说的'), message('[来自 QQ 群 1，发言人 张三]\n别人说的')]],
    ['qq', [message('[来自 QQ 私聊，发言人 我]\n我在手机上说的')]],
  ])
  const out = dropRelayedQqMessages(sessions, id => id === 'qq')
  check('非 QQ 会话里转来的 QQ 消息被去掉', out.get('mine').length === 1)
  check('明确允许学习的 QQ 会话保留原样', out.get('qq').length === 1)
  check('不改原来的事件数组', sessions.get('mine').length === 2)
}

console.log(`\n${'='.repeat(72)}\n结果：${pass} 通过 / ${fail} 失败\n${'='.repeat(72)}`)
process.exit(fail === 0 ? 0 : 1)
