/**
 * 饱和守卫自检：画像已到增长上限、且连续两轮 0 变更时，自动生成必须停下，
 * 而不是每 12 条发言/3 个会话白烧一次 LLM；用户整理（pin/seal/delete）后
 * `zeroChangeStreak` 清零，自动生成重新尝试。
 *
 * 夹具刻意做成"真实宿主会遇到的最坏形状"：
 *   · 画像 44 条（刚好软上限），新增一定会被拒；
 *   · `lastRun.diff` 三项全 0，`zeroChangeStreak = 2`；
 *   · 12 条新真人发言已经越过 `materialCutoff` —— 触发判据本身是 due 的，
 *     唯一能拦住生成的就是饱和守卫。
 *
 * 运行：node test/saturation-guard.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-saturation-'))
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

const BASE = Date.now() - 3_600_000
const CUTOFF = BASE
const entries = Array.from({ length: 44 }, (_, index) => ({
  id: `e${index + 1}`,
  category: ['A', 'B', 'C'][index % 3],
  claim: `饱和夹具条目 ${index + 1}：不要做无意义的事。`,
  evidence: [`[${index + 1}] 夹具`],
  confidence: 'medium',
  evidenceQuoteCount: 2,
  timesSeen: 1,
  firstSeenAt: BASE,
  lastSeenAt: BASE,
}))

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
for (let index = 0; index < 12; index += 1) {
  writeFrame(mainFile, [human(index + 1, BASE + 1000 + index * 10, `main-new-${index}`)])
}

fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
  version: 1,
  mode: 'auto',
  customText: '',
  profile: {
    version: 5,
    generatedAt: BASE,
    provider: 'fake',
    model: 'fake',
    evidenceMessages: 400,
    entries,
    notes: '',
    raw: '',
  },
  autoExtraText: '',
  entryMarks: [],
  workingNotes: [],
  copiedSnapshot: { text: null, at: null, profileVersion: null },
  lastGeneration: { at: BASE, humanMessages: 0, sessions: 0, materialCutoff: CUTOFF },
  lastSignals: null,
  // 连续两轮 0 变更：守卫必须停。
  lastRun: {
    at: BASE,
    ok: true,
    reason: '',
    error: null,
    spuriousRate: 0,
    diff: { added: 0, removed: 0, modified: 0, unchanged: 44 },
    material: null,
  },
  zeroChangeStreak: 2,
  updatedAt: 0,
}, null, 2), 'utf8')

const root = new Context()
const timers = []
root.provide('systemPrompt', { section: () => () => {} })
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
      unchangedIds: entries.map(entry => entry.id),
      deletedIds: [],
      notes: 'saturation fixture',
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

console.log('A. 画像 44 条 + 连续 2 轮 0 变更：自动生成必须被守卫拦住')
const firstTick = timers[0].callback()
await waitFor(() => stateFile().lastSignals !== null, '第一次 tick 完成')
await firstTick
await new Promise(resolve => setTimeout(resolve, 200))
{
  const state = stateFile()
  check('没有调用 LLM（触发判据 due，但饱和守卫先停）', llmCalls.length === 0,
    `calls=${llmCalls.length}`)
  check('lastRun 记录了暂停原因', String(state.lastRun?.reason).includes('暂停自动生成'),
    String(state.lastRun?.reason))
  check('原因里带上了条目数与连续轮数',
    String(state.lastRun?.reason).includes('44 条') && String(state.lastRun?.reason).includes('2 轮'),
    String(state.lastRun?.reason))
  check('zeroChangeStreak 保持 2', state.zeroChangeStreak === 2, `streak=${state.zeroChangeStreak}`)
  const view = service.getState()
  check('界面契约暴露了 capacity.saturated', view.profileCapacity?.saturated === true)
  check('capacity.entries = 44', view.profileCapacity?.entries === 44,
    `entries=${view.profileCapacity?.entries}`)
}

console.log('\nB. 用户置顶一条：zeroChangeStreak 清零，自动生成重新尝试')
const pinned = service.pinEntry('e1')
check('pinEntry 成功', pinned?.ok === true, JSON.stringify(pinned))
check('pin 之后 streak 清零', stateFile().zeroChangeStreak === 0,
  `streak=${stateFile().zeroChangeStreak}`)

const secondTick = timers[0].callback()
await waitFor(() => llmCalls.length >= 1, '清零后第二次 tick 触发 LLM')
await secondTick
await waitFor(() => stateFile().profile?.version === 6, '新版本落盘')
{
  const state = stateFile()
  check('LLM 被调用一次', llmCalls.length === 1, `calls=${llmCalls.length}`)
  check('画像版本推进到 6', state.profile?.version === 6, `version=${state.profile?.version}`)
  check('这一次 0 变更，streak 回到 1', state.zeroChangeStreak === 1,
    `streak=${state.zeroChangeStreak}`)
  check('44 条仍在（pin 不释放槽位）', state.profile?.entries?.length === 44,
    `entries=${state.profile?.entries?.length}`)
}

console.log('\nC. 再连续一轮 0 变更后，守卫再次生效')
// 追加 12 条新发言，再跑一轮；streak 从 1 → 2，下一轮才会停。
for (let index = 0; index < 12; index += 1) {
  writeFrame(mainFile, [human(100 + index, BASE + 10_000 + index * 10, `main-next-${index}`)])
}
const thirdTick = timers[0].callback()
await waitFor(() => llmCalls.length >= 2, '第三次 tick 触发 LLM')
await thirdTick
await waitFor(() => stateFile().zeroChangeStreak === 2, 'streak 回到 2')
check('连续第二轮 0 变更后 streak=2', stateFile().zeroChangeStreak === 2,
  `streak=${stateFile().zeroChangeStreak}`)

for (let index = 0; index < 12; index += 1) {
  writeFrame(mainFile, [human(300 + index, BASE + 20_000 + index * 10, `main-after-${index}`)])
}
const fourthTick = timers[0].callback()
await fourthTick
await new Promise(resolve => setTimeout(resolve, 200))
{
  const state = stateFile()
  check('第二轮 0 变更后，下一次自动生成被停住', llmCalls.length === 2,
    `calls=${llmCalls.length}`)
  check('暂停原因再次写入 lastRun', String(state.lastRun?.reason).includes('暂停自动生成'),
    String(state.lastRun?.reason))
}

console.log('\n' + '='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))
process.exitCode = fail === 0 ? 0 : 1
