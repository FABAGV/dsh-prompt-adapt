/**
 * P0 端到端：`apply() → 定时 tick → scanOnce() → maybeGenerate()` 的真实接线。
 *
 * 为什么必须单独一个文件：`session-origin.mjs` 只测纯函数，把 `index.js` 里
 * 三处 `bySession({ humanOnly: true })` 全回退它仍然是绿的。这里用一个真实的
 * cordis Context + 临时 `DSH_HOME` + 合成会话日志，把下面三件事一次钉死：
 *
 *   1. **旧 state 迁移**：预置一份"旧格式" state（有画像、`humanMessages: 524`、
 *      没有 `materialCutoff`）。过滤后真人只有 15 条/1 会话 —— 如果走累计差兜底
 *      就是 15-524 = -509，永远不触发、永远写不进截止时刻，自动更新永久停摆。
 *      第一次 tick 必须把基线换成 15/1、把 `materialCutoff` 写成上一版 `at`。
 *   2. **会话级来源过滤**：子代理会话故意拆成两个文件（v3 有 `origin:'subagent'`、
 *      v4 没有会话头），两个文件的消息一条都不许进材料/信号/触发。
 *   3. **触发与落账**：追加 12 条新的真人消息后必须真的调用一次 LLM；生成成功后
 *      `lastGeneration.materialCutoff` 推进到最新消息时间，`injectionLedger`
 *      记下这一版的交付集合。
 *
 * 运行： node test/p0-e2e.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-p0-e2e-'))
process.env.DSH_HOME = TMP_ROOT
const sessionsRoot = path.join(TMP_ROOT, 'sessions')
const stateDir = path.join(TMP_ROOT, 'prompt-adapt')
fs.mkdirSync(sessionsRoot, { recursive: true })
fs.mkdirSync(stateDir, { recursive: true })

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
const BASE = Date.now() - 3_600_000

function human(seq, time, text) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}
function header(id, origin) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: time0(),
    cwd: TMP_ROOT,
    ...(origin === 'subagent'
      ? { parentSession: 'session-parent', origin: 'subagent', delegationDepth: 1 }
      : { origin }),
  }
}
function time0() {
  return BASE - 60_000
}
function writeFrame(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
}

// ── 主会话：15 条真人消息（全部早于 BASE） ─────────────────────────────
const mainFile = path.join(sessionsRoot, 'proj', 'main-session', 'session.v4.jsonl.zstd')
writeFrame(mainFile, [header('main-session', 'main')])
for (let index = 0; index < 15; index += 1) {
  writeFrame(mainFile, [human(index + 1, BASE - 30_000 + index * 10, `main-old-${index}`)])
}

// ── 子代理会话：两个文件，v3 有 origin、v4 没有会话头 ────────────────
const subV3 = path.join(sessionsRoot, 'proj', 'sub-session', 'session.v3.jsonl.zstd')
const subV4 = path.join(sessionsRoot, 'proj', 'sub-session', 'session.v4.jsonl.zstd')
writeFrame(subV3, [header('sub-session', 'subagent')])
for (let index = 0; index < 10; index += 1) {
  writeFrame(subV3, [human(index + 1, BASE - 20_000 + index * 10, `sub-prompt-${index}`)])
}
for (let index = 0; index < 5; index += 1) {
  writeFrame(subV4, [human(index + 1, BASE - 10_000 + index * 10, `sub-prompt-v4-${index}`)])
}

// ── 预置"旧格式" state：有画像、没有 materialCutoff、累计数含子代理 ──────
const previousProfile = {
  version: 5,
  generatedAt: BASE,
  provider: 'fake',
  model: 'fake',
  evidenceMessages: 400,
  entries: [
    { id: 'p1', category: 'A', claim: '用户喜欢短结论。', evidence: ['a'], confidence: 'high', evidenceQuoteCount: 3, timesSeen: 2, firstSeenAt: BASE - 1000, lastSeenAt: BASE },
    { id: 'p2', category: 'B', claim: '不要重复解释。', evidence: ['b'], confidence: 'medium', evidenceQuoteCount: 2, timesSeen: 2, firstSeenAt: BASE - 1000, lastSeenAt: BASE },
    { id: 'p3', category: 'C', claim: '先给计划再动手。', evidence: ['c'], confidence: 'medium', evidenceQuoteCount: 2, timesSeen: 2, firstSeenAt: BASE - 1000, lastSeenAt: BASE },
  ],
}
fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
  version: 1,
  mode: 'auto',
  customText: '',
  profile: previousProfile,
  autoExtraText: '',
  entryMarks: [],
  copiedSnapshot: { text: null, at: null, profileVersion: null },
  // 旧口径：524 条"真人"消息（含 188 条子代理 prompt）、215 个会话；没有 cutoff
  lastGeneration: { at: BASE, humanMessages: 524, sessions: 215 },
  lastSignals: null,
  lastRun: { at: null, ok: null, reason: '', error: null, spuriousRate: null, diff: null, material: null },
  updatedAt: 0,
}, null, 2), 'utf8')

// ── 真实 cordis Context + 最小服务 ────────────────────────────────────
const root = new Context()
const sections = []
root.provide('systemPrompt', {
  section(definition) {
    sections.push(definition)
    return () => {}
  },
})
const timers = []
root.provide('timer', {
  interval(callback, delay) {
    timers.push({ callback, delay })
    return () => {}
  },
})
const llmCalls = []
root.provide('llm', {
  async *stream(options) {
    llmCalls.push(options)
    const body = JSON.stringify({
      entries: [],
      unchangedIds: ['p1', 'p2', 'p3'],
      deletedIds: [],
      notes: 'e2e',
    })
    yield { type: 'text-delta', text: body }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

const { default: plugin } = await import('../lib/index.js')
plugin.apply(root, {
  stateDir,
  sessionsRoot,
  logLevel: 'error',
  scan: { scanOnStart: false, intervalMs: 60000, maxFramesPerScan: 400, maxWindowSize: 64 << 20 },
  profile: {
    provider: 'fake',
    model: 'fake',
    autoRun: true,
    triggerUserMessages: 12,
    triggerNewSessions: 3,
    maxEvidenceMessages: 400,
    maxMessageChars: 500,
    maxMaterialChars: 80000,
    maxTokens: 2000,
    timeoutMs: 5000,
  },
  inject: { budgetTokens: 1500, maxPinned: 10 },
})

const service = root.get('promptAdapt')
check('服务注册成功', !!service && typeof service.getState === 'function')
check('定时器已排程（scanOnStart=false 时仍会排）', timers.length >= 1, `timers=${timers.length}`)

function stateFile() {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
}
async function waitFor(condition, label, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    if (condition()) return true
    if (Date.now() - started > timeoutMs) {
      check(label, false, `超时 ${timeoutMs}ms`)
      return false
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// ── 第一次 tick：迁移 + 不生成 ────────────────────────────────────────
console.log('\nA. 第一次 tick：旧 state 迁移，且不因为负差不生成')
const firstTick = timers[0].callback()
await waitFor(() => stateFile().lastSignals !== null, '第一次 tick 完成')
await firstTick
{
  const state = stateFile()
  check('迁移写入了 materialCutoff（= 上一版 at）', state.lastGeneration.materialCutoff === BASE,
    `cutoff=${state.lastGeneration.materialCutoff}`)
  check('旧基线保留（首轮扫描受帧预算限制，下一次成功生成才重算）',
    state.lastGeneration.humanMessages === 524 && state.lastGeneration.sessions === 215,
    `humanMessages=${state.lastGeneration.humanMessages} sessions=${state.lastGeneration.sessions}`)
  check('没有触发 LLM（0 条新增，负差死锁已修）', llmCalls.length === 0, `calls=${llmCalls.length}`)
  check('lastSignals 里也没有子代理消息', state.lastSignals.totals.humanMessages === 15,
    `humanMessages=${state.lastSignals.totals.humanMessages}`)
}

// ── 追加 12 条新的真人消息 → 第二次 tick 应该真的生成 ─────────────────
console.log('\nB. 追加 12 条真人消息：触发一次生成，落账并推进截止时刻')
for (let index = 0; index < 12; index += 1) {
  writeFrame(mainFile, [human(100 + index, BASE + 1000 + index * 10, `main-new-${index}`)])
}
const secondTick = timers[0].callback()
await waitFor(() => llmCalls.length >= 1, '第二次 tick 触发 LLM')
await secondTick
await waitFor(() => stateFile().profile?.version === 6, '新版本落盘')
{
  const state = stateFile()
  check('LLM 被调用一次', llmCalls.length === 1, `calls=${llmCalls.length}`)
  check('画像版本推进到 6', state.profile?.version === 6, `version=${state.profile?.version}`)
  check('材料里没有子代理 prompt', !JSON.stringify(llmCalls[0]?.messages ?? []).includes('sub-prompt'),
    '含 sub-prompt 即失败')
  check('材料里有新的真人消息', JSON.stringify(llmCalls[0]?.messages ?? []).includes('main-new-11'))
  const newest = BASE + 1000 + 11 * 10
  check('截止时刻推进到最新消息时间', state.lastGeneration.materialCutoff === newest,
    `cutoff=${state.lastGeneration.materialCutoff} 期望=${newest}`)
  check('生成后基线 = 15 + 12 = 27', state.lastGeneration.humanMessages === 27,
    `humanMessages=${state.lastGeneration.humanMessages}`)
  const ledger = state.injectionLedger
  check('注入落账记录了这一版', ledger?.version === 6, `ledger.version=${ledger?.version}`)
  check('落账的 ids 与注入计划一致',
    JSON.stringify(ledger?.ids ?? []) === JSON.stringify(service.getState().injection.injectedIds ?? []),
    JSON.stringify(ledger?.ids))
  check('落账计数 p1..p3 都 >= 1',
    ['p1', 'p2', 'p3'].every(id => (ledger?.counts?.[id] ?? 0) >= 1),
    JSON.stringify(ledger?.counts))
}

// ── 模式 2：不自动生成、不记假账 ─────────────────────────────────────
console.log('\nC. 切到自定义模式：定时器不再自动生成（画像不进 prompt，生成了也是白烧）')
service.setMode('custom')
check('模式已切到 custom', service.getState().mode === 'custom')
for (let index = 0; index < 12; index += 1) {
  writeFrame(mainFile, [human(200 + index, BASE + 5000 + index * 10, `main-custom-${index}`)])
}
const customTick = timers[0].callback()
await customTick
await new Promise(resolve => setTimeout(resolve, 300))
check('custom 模式下没有调用 LLM', llmCalls.length === 1, `calls=${llmCalls.length}`)
check('画像版本没有推进', stateFile().profile?.version === 6, `version=${stateFile().profile?.version}`)

console.log('\nD. 切回自动模式：积压的 12 条真人消息照常触发，账本继续累加')
service.setMode('auto')
const autoTick = timers[0].callback()
await waitFor(() => llmCalls.length >= 2, '切回 auto 后触发 LLM')
await autoTick
await waitFor(() => stateFile().profile?.version === 7, 'v7 落盘')
{
  const state = stateFile()
  check('LLM 被调用第二次', llmCalls.length === 2, `calls=${llmCalls.length}`)
  check('画像版本推进到 7', state.profile?.version === 7, `version=${state.profile?.version}`)
  check('账本身份跟着版本走', state.injectionLedger?.version === 7,
    `ledger.version=${state.injectionLedger?.version}`)
  check('p1..p3 的累计计数增加到 3',
    ['p1', 'p2', 'p3'].every(id => state.injectionLedger?.counts?.[id] === 3),
    JSON.stringify(state.injectionLedger?.counts))
}

console.log('\n========================================================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`临时目录：${TMP_ROOT}`)
console.log('========================================================================')
if (fail > 0) process.exitCode = 1
