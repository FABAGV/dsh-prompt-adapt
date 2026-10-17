/**
 * P0 回归：**会话来源**与**材料截止时刻**。
 *
 * 这一组盯的是两个已被真实数据证实的病因：
 *
 *   1. 子代理会话里的委派 prompt 也是 `source.kind === 'user'`，原来被当成
 *      "真人发言"计入画像材料与触发计数（本机 235 个会话文件里 179 个是子代理；
 *      188 条"真人消息"其实是父代理写的 prompt）。`session` 事件顶层一直有
 *      `origin: 'subagent'` / `parentSession` / `delegationDepth`，是归一化时丢的。
 *   2. 触发原来按"累计真人消息差"算：扫描器补扫旧日志、以及生成那 25–33 秒里
 *      到达的消息，都会被算成用户活跃或永久漏掉。现在按**材料截止时刻**算。
 *
 * 运行： node test/session-origin.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { SessionScanner, normalizeInto } from '../lib/sessions.js'
import { computeAllSignals, computeSessionSignals } from '../lib/signals.js'
import {
  collectHumanMessages,
  freshness,
  materialCutoff,
  shouldRegenerate,
} from '../lib/profile.js'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-session-origin-'))
process.env.DSH_HOME = TMP_ROOT

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

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

/** 会话头（形状照抄真实日志：字段都在事件顶层，不在 `data` 里）。 */
function sessionEvent(id, origin = 'main', extra = {}) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: 1,
    cwd: 'R:\\working zone',
    ...(origin === 'subagent'
      ? { parentSession: 'session-parent', origin: 'subagent', delegationDepth: 1 }
      : { origin }),
    ...extra,
  }
}

function humanMessage(seq, time, text) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function writeSession(sessionsRoot, sessionId, lines) {
  const file = path.join(sessionsRoot, 'proj', sessionId, 'session.v4.jsonl.zstd')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
}

function newScanner(name, sessions) {
  const sessionsRoot = path.join(TMP_ROOT, `${name}-sessions`)
  const plainDir = path.join(TMP_ROOT, `${name}-plain`)
  fs.mkdirSync(sessionsRoot, { recursive: true })
  for (const [id, lines] of Object.entries(sessions)) writeSession(sessionsRoot, id, lines)
  const scanner = new SessionScanner({
    sessionsRoot,
    plainDir,
    maxWindowSize: 64 << 20,
    maxFramesPerScan: 400,
    log: SILENT,
  })
  scanner.scan({ version: 1, files: {} })
  return scanner
}

const signalOptions = {
  longToolMs: 60000,
  repeatFailMin: 3,
  answerWindowMs: 1800000,
  humanWaitTools: ['ask_user_question'],
  delegatePatterns: [],
}

console.log('\nA. normalizeInto 保留 session 头里的来源字段')
{
  const out = []
  normalizeInto(out, [sessionEvent('s-1', 'subagent')], 's-1', 0)
  check('origin 被保留', out[0]?.origin === 'subagent', `origin=${out[0]?.origin}`)
  check('parentSession 被保留', out[0]?.parentSession === 'session-parent')
  check('delegationDepth 被保留', out[0]?.delegationDepth === 1)
  const main = []
  normalizeInto(main, [sessionEvent('s-2', 'main')], 's-2', 0)
  check('主会话的 origin 是 main', main[0]?.origin === 'main')
}

console.log('\nB. bySession({humanOnly}) 只留主会话')
{
  const scanner = newScanner('by-session', {
    's-main': [sessionEvent('s-main', 'main'), humanMessage(1, 1000, '主会话第一句'), humanMessage(2, 2000, '主会话第二句')],
    's-sub': [sessionEvent('s-sub', 'subagent'), humanMessage(1, 1500, '你是子代理，任务是……')],
  })
  const all = scanner.bySession()
  const human = scanner.bySession({ humanOnly: true })
  check('默认仍能拿到两个会话（界面/排障路径不变）', all.size === 2, `size=${all.size}`)
  check('humanOnly 只剩主会话', human.size === 1 && human.has('s-main'), `size=${human.size}`)
  check('子代理会话的消息确实在（不是没读到）', all.get('s-sub')?.some(event => event.type === 'user/message'))

  const messages = collectHumanMessages(human, { maxMessageChars: 500, maxMaterialChars: Infinity })
  check('画像材料只收主会话的 2 条', messages.length === 2, `len=${messages.length}`)
  const mixed = collectHumanMessages(all, { maxMessageChars: 500, maxMaterialChars: Infinity })
  check('对照：不过滤会多收委派 prompt（旧行为的病因）', mixed.length === 3, `len=${mixed.length}`)

  const filtered = computeAllSignals(human, signalOptions, { details: false })
  const unfiltered = computeAllSignals(all, signalOptions, { details: false })
  check('信号只统计主会话：humanMessages=2 / sessions=1',
    filtered.totals.humanMessages === 2 && filtered.totals.sessions === 1,
    JSON.stringify(filtered.totals))
  check('对照：不过滤时多算一条"真人发言"', unfiltered.totals.humanMessages === 3,
    `humanMessages=${unfiltered.totals.humanMessages}`)

  // 单会话明细路径（界面点开某个会话）仍然能看到子代理会话
  const subDetail = computeSessionSignals(all.get('s-sub'), signalOptions)
  check('getSessionSignals 那条路径不受过滤影响（子会话仍有 1 条）', subDetail.humanMessages === 1)
}

console.log('\nC. materialCutoff 取材料的时间上界')
{
  const scanner = newScanner('cutoff', {
    's-a': [sessionEvent('s-a'), humanMessage(1, 1000, '一'), humanMessage(2, 3000, '三')],
    's-b': [sessionEvent('s-b'), humanMessage(1, 2000, '二')],
  })
  const human = scanner.bySession({ humanOnly: true })
  check('取三条里最大的时间戳', materialCutoff(human) === 3000, `cutoff=${materialCutoff(human)}`)
  check('空会话返回 0', materialCutoff(new Map()) === 0)
}

console.log('\nD. freshness：只数截止时刻之后的真人发言')
{
  const scanner = newScanner('fresh', {
    's-a': [sessionEvent('s-a'), humanMessage(1, 1000, '一'), humanMessage(2, 2000, '二')],
    's-b': [sessionEvent('s-b'), humanMessage(1, 3000, '三')],
  })
  const human = scanner.bySession({ humanOnly: true })
  const all = freshness(human, 0)
  check('since=0 全算：3 条 / 2 会话', all.messages === 3 && all.sessions === 2, JSON.stringify(all))
  const later = freshness(human, 2000)
  check('since=2000 只算严格更晚的：1 条 / 1 会话', later.messages === 1 && later.sessions === 1, JSON.stringify(later))
  check('since=3000 一条都不算', freshness(human, 3000).messages === 0)

  // 生成窗口回归：材料截止 1000，消息在 1000 之后到达（哪怕早于本次生成结束时刻）
  const windowScanner = newScanner('window', {
    's-a': [sessionEvent('s-a'), humanMessage(1, 1000, '材料内的'), humanMessage(2, 1200, '生成期间到达的')],
  })
  const windowHuman = windowScanner.bySession({ humanOnly: true })
  check('新材料截止时刻之后到达的消息会被算进来（不会被永久跳过）',
    freshness(windowHuman, 1000).messages === 1)
  check('若错误地用"生成结束时刻"当界，就会漏掉它（这就是被修掉的 bug）',
    freshness(windowHuman, 1500).messages === 0)
}

console.log('\nE. shouldRegenerate 用新判据；旧字段仍可兜底')
{
  const config = { triggerUserMessages: 12, triggerNewSessions: 3 }
  const profile = { entries: [{ id: 'x' }] }
  const lastGeneration = { at: 10, humanMessages: 100, sessions: 5, materialCutoff: 2000 }
  const at = (extra) => shouldRegenerate({
    profile,
    lastGeneration,
    humanMessages: 100,
    sessions: 5,
    config,
    ...extra,
  })
  check('新增 12 条真人发言 → 触发', at({ newMessages: 12, newSessions: 0 }).due === true)
  check('新增 3 个会话 → 触发', at({ newMessages: 0, newSessions: 3 }).due === true)
  check('新增 11 条 / 2 会话 → 不触发', at({ newMessages: 11, newSessions: 2 }).due === false)
  check('旧调用方式（不传新字段）仍按累计差：+12 → 触发',
    shouldRegenerate({
      profile, lastGeneration, humanMessages: 112, sessions: 5, config,
    }).due === true)
  check('旧调用方式：+11 / +2 → 不触发',
    shouldRegenerate({
      profile, lastGeneration, humanMessages: 111, sessions: 7, config,
    }).due === false)
}

console.log('\n========================================================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`临时目录：${TMP_ROOT}`)
console.log('========================================================================')
if (fail > 0) process.exitCode = 1
