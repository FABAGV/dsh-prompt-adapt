/**
 * 抽样检查：把四个信号在**真实日志**上抓到的样本打出来，人工核对判据是否合理。
 * 这是"计数对不对"的唯一可信验证方式 —— 自动化断言只能证明代码自洽，
 * 证明不了判据符合语义。
 *
 * 运行：
 *   node test/inspect-signals.mjs
 */
import path from 'node:path'
import os from 'node:os'
import { SessionScanner } from '../lib/sessions.js'
import { computeSessionSignals, isHumanMessage, humanText } from '../lib/signals.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const log = { debug() {}, info() {}, warn() {}, error() {} }

const scanner = new SessionScanner({
  sessionsRoot: path.join(DSH_HOME, 'sessions'),
  plainDir: path.join(os.tmpdir(), 'prompt-adapt-inspect-plain'),
  maxWindowSize: 64 << 20,
  maxFramesPerScan: 100000,
  log,
})
scanner.scan({ version: 1, files: {} })
const bySession = scanner.bySession()

const options = {
  delegatePatterns: [
    '(请你|需要你|你自己)\\s*[去来把帮做先再重试看查改加写跑执行处理确认补删增]',
    '(请|麻烦|劳驾)你[^，。；\\n]{0,12}(一下|一趟|帮忙)',
  ],
  longToolMs: 60000,
  humanWaitTools: [
    'ask_user_question', 'job_output', 'job_list', 'job_kill',
    'subagent', 'list_agents', 'send_message', 'plugin_manager',
  ],
  repeatFailMin: 3,
  answerWindowMs: 1800000,
}

const perSession = []
for (const [sessionId, events] of bySession) {
  const result = computeSessionSignals(events, options)
  if (result.humanMessages === 0) continue
  perSession.push({ sessionId, result })
}

console.log('='.repeat(78))
console.log('判据 1 —— 「让你代跑」：该轮零工具调用 + 末条消息命中请求句式')
console.log('='.repeat(78))
{
  const hits = perSession.flatMap(s => s.result.details.delegateRuns.map(m => ({ sessionId: s.sessionId, ...m })))
  console.log(`总数 ${hits.length}`)
  for (const hit of hits.slice(0, 10)) {
    console.log(`  [轮 ${hit.turn}] 命中「${hit.matched}」`)
    console.log(`    …${hit.excerpt.slice(0, 220)}`)
    console.log('')
  }
}

console.log('')
console.log('='.repeat(78))
console.log('判据 2 —— 「命令失控」：命令类工具墙钟超阈值（60s）')
console.log('='.repeat(78))
{
  const hits = perSession.flatMap(s => s.result.details.longTools.map(m => ({ sessionId: s.sessionId, ...m })))
  const waits = perSession.flatMap(s => s.result.details.humanWaitTools.map(m => ({ sessionId: s.sessionId, ...m })))
  hits.sort((a, b) => b.durationMs - a.durationMs)
  console.log(`总数 ${hits.length}（另有 ${waits.length} 次是人类/后台等待，已单独归类）`)
  const byTool = new Map()
  for (const hit of hits) byTool.set(hit.tool, (byTool.get(hit.tool) ?? 0) + 1)
  console.log(`  按工具：${[...byTool].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(' ')}`)
  for (const hit of hits.slice(0, 10)) {
    console.log(`  ${(hit.durationMs / 1000).toFixed(1)}s  ${hit.tool}  (轮 ${hit.turn})`)
  }
  const waitByTool = new Map()
  for (const hit of waits) waitByTool.set(hit.tool, (waitByTool.get(hit.tool) ?? 0) + 1)
  if (waits.length) {
    console.log(`  被单独归类的等待：${[...waitByTool].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(' ')}`)
  }
}

console.log('')
console.log('='.repeat(78))
console.log('判据 3 —— 「工具反复失败」：同一工具连续失败 ≥ 3 次')
console.log('='.repeat(78))
{
  const hits = perSession.flatMap(s => s.result.details.repeatFailures.map(m => ({ sessionId: s.sessionId, ...m })))
  console.log(`总数 ${hits.length}`)
  for (const hit of hits.slice(0, 8)) {
    console.log(`  ${hit.tool} 连续失败 ${hit.run} 次，最后错误码 ${hit.lastErrorCode} (轮 ${hit.turn})`)
  }
}

console.log('')
console.log('='.repeat(78))
console.log('判据 4 —— 「给了选项但用户自己另说」')
console.log('='.repeat(78))
{
  const hits = perSession.flatMap(s => s.result.details.freeformAnswers.map(m => ({ sessionId: s.sessionId, ...m })))
  console.log(`总数 ${hits.length}`)
  for (const hit of hits.slice(0, 8)) {
    console.log(`  给了选项：`)
    for (const label of hit.offered) console.log(`    - ${label}`)
    console.log(`  用户说：${hit.said.replace(/\n/g, ' ').slice(0, 160)}`)
    console.log('')
  }
}

console.log('='.repeat(78))
console.log('对照：真人发言样本（确认没有把注入内容当成人话）')
console.log('='.repeat(78))
{
  const humans = []
  for (const [sessionId, events] of bySession) {
    for (const event of events) {
      if (!isHumanMessage(event)) continue
      const text = humanText(event)
      if (text) humans.push({ sessionId, text })
    }
  }
  console.log(`真人发言总数 ${humans.length}`)
  for (const human of humans.slice(0, 8)) {
    console.log(`  [${human.sessionId.slice(0, 8)}] ${human.text.replace(/\n/g, ' ').slice(0, 120)}`)
  }
}

console.log('')
console.log('='.repeat(78))
console.log('反面对照：被判为**非**真人发言的 user-role 消息（应当全是注入）')
console.log('='.repeat(78))
{
  const injected = []
  for (const [sessionId, events] of bySession) {
    for (const event of events) {
      if (event.type !== 'user/message') continue
      if (isHumanMessage(event)) continue
      const kind = event.message?.source?.kind ?? '(none)'
      injected.push({ sessionId, kind, text: humanText(event) })
    }
  }
  console.log(`非真人 user-role 消息 ${injected.length} 条，按 kind 分布：`)
  const kinds = new Map()
  for (const item of injected) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
  console.log(`  ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`)
}
