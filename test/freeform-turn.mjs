/**
 * 回归：`countFreeformAnswers` 的位置约束 + `countLongTools` 的并发判定。
 *
 * ## 这个测试盯住的两件事
 *
 * ### 1. 位置约束曾经是**死代码**（本次修掉）
 *
 * 真实日志里 `user/message` 的 `data` **就是** message 本身，键只有
 * `content/source/role/id` —— 没有 `turn`；而 `turn/start` / `assistant/message` /
 * `tool/call` / `tool/result` 都带 `data.turn`。所以归一化后**真人发言的 turn
 * 恒为 null**，旧判据里那句 `candidate.turn !== null` 永远为假：
 * 位置约束一次都没生效，"用户直接换了个新话题"被误计成
 * "给了选项但用户自己另说"。
 *
 * 本测试**不手捏归一化后的形状**，而是照真实日志的字段形状写原始事件
 * （`user/message` 的 data 就是 message；tool/call 带 callId/name/arguments；
 * tool/result 的 callId 在 `data.message.source.callId`），再走**真正的**
 * `normalizeInto()` —— 这样"user/message 的 turn 是 null"是被复现出来的，
 * 不是被假设出来的。
 *
 * 同时，本文件里逐字保留了**修复前的判据**（`countFreeformAnswersLegacy` /
 * `countLongToolsLegacy`），对同一批事件跑两边，把"修复前会误计几条、修复后
 * 几条"作为数字打出来。
 *
 * ### 2. `countLongTools` 的并发判定换实现后必须**逐字等价**
 *
 * 旧实现靠 `events.indexOf(call)` / `indexOf(result)` 反查区间，是每次判定两遍
 * 全数组扫描；新实现直接用主循环下标。行为必须一模一样，包括
 * `concurrentSkipped` 的数字 —— 下面用一个确切的并发序列 + 300 组伪随机序列
 * （固定种子，可复现）做逐字段比对。
 *
 * 本测试**纯内存**：不读会话日志、不写任何文件、不碰 DSH_HOME。
 *
 * 运行：
 *   node test/freeform-turn.mjs
 */
import { normalizeInto } from '../lib/sessions.js'
import {
  DEFAULT_ANSWER_WINDOW_MS,
  computeAllSignals,
  computeSessionSignals,
  countDelegateRuns,
  countFreeformAnswers,
  countLongTools,
  isHumanMessage,
} from '../lib/signals.js'

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

const OPTIONS = {
  answerWindowMs: 1800000, // 30 分钟，与默认配置一致
  longToolMs: 60000,
  humanWaitTools: ['ask_user_question'],
  repeatFailMin: 3,
  delegatePatterns: [],
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实形状的原始事件工厂（字段名照抄日志，见 lib/sessions.js 的归一化说明）
// ─────────────────────────────────────────────────────────────────────────────
let seq = 0
function resetSeq() {
  seq = 0
}

/** `user/message`：data **就是** message（含 role/content/source），没有 turn。 */
function rawUserMessage(text, time, sourceKind = 'user') {
  return {
    type: 'user/message',
    seq: seq++,
    time,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: sourceKind },
      role: 'user',
      id: `msg-${seq}`,
    },
  }
}

/** `turn/start`：data 只有 turn。 */
function rawTurnStart(turn, time) {
  return { type: 'turn/start', seq: seq++, time, data: { turn } }
}

function rawTurnEnd(turn, time) {
  return { type: 'turn/end', seq: seq++, time, data: { turn, reason: 'done' } }
}

function rawAssistantMessage(turn, text, time) {
  return {
    type: 'assistant/message',
    seq: seq++,
    time,
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

/** `tool/call`：callId 在 data.callId，工具名在 data.name，入参是 JSON 字符串。 */
function rawToolCall(turn, callId, name, args, time) {
  return {
    type: 'tool/call',
    seq: seq++,
    time,
    data: { turn, step: 1, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  }
}

/** `tool/result`：callId 在 `data.message.source.callId`（不在 data.toolCallId）。 */
function rawToolResult(turn, callId, time, isError = false) {
  return {
    type: 'tool/result',
    seq: seq++,
    time,
    data: {
      turn,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [],
        isError,
        id: `res-${callId}-${seq}`,
      },
    },
  }
}

function askArgs(labels, { withOptions = true } = {}) {
  return {
    questions: [
      {
        id: 'q1',
        header: '确认',
        question: '怎么做？',
        ...(withOptions ? { options: labels.map(label => ({ label, description: '' })) } : {}),
      },
    ],
  }
}

/** 走**真正的**归一化，得到与 `bySession()` 同形状的事件数组。 */
function normalize(rawEvents) {
  const events = []
  normalizeInto(events, rawEvents, 'session-fixture', 0)
  return events
}

// ─────────────────────────────────────────────────────────────────────────────
// 修复前的判据（逐字副本，只用于产出"修复前"的数字；被测代码不含这两段）
// ─────────────────────────────────────────────────────────────────────────────

/** 修复前的 `countFreeformAnswers`：位置约束里那句 `candidate.turn !== null` 恒假。 */
function countFreeformAnswersLegacy(events, options) {
  const window = options.answerWindowMs
  const matches = []
  let considered = 0

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.type !== 'tool/call' || event.toolName !== 'ask_user_question') continue
    const raw = event.data?.arguments
    if (typeof raw !== 'string') continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const labels = []
    for (const question of parsed?.questions ?? []) {
      for (const option of question?.options ?? []) {
        if (typeof option?.label === 'string' && option.label.trim()) labels.push(option.label.trim())
      }
    }
    if (labels.length === 0) continue

    const askTurn = event.turn

    let human = null
    for (let j = i + 1; j < events.length; j++) {
      const candidate = events[j]
      if (candidate.type !== 'user/message') continue
      if (!isHumanMessage(candidate)) continue
      if (askTurn !== null && candidate.turn !== null && candidate.turn !== askTurn) {
        let crossedTurnBoundary = false
        for (let k = i + 1; k < j; k++) {
          if (events[k].type === 'turn/start') {
            crossedTurnBoundary = true
            break
          }
        }
        if (crossedTurnBoundary) continue
      }
      human = candidate
      break
    }
    if (!human) continue
    if (event.time !== null && human.time !== null && human.time - event.time > window) continue

    considered += 1
    const text = (human.message?.content ?? [])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (!text) continue
    const picked = labels.some(label => text === label || text.includes(label) || label.includes(text))
    if (!picked) {
      matches.push({ turn: event.turn, time: human.time, offered: labels, said: text.slice(0, 200) })
    }
  }
  return { count: matches.length, matches, considered }
}

/** 修复前的并发判定：用 `events.indexOf()` 反查区间。 */
function hasOtherCallBetweenLegacy(events, call, result) {
  const startIndex = events.indexOf(call)
  const endIndex = events.indexOf(result)
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return false
  for (let i = startIndex + 1; i < endIndex; i++) {
    const type = events[i].type
    if (type === 'tool/call') return true
    if (type === 'turn/start') return true
  }
  return false
}

/** 修复前的 `countLongTools`（除并发判定外的逻辑逐字保留）。 */
function countLongToolsLegacy(events, options) {
  const threshold = options.longToolMs
  const excluded = new Set(options.humanWaitTools ?? [])
  const callEvent = new Map()
  const matches = []
  const humanWait = []
  let unpaired = 0
  let concurrentSkipped = 0

  for (const event of events) {
    if (event.type === 'tool/call' && event.callId) {
      callEvent.set(event.callId, event)
      continue
    }
    if (event.type !== 'tool/result') continue
    if (!event.callId) {
      unpaired += 1
      continue
    }
    const call = callEvent.get(event.callId)
    if (!call || call.time === null || event.time === null) {
      unpaired += 1
      continue
    }
    const durationMs = event.time - call.time
    if (durationMs <= threshold) continue
    if (hasOtherCallBetweenLegacy(events, call, event)) {
      concurrentSkipped += 1
      continue
    }
    const record = { turn: event.turn, time: event.time, tool: call.toolName, durationMs }
    if (call.toolName && excluded.has(call.toolName)) humanWait.push(record)
    else matches.push(record)
  }
  return { count: matches.length, matches, humanWait, unpaired, concurrentSkipped }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log('1. 根因复现：真实形状经 normalizeInto 之后，真人发言的 turn 是 null')
console.log('='.repeat(72))
{
  resetSeq()
  const events = normalize([
    rawTurnStart(1, 1000),
    rawAssistantMessage(1, '我可以帮你安装…', 1100),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['能看到', '看不到']), 1200),
    rawToolResult(1, 'ask-1', 1300),
    rawUserMessage('总结一下为了成功安装，你做的关键步骤', 500000),
    rawTurnEnd(1, 501000),
  ])

  const humans = events.filter(isHumanMessage)
  const call = events.find(e => e.type === 'tool/call')
  const turnStart = events.find(e => e.type === 'turn/start')
  const result = events.find(e => e.type === 'tool/result')

  check('user/message 归一化后 turn 是 null（data 里没有 turn 字段）',
    humans.length === 1 && humans[0].turn === null, `turn=${JSON.stringify(humans[0]?.turn)}`)
  check('user/message 的 data **就是** message（有 content/source/role，没有 turn）',
    Array.isArray(humans[0]?.data?.content) && humans[0]?.data?.source?.kind === 'user' &&
      !('turn' in (humans[0]?.data ?? {})), `data 的键=${Object.keys(humans[0]?.data ?? {}).join(',')}`)
  check('turn/start 的 turn 非 null', turnStart?.turn === 1, `turn=${turnStart?.turn}`)
  check('tool/call 的 turn 非 null 且 callId/toolName 都取到了',
    call?.turn === 1 && call?.callId === 'ask-1' && call?.toolName === 'ask_user_question',
    `turn=${call?.turn} callId=${call?.callId}`)
  check('tool/result 的 callId 从 data.message.source.callId 取到（top-level 没有）',
    result?.callId === 'ask-1' && result?.data?.toolCallId === undefined,
    `callId=${result?.callId}`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log('2. 位置约束：跨 turn 边界 vs 同轮（场景 a–e）')
console.log('='.repeat(72))

// (a) 换话题：提问之后跨了 turn 边界才发言 → 不计入
{
  resetSeq()
  const events = normalize([
    rawTurnStart(1, 1000),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['能看到 LiteLoaderQQNT 吗？', '看不到', '有选项但里面不对']), 1200),
    rawToolResult(1, 'ask-1', 1300),
    rawTurnEnd(1, 2000),
    rawTurnStart(2, 60000),
    rawUserMessage('总结一下为了成功安装，你做的关键步骤', 61000),
    rawTurnEnd(2, 62000),
  ])
  const now = countFreeformAnswers(events, OPTIONS)
  const before = countFreeformAnswersLegacy(events, OPTIONS)
  check('(a) 跨 turn 边界的换话题不计入', now.count === 0, `count=${now.count}`)
  check('(a) 交叉验证：修复前同一序列会误计 1 条（说明 bug 真的复现了）',
    before.count === 1, `修复前 count=${before.count}`)
  check('(a) 换话题连 considered 都不该增加（它压根不是对这条提问的回答）',
    now.considered === 0, `considered=${now.considered}`)
}

// (b) 同一轮内用户自己另说 → 计入
{
  resetSeq()
  const events = normalize([
    rawTurnStart(1, 1000),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['标准安装，我会点 UAC「是」（推荐）', '纯用户级安装，不要任何弹窗']), 1200),
    rawToolResult(1, 1300),
    rawUserMessage('我已经手动进行安装了', 519000),
    rawTurnEnd(1, 520000),
  ])
  const now = countFreeformAnswers(events, OPTIONS)
  check('(b) 同轮内自己另说计入', now.count === 1, `count=${now.count}`)
  check('(b) considered 增加 1', now.considered === 1, `considered=${now.considered}`)
  check('(b) 明细里带上被提供的选项与用户原话',
    now.matches[0]?.offered?.length === 2 && now.matches[0]?.said === '我已经手动进行安装了',
    `said=${JSON.stringify(now.matches[0]?.said)}`)
}

// (c) 用户点了某个选项 label（全等 / 包含 / 被包含）→ 不计入，但 considered +1
{
  resetSeq()
  const events = normalize([
    rawTurnStart(1, 1000),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['关闭 QQ 并安装（推荐）', '只安装，不自动启动 QQ']), 1200),
    rawToolResult(1, 1300),
    rawUserMessage('关闭 QQ 并安装（推荐）', 1400),
    // 第二条提问与回答：包含 label（点击后补一句说明）
    rawToolCall(1, 'ask-2', 'ask_user_question', askArgs(['只安装，不自动启动 QQ']), 1500),
    rawToolResult(1, 'ask-2', 1600),
    rawUserMessage('我选「只安装，不自动启动 QQ」，别动别的', 1700),
    rawTurnEnd(1, 2000),
  ])
  const now = countFreeformAnswers(events, OPTIONS)
  check('(c) label 全等不计入、label 被包含也不计入', now.count === 0, `count=${now.count}`)
  check('(c) 两次提问都算"考虑过"（considered=2）', now.considered === 2, `considered=${now.considered}`)
}

// (d) 没给 options 的 ask_user_question → 不参与（considered 不增加）
{
  resetSeq()
  const events = normalize([
    rawTurnStart(1, 1000),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs([], { withOptions: false }), 1200),
    rawToolResult(1, 1300),
    rawToolCall(1, 'ask-2', 'ask_user_question', askArgs([]), 1400),
    rawToolResult(1, 'ask-2', 1500),
    rawUserMessage('我自己看着办的', 1600),
    rawTurnEnd(1, 2000),
  ])
  const now = countFreeformAnswers(events, OPTIONS)
  check('(d) 没给选项的提问不参与本判据', now.count === 0 && now.considered === 0,
    `count=${now.count} considered=${now.considered}`)
}

// (e) 时间窗：超过 answerWindowMs 不计入；恰好等于窗口仍计入
{
  resetSeq()
  const beyond = normalize([
    rawTurnStart(1, 0),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1000),
    rawToolResult(1, 1100),
    rawUserMessage('我自己另说的', 1000 + OPTIONS.answerWindowMs + 1),
    rawTurnEnd(1, 2000000),
  ])
  const exactly = normalize([
    rawTurnStart(1, 0),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1000),
    rawToolResult(1, 1100),
    rawUserMessage('我自己另说的', 1000 + OPTIONS.answerWindowMs),
    rawTurnEnd(1, 2000000),
  ])
  const nowBeyond = countFreeformAnswers(beyond, OPTIONS)
  const nowExactly = countFreeformAnswers(exactly, OPTIONS)
  check('(e) 超过 answerWindowMs 不计入', nowBeyond.count === 0 && nowBeyond.considered === 0,
    `count=${nowBeyond.count} considered=${nowBeyond.considered}`)
  check('(e) 恰好等于窗口（未超过）仍计入（边界不被放宽）',
    nowExactly.count === 1, `count=${nowExactly.count}`)
}

// (f) 本地兜底只在 `event.turn === null` 时生效 —— 外部（sessions.js 侧按位置
//     补 turn 的那个修复）已经补过的输入必须**原样保留**，否则两个正交的修复
//     会互相打架。
{
  // f1：真人发言被外部标成提问轮 7，而它前面确实有一条 turn/start(8)。
  //     如果兜底覆盖了外部的值（currentTurn=8），这条会被判成"跨轮换话题"而排除；
  //     保留外部的 7 则仍是同轮回答。
  resetSeq()
  const preserved = normalize([
    rawTurnStart(7, 0),
    rawToolCall(7, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1000),
    rawToolResult(7, 'ask-1', 1100),
    rawTurnStart(8, 2000),
    rawUserMessage('我自己另说的', 3000),
  ])
  for (const event of preserved) if (event.type === 'user/message') event.turn = 7
  const preservedNow = countFreeformAnswers(preserved, OPTIONS)
  check('(f) 外部补过的 turn 不被本地兜底覆盖（仍是同轮 → 计入）',
    preservedNow.count === 1 && preservedNow.considered === 1,
    `count=${preservedNow.count} considered=${preservedNow.considered}`)

  // f2：外部补了个"不同的轮号"，但提问与发言之间没有 turn/start →
  //     边界判据看的是"有没有 turn/start"，不是轮号差（与旧判据一致）。
  resetSeq()
  const noBoundary = normalize([
    rawTurnStart(7, 0),
    rawToolCall(7, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1000),
    rawToolResult(7, 'ask-1', 1100),
    rawUserMessage('我自己另说的', 3000),
  ])
  for (const event of noBoundary) if (event.type === 'user/message') event.turn = 8
  const noBoundaryNow = countFreeformAnswers(noBoundary, OPTIONS)
  const noBoundaryBefore = countFreeformAnswersLegacy(noBoundary, OPTIONS)
  check('(f) 没有 turn/start 就不算跨轮（与修复前判据一致）',
    noBoundaryNow.count === 1 && noBoundaryBefore.count === 1,
    `新=${noBoundaryNow.count} 修复前=${noBoundaryBefore.count}`)
}

// (g) 整段日志都没有轮号信息（例如第一帧被截断）时，位置约束不该凭空生效
{
  resetSeq()
  const events = normalize([
    rawAssistantMessage(null, '要装吗？', 1000),
    rawToolCall(null, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1200),
    rawToolResult(null, 'ask-1', 1300),
    rawUserMessage('我自己另说的', 1400),
  ])
  const now = countFreeformAnswers(events, OPTIONS)
  const before = countFreeformAnswersLegacy(events, OPTIONS)
  check('(g) 提问与发言都没有轮号时仍然计入（与修复前一致，没有凭空造出跨轮）',
    now.count === 1 && before.count === 1, `新=${now.count} 修复前=${before.count}`)
}

// (h) 多条提问的计数口径（T8 复核）：同一个 turn 里多次 ask、以及两条提问共享
//     同一条真人发言 —— `considered` 与 `matches` 必须与修复前的语义逐条一致。
{
  // h1：同一个 turn 里两次提问，共享同一条真人发言（用户自己另说）→ 两次都计入。
  //     修复前的实现是"每条提问各自向后找下一条真人发言"，所以共享是允许的；
  //     索引化之后仍然允许（每条提问各自 firstAfter）。
  resetSeq()
  const shared = normalize([
    rawTurnStart(1, 1000),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1200),
    rawToolResult(1, 'ask-1', 1300),
    rawToolCall(1, 'ask-2', 'ask_user_question', askArgs(['选项丙', '选项丁']), 1400),
    rawToolResult(1, 'ask-2', 1500),
    rawUserMessage('我自己另说的', 1600),
    rawTurnEnd(1, 2000),
  ])
  const sharedNow = countFreeformAnswers(shared, OPTIONS)
  const sharedBefore = countFreeformAnswersLegacy(shared, OPTIONS)
  console.log(`  —— 同轮两次提问共享同一条发言：修复前 count=${sharedBefore.count}/considered=${sharedBefore.considered}` +
    ` → 修复后 count=${sharedNow.count}/considered=${sharedNow.considered}`)
  check('(h1) 同轮两次提问共享同一条"自己另说"的发言：两条都计入（与修复前一致）',
    sharedNow.count === 2 && sharedNow.considered === 2 &&
      sharedBefore.count === 2 && sharedBefore.considered === 2,
    `新 ${sharedNow.count}/${sharedNow.considered} vs 修复前 ${sharedBefore.count}/${sharedBefore.considered}`)

  // h2：同上，但共享的那条发言命中了 label → 两条都"考虑过"，都不计入。
  resetSeq()
  const sharedPicked = normalize([
    rawTurnStart(1, 1000),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1200),
    rawToolResult(1, 'ask-1', 1300),
    rawToolCall(1, 'ask-2', 'ask_user_question', askArgs(['选项甲', '选项丙']), 1400),
    rawToolResult(1, 'ask-2', 1500),
    rawUserMessage('选项甲', 1600),
    rawTurnEnd(1, 2000),
  ])
  const pickedNow = countFreeformAnswers(sharedPicked, OPTIONS)
  const pickedBefore = countFreeformAnswersLegacy(sharedPicked, OPTIONS)
  console.log(`  —— 同轮两次提问共享同一条"选了选项"的发言：修复前 count=${pickedBefore.count}/considered=${pickedBefore.considered}` +
    ` → 修复后 count=${pickedNow.count}/considered=${pickedNow.considered}`)
  check('(h2) 共享的发言命中 label：considered=2、count=0（与修复前一致）',
    pickedNow.count === 0 && pickedNow.considered === 2 &&
      pickedBefore.count === 0 && pickedBefore.considered === 2,
    `新 ${pickedNow.count}/${pickedNow.considered} vs 修复前 ${pickedBefore.count}/${pickedBefore.considered}`)

  // h3：同轮里"提问→发言→提问→发言"两对独立配对（不该因为索引化而互相串台）。
  resetSeq()
  const pairs = normalize([
    rawTurnStart(1, 1000),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1200),
    rawToolResult(1, 'ask-1', 1300),
    rawUserMessage('第一句我自己说的', 1400),
    rawToolCall(1, 'ask-2', 'ask_user_question', askArgs(['选项丙', '选项丁']), 1500),
    rawToolResult(1, 'ask-2', 1600),
    rawUserMessage('选项丙', 1700),
    rawTurnEnd(1, 2000),
  ])
  const pairsNow = countFreeformAnswers(pairs, OPTIONS)
  const pairsBefore = countFreeformAnswersLegacy(pairs, OPTIONS)
  console.log(`  —— 同轮两对独立配对：修复前 count=${pairsBefore.count}/considered=${pairsBefore.considered}` +
    ` → 修复后 count=${pairsNow.count}/considered=${pairsNow.considered}`)
  check('(h3) 同轮两对独立配对：第一条计入、第二条命中 label → count=1/considered=2（与修复前一致）',
    pairsNow.count === 1 && pairsNow.considered === 2 &&
      pairsBefore.count === 1 && pairsBefore.considered === 2,
    `新 ${pairsNow.count}/${pairsNow.considered} vs 修复前 ${pairsBefore.count}/${pairsBefore.considered}`)
  check('(h3) 命中的正是第一句（比对明细文本，不只看数字）',
    pairsNow.matches[0]?.said === '第一句我自己说的', JSON.stringify(pairsNow.matches.map(m => m.said)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log('3. 真实形状的综合会话：修复前会误计几条 / 修复后几条')
console.log('='.repeat(72))
{
  // 四个带选项的提问，形状照抄真实日志（含真实措辞）：
  //   ① turn 1 内用户自己另说（"我已经手动进行安装了"）→ 两边都该计入
  //   ② turn 2 的提问，用户跨到 turn 3 才发言（粘贴 GitHub 链接）→ 换话题
  //   ③④ turn 3 的两次提问，用户跨到 turn 4 才发言（要求删军训内容）→ 换话题
  resetSeq()
  const events = normalize([
    rawTurnStart(1, 1000),
    rawAssistantMessage(1, '要装 LiteLoaderQQNT 吗？', 1100),
    rawToolCall(1, 'ask-1', 'ask_user_question',
      askArgs(['标准安装，我会点 UAC「是」（推荐）', '纯用户级安装，不要任何弹窗']), 1200),
    rawToolResult(1, 'ask-1', 1300),
    rawUserMessage('我已经手动进行安装了', 519000),
    rawTurnEnd(1, 520000),

    rawTurnStart(2, 600000),
    rawToolCall(2, 'ask-2', 'ask_user_question',
      askArgs(['关闭 QQ 并安装（推荐）', '只安装，不自动启动 QQ']), 601000),
    rawToolResult(2, 'ask-2', 602000),
    rawTurnEnd(2, 603000),

    rawTurnStart(3, 1200000),
    rawUserMessage('https://github.com/xh321/LiteLoaderQQNT-Anti-Recall/tree/master', 1263000),
    rawAssistantMessage(3, '收到，我看看这两个仓库。', 1264000),
    rawToolCall(3, 'ask-3', 'ask_user_question',
      askArgs(['一并中性化：去掉"家庭经营/父母"', '严格只替换"父亲"两字']), 1300000),
    rawToolResult(3, 'ask-3', 1301000),
    rawToolCall(3, 'ask-4', 'ask_user_question',
      askArgs(['整体减半，不管下限', '周记录保600字']), 1305000),
    rawToolResult(3, 'ask-4', 1306000),
    rawTurnEnd(3, 1307000),

    rawTurnStart(4, 2000000),
    rawUserMessage('把关于军训的内容删掉，另外补一下实习单位评语，简单两句话敷衍一下即可', 2047000),
    rawTurnEnd(4, 2100000),
  ])

  const before = countFreeformAnswersLegacy(events, OPTIONS)
  const now = countFreeformAnswers(events, OPTIONS)
  const missed = before.matches.filter(m => !now.matches.some(n => n.time === m.time && n.said === m.said))

  console.log(`  —— 修复前：freeformAnswers=${before.count}（considered=${before.considered}）`)
  console.log(`  —— 修复后：freeformAnswers=${now.count}（considered=${now.considered}）`)
  console.log(`  —— 修复前会误计 ${before.count - now.count} 条，逐条如下（修复后被正确排除）：`)
  for (const m of missed) {
    console.log(`       turn=${m.turn} 用户说：${JSON.stringify(m.said.slice(0, 48))}`)
  }
  console.log(`  —— 修复后保留的那条：${JSON.stringify(now.matches.map(m => m.said))}`)

  const missedTexts = missed.map(m => m.said).sort()
  // 三条误计 = GitHub 链接那条 + turn 3 的两条提问共享的"删军训内容"那条
  const expectedMissed = [
    'https://github.com/xh321/LiteLoaderQQNT-Anti-Recall/tree/master',
    '把关于军训的内容删掉，另外补一下实习单位评语，简单两句话敷衍一下即可',
    '把关于军训的内容删掉，另外补一下实习单位评语，简单两句话敷衍一下即可',
  ].sort()
  check('综合会话：修复前误计 3 条、修复后只剩 1 条', before.count === 4 && now.count === 1,
    `修复前 ${before.count} → 修复后 ${now.count}`)
  check('综合会话：误计的那 3 条全是"跨 turn 边界的新话题"（turn 3 的两次提问共享同一条后续发言）',
    missed.length === 3 && JSON.stringify(missedTexts) === JSON.stringify(expectedMissed),
    `排除 ${missed.length} 条：${JSON.stringify(missedTexts)}`)
  check('综合会话：唯一保留的正是同轮内的"我已经手动进行安装了"',
    now.matches.length === 1 && now.matches[0].said === '我已经手动进行安装了',
    JSON.stringify(now.matches.map(m => m.said)))
  check('综合会话：considered 也从 4 降到 1（换话题不算"考虑过这条提问"）',
    before.considered === 4 && now.considered === 1,
    `considered ${before.considered} → ${now.considered}`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log('4. countLongTools：并发判定换实现后逐字等价')
console.log('='.repeat(72))
{
  // 确切的并发序列：call A → call B → result B → result A
  // A 的墙钟 300s 远超阈值，但它与自己的结果之间夹了 call B → 并发 → 跳过并计数
  resetSeq()
  const concurrent = normalize([
    rawTurnStart(1, 0),
    rawToolCall(1, 'call-a', 'pwsh', { command: 'sleep' }, 1000),
    rawToolCall(1, 'call-b', 'read', { path: 'x' }, 2000),
    rawToolResult(1, 'call-b', 3000),
    rawToolResult(1, 'call-a', 301000),
    rawTurnEnd(1, 302000),
  ])
  const legacy = countLongToolsLegacy(concurrent, OPTIONS)
  const now = countLongTools(concurrent, OPTIONS)
  check('并发序列：concurrentSkipped=1（修复前记录的数字就是 1）',
    now.concurrentSkipped === 1 && legacy.concurrentSkipped === 1,
    `新=${now.concurrentSkipped} 修复前=${legacy.concurrentSkipped}`)
  check('并发序列：并发调用不计入 longTools', now.count === 0 && legacy.count === 0,
    `新=${now.count} 修复前=${legacy.count}`)
  check('并发序列：新旧结果逐字段相同',
    JSON.stringify(now) === JSON.stringify(legacy))

  // 干净的孤立调用：中间没有别的 tool/call → 计时长
  resetSeq()
  const clean = normalize([
    rawTurnStart(1, 0),
    rawToolCall(1, 'call-c', 'pwsh', { command: 'build' }, 1000),
    rawToolResult(1, 'call-c', 301000),
    rawTurnEnd(1, 302000),
  ])
  const cleanNow = countLongTools(clean, OPTIONS)
  const cleanBefore = countLongToolsLegacy(clean, OPTIONS)
  check('孤立调用：计入 longTools 且 concurrentSkipped=0',
    cleanNow.count === 1 && cleanNow.concurrentSkipped === 0, `count=${cleanNow.count}`)
  check('孤立调用：新旧结果逐字段相同', JSON.stringify(cleanNow) === JSON.stringify(cleanBefore))

  // 中间夹 turn/start 的调用同样算并发（旧实现也这么判）
  resetSeq()
  const acrossTurn = normalize([
    rawTurnStart(1, 0),
    rawToolCall(1, 'call-d', 'pwsh', { command: 'x' }, 1000),
    rawTurnEnd(1, 2000),
    rawTurnStart(2, 3000),
    rawToolResult(2, 'call-d', 301000),
  ])
  const acrossNow = countLongTools(acrossTurn, OPTIONS)
  const acrossBefore = countLongToolsLegacy(acrossTurn, OPTIONS)
  check('中间夹 turn/start 也算并发', acrossNow.concurrentSkipped === 1 && acrossNow.count === 0,
    `skip=${acrossNow.concurrentSkipped} count=${acrossNow.count}`)
  check('跨回合序列：新旧结果逐字段相同', JSON.stringify(acrossNow) === JSON.stringify(acrossBefore))

  // 逐字等价的兜底证据：300 组固定种子的伪随机序列，逐字段比对
  let mismatch = 0
  let totalSkipped = 0
  let totalMatches = 0
  let totalUnpaired = 0
  for (let round = 0; round < 300; round++) {
    resetSeq()
    const rng = makeRng(0x9e3779b9 ^ (round * 2654435761))
    const raw = []
    const pool = ['call-a', 'call-b', 'call-c', null]
    let turn = 0
    for (let i = 0; i < 30; i++) {
      const r = rng()
      const time = 1000 * i + Math.floor(rng() * 500)
      if (r < 0.2) {
        turn += 1
        raw.push(rawTurnStart(turn, time))
      } else if (r < 0.5) {
        const callId = pool[Math.floor(rng() * pool.length)]
        raw.push(rawToolCall(turn, callId, rng() < 0.5 ? 'pwsh' : 'read', {}, time))
      } else if (r < 0.85) {
        const callId = pool[Math.floor(rng() * pool.length)]
        raw.push(rawToolResult(turn, callId, time + Math.floor(rng() * 400000), rng() < 0.3))
      } else {
        raw.push(rawUserMessage('随口一句', time))
      }
    }
    const events = normalize(raw)
    // 归一化的不变量：数组里每个事件对象唯一 —— 旧实现的 indexOf 正是靠它才等价
    if (new Set(events).size !== events.length) mismatch += 1
    const before = countLongToolsLegacy(events, OPTIONS)
    const after = countLongTools(events, OPTIONS)
    if (JSON.stringify(before) !== JSON.stringify(after)) mismatch += 1
    totalSkipped += after.concurrentSkipped
    totalMatches += after.count
    totalUnpaired += after.unpaired
  }
  check('300 组伪随机序列：新旧 countLongTools 逐字段完全相同（含 concurrentSkipped）',
    mismatch === 0, `不一致 ${mismatch} 组`)
  check('随机序列确实覆盖到了并发/命中/配对不上的三种分支（不是空跑）',
    totalSkipped > 0 && totalMatches > 0 && totalUnpaired > 0,
    `concurrentSkipped 合计=${totalSkipped} longTools 合计=${totalMatches} unpaired 合计=${totalUnpaired}`)
}

function makeRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log('5. computeSessionSignals / computeAllSignals 的 details 开关')
console.log('='.repeat(72))
{
  resetSeq()
  const events = normalize([
    rawTurnStart(1, 1000),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1200),
    rawToolResult(1, 'ask-1', 1300),
    rawUserMessage('我自己另说的', 1400),
    rawTurnEnd(1, 2000),
  ])
  const withDetails = computeSessionSignals(events, OPTIONS)
  const withoutDetails = computeSessionSignals(events, OPTIONS, { details: false })
  const legacyCall = computeSessionSignals(events, OPTIONS) // 两个参数的旧调用方式

  check('默认（不传第三个参数）构造明细',
    withDetails.details !== null && typeof withDetails.details === 'object' &&
      Object.keys(withDetails.details).length === 5,
    `details 键=${Object.keys(withDetails.details ?? {}).join(',')}`)
  check('两参数旧调用方式仍然可用且与默认一致',
    JSON.stringify(legacyCall) === JSON.stringify(withDetails))
  check('details: false 时 details 为 null（但键**不省略**，形状不随调用方式变）',
    'details' in withoutDetails && withoutDetails.details === null)
  check('details: false 不影响任何计数',
    JSON.stringify({ ...withoutDetails, details: true }) === JSON.stringify({ ...withDetails, details: true }),
    `freeformAnswers=${withoutDetails.freeformAnswers}`)

  const bySession = new Map([['s1', events], ['s2', events]])
  const all = computeAllSignals(bySession, OPTIONS)
  const allLean = computeAllSignals(bySession, OPTIONS, { details: false })
  check('computeAllSignals 默认每个会话都带明细',
    all.sessions.s1?.details !== null && all.sessions.s2?.details !== null)
  check('computeAllSignals({ details: false }) 每个会话的 details 都是 null（键仍在）',
    'details' in allLean.sessions.s1 && allLean.sessions.s1.details === null &&
      allLean.sessions.s2.details === null)
  check('computeAllSignals：关掉明细后 totals 逐字段相同',
    JSON.stringify(all.totals) === JSON.stringify(allLean.totals),
    JSON.stringify(allLean.totals))
  check('computeAllSignals 两参数旧调用方式的结果与默认一致',
    JSON.stringify(computeAllSignals(bySession, OPTIONS)) === JSON.stringify(all))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log('6. options 漏字段时的行为：answerWindowMs 兜底 / delegatePatterns 恒 0')
console.log('='.repeat(72))
{
  // ── T6：answerWindowMs 缺失 / 非有限值 → 退回默认，而不是"不过滤" ──
  check('DEFAULT_ANSWER_WINDOW_MS 导出且与 schema 的 .default(1800000) 同值',
    DEFAULT_ANSWER_WINDOW_MS === 1800000, `${DEFAULT_ANSWER_WINDOW_MS}`)

  const noWindow = { ...OPTIONS }
  delete noWindow.answerWindowMs

  // 提问在 turn 1 内，发言也同轮（位置约束通过），但隔了 31 分钟
  resetSeq()
  const beyond = normalize([
    rawTurnStart(1, 0),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1000),
    rawToolResult(1, 'ask-1', 1100),
    rawUserMessage('我自己另说的', 1000 + DEFAULT_ANSWER_WINDOW_MS + 1),
    rawTurnEnd(1, 3000000),
  ])
  const beyondNow = countFreeformAnswers(beyond, noWindow)
  const beyondBefore = countFreeformAnswersLegacy(beyond, noWindow)
  console.log(`  —— 漏传 answerWindowMs（发言隔 31 分钟）：修复前 count=${beyondBefore.count}/considered=${beyondBefore.considered}` +
    ` → 修复后 count=${beyondNow.count}/considered=${beyondNow.considered}`)
  check('漏传 answerWindowMs 时，超 30 分钟的发言仍被排除（不是"不过滤时间"）',
    beyondNow.count === 0 && beyondNow.considered === 0,
    `count=${beyondNow.count} considered=${beyondNow.considered}`)
  check('交叉验证：修复前同一条序列会因为 window=undefined 而静默误计 1 条',
    beyondBefore.count === 1, `修复前 count=${beyondBefore.count}`)

  // 非有限值同样退回默认
  const asNaN = countFreeformAnswers(beyond, { ...noWindow, answerWindowMs: NaN })
  const asInfinity = countFreeformAnswers(beyond, { ...noWindow, answerWindowMs: Infinity })
  check('answerWindowMs 为 NaN / Infinity 时也退回默认值（不是被当成"不过滤"）',
    asNaN.count === 0 && asNaN.considered === 0 && asInfinity.count === 0 && asInfinity.considered === 0,
    `NaN=${asNaN.count} Infinity=${asInfinity.count}`)

  // 兜底不能覆盖调用方显式给的值：显式 1 秒 → 31 分钟的发言照样排除
  const asShort = countFreeformAnswers(beyond, { ...noWindow, answerWindowMs: 1000 })
  check('显式传入的 answerWindowMs 仍然优先（兜底只在字段不可用时生效）',
    asShort.count === 0 && asShort.considered === 0, `count=${asShort.count}`)

  // 反向边界：默认窗口**之内**的发言不能被兜底误杀
  resetSeq()
  const inside = normalize([
    rawTurnStart(1, 0),
    rawToolCall(1, 'ask-1', 'ask_user_question', askArgs(['选项甲', '选项乙']), 1000),
    rawToolResult(1, 'ask-1', 1100),
    rawUserMessage('我自己另说的', 1000 + DEFAULT_ANSWER_WINDOW_MS - 1),
    rawTurnEnd(1, 3000000),
  ])
  const insideNow = countFreeformAnswers(inside, noWindow)
  check('默认窗口之内的发言仍计入（兜底没有把窗收得过紧）',
    insideNow.count === 1 && insideNow.considered === 1, `count=${insideNow.count}`)

  // ── T7：缺 delegatePatterns = 该信号恒 0（刻意的 fail-visible，不改行为） ──
  resetSeq()
  const delegateEvents = normalize([
    rawTurnStart(1, 0),
    rawAssistantMessage(1, '这一步需要你先手动确认一下 UAC 弹窗，然后告诉我结果。', 1000),
    rawTurnEnd(1, 2000),
  ])
  const patterns = ['(请你|需要你|你自己)\\s*[去来把帮做先再重试看查改加写跑执行处理确认补删增]']
  const withPatterns = countDelegateRuns(delegateEvents, { delegatePatterns: patterns })
  let withoutThrew = false
  let withoutPatterns = null
  try {
    withoutPatterns = countDelegateRuns(delegateEvents, {})
  } catch {
    withoutThrew = true
  }
  check('缺 delegatePatterns：不抛异常', withoutThrew === false)
  check('缺 delegatePatterns：计数恒 0（空清单是合法输入，不改行为）',
    withoutPatterns?.count === 0 && withoutPatterns?.matches.length === 0,
    `count=${withoutPatterns?.count}`)
  check('同一序列只要给了正则就命中 1 次（证明"恒 0"是缺字段造成，不是事件形状不成立）',
    withPatterns.count === 1, `count=${withPatterns.count}`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))
process.exit(fail === 0 ? 0 : 1)
