/**
 * 落账 × 处置动作的端到端：生成 → 封印 → 解封 → 查账本。
 *
 * 为什么需要这个文件：`test/p0-e2e.mjs` 只测到 `setMode`，`test/injection-ledger.mjs`
 * 只测 `StateStore` 纯逻辑。"封印腾出预算 → 原本被截掉的条目进入注入 → 账本补记"
 * 这条链子跨 `markEntry`、`syncInjectionLedger`、`planProfileInjection` 三处，
 * 没有任何一个测试在真实 apply 上下文中走过它。
 *
 * 这里钉的是：
 *   1. 生成后账本记下这一版交付集合（约 13 条）
 *   2. 封印一条已交付条目 → 注入集合变化 → 新进集合被补记（count=1）
 *   3. 解封 → 条目写回画像、账本不丢计数（并集语义），版本不变
 *   4. `clearProfile()` 清空画像的同时清空账本（否则短 id 复用会继承旧计数）
 *
 * 运行： node test/mark-ledger.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mark-ledger-'))
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
function writeFrame(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
}

const mainFile = path.join(sessionsRoot, 'proj', 'main-session', 'session.v4.jsonl.zstd')
writeFrame(mainFile, [{
  type: 'session',
  version: 4,
  id: 'main-session',
  createdAt: BASE - 60_000,
  cwd: TMP_ROOT,
  origin: 'main',
}])
for (let index = 0; index < 15; index += 1) {
  writeFrame(mainFile, [human(index + 1, BASE - 1000 + index * 10, `human-${index}`)])
}

/** 25 条 A 类条目：A 上限 750，大约只会注入 13 条 —— 给"封印腾预算"留下空间。 */
const entries = Array.from({ length: 25 }, (_, index) => ({
  id: `a${index}`,
  category: 'A',
  claim: `用户在这类任务里的一贯做法第 ${index} 条，正文撑到与真实画像同量级，好让预算被吃紧。`,
  evidence: ['e'],
  confidence: 'medium',
  evidenceQuoteCount: 3,
  timesSeen: 2,
  firstSeenAt: BASE - 10_000,
  lastSeenAt: BASE,
}))
fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
  version: 1,
  mode: 'auto',
  customText: '',
  profile: { version: 5, generatedAt: BASE, provider: 'fake', model: 'fake', evidenceMessages: 15, entries },
  autoExtraText: '',
  entryMarks: [],
  copiedSnapshot: { text: null, at: null, profileVersion: null },
  lastGeneration: { at: BASE, humanMessages: 15, sessions: 1, materialCutoff: BASE - 5000 },
  lastSignals: null,
  lastRun: { at: null, ok: null, reason: '', error: null, spuriousRate: null, diff: null, material: null },
  updatedAt: 0,
}, null, 2), 'utf8')

const root = new Context()
const sections = []
root.provide('systemPrompt', { section(definition) { sections.push(definition); return () => {} } })
const timers = []
root.provide('timer', { interval(callback) { timers.push(callback); return () => {} } })
let llmCalls = 0
root.provide('llm', {
  async *stream() {
    llmCalls += 1
    yield {
      type: 'text-delta',
      text: JSON.stringify({
        entries: [],
        unchangedIds: entries.map(entry => entry.id),
        deletedIds: [],
        notes: 'mark-ledger',
      }),
    }
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
    maxTokens: 4000,
    timeoutMs: 5000,
  },
  inject: { budgetTokens: 1500, maxPinned: 10 },
})
const service = root.get('promptAdapt')
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

console.log('\nA. 生成一版：账本记下这一版交付集合')
await timers[0]()
await waitFor(() => service.getState().profile?.version === 6, 'v6 生成')
{
  const state = service.getState()
  const injected = state.injection.injectedIds
  check('LLM 被调用一次', llmCalls === 1, `calls=${llmCalls}`)
  check('画像到 v6', state.profile.version === 6, `version=${state.profile.version}`)
  check('注入集合吃紧（有条目被预算省略）',
    injected.length >= 10 && injected.length < 25 && state.injection.omittedEntries >= 1,
    `len=${injected.length} omitted=${state.injection.omittedEntries}`)
  check('账本版本 = 6', state.injectionLedger.version === 6, `ledger.version=${state.injectionLedger.version}`)
  check('账本 ids 与当前注入集合一致',
    JSON.stringify(state.injectionLedger.ids) === JSON.stringify(injected),
    JSON.stringify(state.injectionLedger.ids))
  check('账本计数里每条注入条目 >= 1',
    injected.every(id => (state.injectionLedger.counts[id] ?? 0) >= 1))
}

console.log('\nB. 封印一条已交付条目：新进集合被补记')
const before = service.getState().injection.injectedIds.slice()
const sealedId = before[0]
const sealedClaim = service.getState().profile.entries.find(entry => entry.id === sealedId)?.claim
const sealResult = service.sealEntry(sealedId, sealedClaim)
const after = service.getState().injection.injectedIds.slice()
const entered = after.filter(id => !before.includes(id))
{
  check('封印成功', sealResult?.ok === true, JSON.stringify(sealResult))
  check('注入集合真的变了（有除封印之外的新条目进入）', entered.length >= 1,
    `entered=${JSON.stringify(entered)}`)
  const ledger = service.getState().injectionLedger
  check('新进集合被补记进账本', entered.every(id => ledger.ids.includes(id)),
    `ledger.ids=${JSON.stringify(ledger.ids)}`)
  check('新进集合的计数是 1', entered.every(id => ledger.counts[id] === 1),
    JSON.stringify(Object.fromEntries(entered.map(id => [id, ledger.counts[id]]))))
  check('被封条目的旧计数不删（并集语义）', (ledger.counts[sealedId] ?? 0) >= 1,
    `count=${ledger.counts[sealedId]}`)
  check('版本不变（同一版内补记）', ledger.version === 6, `version=${ledger.version}`)
}

console.log('\nC. 解封：条目写回画像，账本不丢计数')
const sealedMark = service.getState().entryMarks.find(mark => mark.status === 'sealed')
const unsealResult = sealedMark ? service.clearMark(sealedMark.key) : { ok: false }
{
  check('解封成功', unsealResult?.ok === true, JSON.stringify(unsealResult))
  const state = service.getState()
  check('被封条目回到画像正文',
    state.profile.entries.some(entry => entry.id === sealedId))
  const ledger = state.injectionLedger
  check('解封后账本仍保留被封条目的计数', (ledger.counts[sealedId] ?? 0) >= 1)
  check('账本版本仍是 6', ledger.version === 6, `version=${ledger.version}`)
  check('账本不因为解封而回退（并集只增不减）',
    entered.every(id => ledger.ids.includes(id)), JSON.stringify(entered))
}

console.log('\nD. clearProfile：画像与账本一起清空（短 id 复用不再继承旧计数）')
service.clearProfile()
{
  const state = service.getState()
  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
  check('画像被清空', state.profile === null)
  check('账本版本清空', state.injectionLedger.version === null,
    `version=${state.injectionLedger.version}`)
  check('账本 identity 清空（落盘对象）', persisted.injectionLedger.identity === null,
    `identity=${persisted.injectionLedger.identity}`)
  check('counts 清空', Object.keys(state.injectionLedger.counts).length === 0,
    JSON.stringify(state.injectionLedger.counts))
  check('frozenCounts 清空（落盘对象）',
    Object.keys(persisted.injectionLedger.frozenCounts).length === 0,
    JSON.stringify(persisted.injectionLedger.frozenCounts))
}

console.log('\n========================================================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`临时目录：${TMP_ROOT}`)
console.log('========================================================================')
if (fail > 0) process.exitCode = 1
