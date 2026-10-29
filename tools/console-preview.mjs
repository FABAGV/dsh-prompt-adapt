/**
 * 在合成数据上启动控制台，用来看界面、调样式。不碰 ~/.dsh，不调用真实模型。
 *
 * 用法：node tools/console-preview.mjs [端口，默认 6799]
 * 会打印一个一次性登录链接（60 秒内有效）和登录密钥文件的位置；Ctrl+C 退出。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWorld, agentFor, QQ_GROUP } from '../test/fixtures/console-world.mjs'

delete process.env.DSH_PROMPT_ADAPT_CONSOLE
const port = Number(process.argv[2]) || 6799
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-console-preview-'))
const world = await buildWorld({ home, consolePort: port })
const { service, headers } = world
await world.waitFor(() => service.getState().lastSignals != null)

// 画像、权限拒绝、人格、技能各来一点数据，让每一页都有东西可看。
await service.regenerateNow()
const entries = service.getState().profile?.entries ?? []
if (entries[1]) service.pinEntry(entries[1].id, entries[1].claim)
const guard = world.guards[0]
for (const [name, args] of [['bash', { command: 'cat /etc/passwd' }], ['read', { file_path: 'C:/Windows/win.ini' }], ['web_fetch', { url: 'http://127.0.0.1:6710/api/overview' }]]) {
  guard?.({ agent: agentFor(headers.group), name, arguments: args })
}
service.updatePrivacy({ chats: { 'private:42': { tier: 'safe', note: '我自己的小号' } } }, 'console')

const personas = service.host.personas
const created = personas.create({
  name: '小明风格',
  kind: 'member',
  source: { chatType: 'group', chatId: QQ_GROUP, memberId: '10001', memberName: '小明', days: 30 },
  consent: true,
})
if (created.ok) {
  const id = created.persona.id
  const generated = service.host.workbench.startGenerate(id)
  if (generated.ok) await world.waitFor(() => service.host.jobs.get(generated.job.id)?.status !== 'running')
  personas.addFeedback(id, { version: 1, message: '电脑开不了机怎么办', reply: '哈哈哈！先清缓存！', note: '他不怎么用感叹号', rating: 'bad' })
  personas.update(id, { enabled: true, bindings: [{ kind: 'chat', key: `group:${QQ_GROUP}` }] })
}
personas.create({ name: '温柔学姐', kind: 'description', description: '说话温柔，爱用"呀""呢"，会先安慰再给建议。' })

const mined = service.host.workbench.startMining()
if (mined.ok) await world.waitFor(() => service.host.jobs.get(mined.job.id)?.status !== 'running')

const ticket = service.issueConsoleTicket()
console.log(`\n控制台：${world.consoleUrl}`)
console.log(`一次性登录链接（60 秒内有效）：${ticket.url}`)
console.log(`登录密钥文件：${world.keyFile}`)
console.log(`合成数据目录：${home}`)
console.log('Ctrl+C 退出。')

const keepAlive = setInterval(() => {}, 1 << 30)
process.on('SIGINT', () => {
  clearInterval(keepAlive)
  world.close()
  process.exit(0)
})
