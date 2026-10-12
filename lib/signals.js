/**
 * 四个**零 LLM**的计数信号。
 *
 * 全部判据只依赖会话日志里已有的结构化字段（事件类型、时间戳、callId、
 * `message.isError`、`ask_user_question` 的入参 JSON），不做任何语义判断、
 * 不调用模型。目的是给"这个用户在这儿被 AI 怎么对待过"提供客观计数，
 * 而不是让模型自己总结（模型总结会编）。
 *
 * 实测依据（本机 207 个会话日志，7477 次 tool/call、7486 次 tool/result、
 * 50 次 ask_user_question）写在各判据下面。
 */

/** 把 assistant 消息的 content 拍成纯文本。 */
export function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 从 assistant 消息里取出它的 tool-call block 数量。 */
function toolCallBlocks(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.filter(block => block?.type === 'tool-call')
}

/**
 * 把某个会话的事件流归一化成"按请求（turn）分组"的结构。
 *
 * ⚠️ 这里的 **turn** 用的是日志里的 `data.turn`，也就是 `turn/start` …
 * `turn/end` 之间那一段（一次用户输入引发的完整往返，可能含多个 step）。
 * 之所以不按 step 分：`data.step` 是"一轮里第几次模型调用+工具执行"，
 * 拿它当"轮"会让一次用户请求被拆成很多轮，"该轮 toolCalls==0" 就失去意义。
 *
 * @param {object[]} events 已按 seq 升序的事件
 * @returns {{turns: Map<number, object>, order: number[]}}
 */
export function groupTurns(events) {
  /** @type {Map<number, object>} */
  const turns = new Map()
  const order = []
  const ensure = (turn) => {
    if (turn === null || turn === undefined) return null
    let entry = turns.get(turn)
    if (!entry) {
      entry = {
        turn,
        humanMessages: [],
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
        askCalls: [],
        optionAsks: [],
        startTime: null,
        endTime: null,
      }
      turns.set(turn, entry)
      order.push(turn)
    }
    return entry
  }

  for (const event of events) {
    const turn = event.turn
    switch (event.type) {
      case 'turn/start': {
        const entry = ensure(turn)
        if (entry) entry.startTime = event.time
        break
      }
      case 'turn/end': {
        const entry = ensure(turn)
        if (entry) entry.endTime = event.time
        break
      }
      case 'user/message': {
        const entry = ensure(turn)
        if (!entry) break
        entry.humanMessages.push(event)
        break
      }
      case 'assistant/message': {
        const entry = ensure(turn)
        if (!entry) break
        entry.assistantMessages.push(event)
        break
      }
      case 'tool/call': {
        const entry = ensure(turn)
        if (!entry) break
        entry.toolCalls.push(event)
        if (event.toolName === 'ask_user_question') entry.askCalls.push(event)
        break
      }
      case 'tool/result': {
        const entry = ensure(turn)
        if (!entry) break
        entry.toolResults.push(event)
        break
      }
      default:
        break
    }
  }
  return { turns, order }
}

/**
 * 判断一条 `user/message` 是不是**真人发言**。
 *
 * 实测本机 207 个会话里 `user/message` 的 `source.kind` 分布：
 *
 *   user 467 / runtime-context 173 / plugin 83 / agent-message 35 /
 *   subagent-settled 28 / skill-catalog 15 / goal 15 / tool-jobs 13 /
 *   model-selection 3 / tool-goal 1 / user-approval 1
 *
 * 也就是说 user-role 消息里**只有 467/834 是真的人打的**，其余全是注入。
 * 不按 `source.kind === 'user'` 过滤会把系统上下文、技能目录、goal 续跑
 * 文案全当成人说的话，画像会被自己的注入污染。
 *
 * ⚠️ 已知残留误差（无法从日志消除）：当用户让一个 agent 去驱动另一个 agent 时，
 * 那条被注入的 prompt 也是 `source.kind === 'user'`（实测：画像生成器自己的
 * prompt 就这样出现在被委派会话里）。日志里没有区分"人打的"与"另一个 agent
 * 代打的"的字段，所以本函数只能到这一层。详见 IMPLEMENTATION.md 的未确认项。
 */
export function isHumanMessage(event) {
  if (event.type !== 'user/message') return false
  return event.message?.source?.kind === 'user'
}

/** 取一条真人发言的纯文本。 */
export function humanText(event) {
  return messageText(event.message).trim()
}

/**
 * 判据 1 —— 「让你代跑」。
 *
 * 定义：AI **一轮里一个工具都没调**（`toolCalls === 0`），
 * **并且最后一条消息在「要求用户去做某件事」**。
 *
 * ## 为什么不能只用关键词 `includes()`（实测踩过的坑）
 *
 * 第一版用的是"消息包含『需要你/请你/你自己』之一"。对真实日志抽样后
 * 发现**命中的全是假阳性**：这些措辞在中文论说文里常作"（我）需要你**注意**"
 * "请**你**看这一点"用，出现在 AI 大段分析里，跟"把活推回给人"毫无关系。例如：
 *
 *   「…**需要你**注意一个陷阱，不绕开的话你会得出错误结论」
 *   「…所以我**请你**先把三个被混在一起的东西拆开」
 *
 * 这类句子所在的那一轮确实没有工具调用（因为 AI 只是在讲话），
 * 于是纯关键词判据把它们全抓了进来。
 *
 * ## 改成两条收紧
 *
 * 1. **只判该轮最后一条 assistant 消息**。真正的"代跑"是"我讲完了，
 *    球给你"—— 那一定出现在回合末尾。中间步骤里的措辞不算数。
 * 2. **用正则要求"请求句式"**：`请你/需要你/你自己 + 可选助词 + 动词`，
 *    也就是这句在**要求对方做动作**，而不是把"你"当作论述对象。
 *    正则可由 `signals.delegatePatterns` 配置，判错了用户能自己改。
 *
 * 计数单位仍是**轮**：一轮最多记一次。
 *
 * ## ⚠️ 缺 `delegatePatterns` 时该信号**恒为 0**，这是**刻意的**（不是 bug）
 *
 * `options.delegatePatterns ?? []` —— 字段缺失 = 正则清单为空 = 一条都不匹配 =
 * 计数恒 0。看起来和 `answerWindowMs` 缺失（见 DEFAULT_ANSWER_WINDOW_MS）是同一类
 * "漏传字段 → 判据静默失效"，但两者要**分开处理**，理由是输入语义不同：
 *
 *   · **空清单是合法输入**：用户可以在设置里主动把两条正则删光，表达"我不要这个
 *     信号"。这种情况下计数 0 就是他要的结果，兜底成 schema 默认的两条中文正则
 *     反而会**违背用户显式意图**（还会把默认正则抄成第二份，改一处要改两处）。
 *   · **`answerWindowMs` 缺失不是合法意图**：`0 窗口` 没有表达能力可言，缺字段
 *     只可能是调用点漏传，所以那一侧兜底成默认值。
 *
 * 也就是说：这里"缺 = 0"是 fail-visible（一眼能看出信号没了），
 * 那边"缺 = 不过滤"是 fail-silent 的假开放（看起来在过滤，其实没过滤）。
 * 真实宿主路径上 `resolveConfig()` 一定会填这个字段；直接调用者想拿非 0 结果
 * 就必须自己传正则 —— 这是有意的要求，测试见 test/freeform-turn.mjs 的断言。
 */
export function countDelegateRuns(events, options) {
  const patterns = (options.delegatePatterns ?? [])
    .map(source => {
      try {
        return new RegExp(source)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const { turns, order } = groupTurns(events)
  const matches = []
  for (const turn of order) {
    const entry = turns.get(turn)
    if (!entry) continue
    if (entry.toolCalls.length > 0) continue // 该轮有工具调用 → 不算"代跑"
    if (entry.assistantMessages.length === 0) continue

    // 只看该轮最后一条 assistant 消息（回合末尾才是"交回给人"的位置）
    const last = entry.assistantMessages[entry.assistantMessages.length - 1]
    const text = messageText(last.message)
    if (!text.trim()) continue

    for (const pattern of patterns) {
      const found = pattern.exec(text)
      if (!found) continue
      matches.push({
        turn,
        time: last.time,
        matched: found[0],
        excerpt: text.slice(Math.max(0, found.index - 80), found.index + 120).replace(/\s+/g, ' '),
      })
      break
    }
  }
  return { count: matches.length, matches }
}

/**
 * 不算「命令失控」的工具 —— 它们的墙钟时间是在**等人或等后台任务**，
 * 不是在跑命令。
 *
 * 实测证据（阈值 60s、全部真实日志）：第一版共 116 次命中，按工具拆开是
 *
 *   pwsh=54  ask_user_question=27  job_output=20  workflow=7
 *   cordis_inspect_query=5  read=1  plugin_manager=1  subagent=1
 *
 * 其中 `ask_user_question` 的耗时**全部**是用户在思考（实测最长 5.5 小时），
 * `job_output` 是在等后台作业、`subagent` 是在等子代理、`plugin_manager`
 * 可能要用户点确认。把这些算成"命令失控"在语义上是错的 ——
 * 用户看到"命令失控 27 次"会以为 AI 乱跑命令，实际是它自己在等答案。
 *
 * 所以默认排除它们，并把它们的耗时**单独归类**上报（`humanWait`），
 * 信息不丢，但不再污染"命令失控"这个指标。
 * 被排除的工具名可由 `signals.humanWaitTools` 配置。
 */
const DEFAULT_HUMAN_WAIT_TOOLS = [
  'ask_user_question',
  'job_output',
  'job_list',
  'job_kill',
  'subagent',
  'list_agents',
  'send_message',
  'plugin_manager',
]

/**
 * 判据 2 —— 「命令失控」。
 *
 * 定义：一次**命令类**工具调用的墙钟耗时
 * （`tool/result.time - tool/call.time`）超过阈值。
 *
 * 配对键是 `callId`，而它的唯一可靠来源是 `data.message.source.callId`
 * （见 sessions.js 的归一化说明）。配对是按**会话内**做的
 * （调用方逐会话传入事件），所以不会跨会话串时间。
 *
 * ## ⚠️ 并发调用必须排除（实测踩过的坑）
 *
 * 第一版直接算 `result.time - call.time`，结果出现大量"5.5 小时"的
 * `pwsh` 调用。逐条追下去发现是**并发**：某次 `tool/call` 在 seq=55，
 * 它的 `tool/result` 却在 seq=3120 —— 中间夹了 **3064 个事件**、跨了好几个
 * turn，说明那次工具是**并行**跑的，而它的结果被排到很久之后才追加。
 * 这种情况下 `result.time - call.time` 量的是"结果排队了多久"，
 * 不是"这条命令跑了多久"。
 *
 * 判据：若在 `call.seq` 与 `result.seq` 之间**还存在另一个 `tool/call`**，
 * 这次调用就是并发的，其墙钟不可信 → **跳过并单独计数**（`concurrentSkipped`）。
 * 只有"孤立的"调用（期间没有别的调用发出）才计时长 ——
 * 并行批次里只有最后一个能拿到干净读数，其余都被跳过。
 *
 * ## 这一类命中仍然要人工看一眼
 *
 * 即使排除了并发，超长耗时也可能是"用户离开去吃饭了"而不是"命令失控"。
 * 这里只做**客观计数**，不替用户下结论；明细里带 `tool`、`durationMs`、
 * `turn`，界面应当能点开看到具体是哪一次。
 *
 * 实测本机分布：n≈7486，p50≈0.4s、p90≈9s、p99≈78s。
 * 默认阈值 60s 落在 p98 附近。阈值可配（`signals.longToolMs`）。
 *
 * @returns {{count:number, matches:object[], humanWait:object[], unpaired:number, concurrentSkipped:number}}
 */
export function countLongTools(events, options) {
  const threshold = options.longToolMs
  const excluded = new Set(options.humanWaitTools ?? DEFAULT_HUMAN_WAIT_TOOLS)

  /**
   * callId → `{ event, index }`：这次 `tool/call` 事件，以及它在事件数组里的下标。
   *
   * ⚠️ 存成对象而不是裸事件，是并发判定的性能修复带来的：并发判定要在
   * `(callIndex, resultIndex)` 区间里找别的 `tool/call`，把扫描时的循环下标
   * 顺手存下来即可。旧实现是拿 `events.indexOf(call)` / `indexOf(result)`
   * 反查下标 —— 每次超阈值的调用要全数组扫两遍，7486 条 `tool/result` 的库上
   * 就是平方级的白扫（见 hasOtherCallBetween 的说明）。
   */
  const callEvent = new Map()
  const matches = []
  const humanWait = []
  let unpaired = 0
  let concurrentSkipped = 0

  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.type === 'tool/call' && event.callId) {
      callEvent.set(event.callId, { event, index })
      continue
    }
    if (event.type !== 'tool/result') continue
    // 没有 callId 的结果同样**配不上任何一次调用**，必须计入 unpaired。
    // 之前这里直接 continue，于是这类结果在四个信号里既不配对也不计入
    // unpaired —— 成了计数口径上的黑洞（实测本机 8917 条 tool/result 全是
    // 有 callId 的，所以当前数字不变，但口径不该留洞）。
    if (!event.callId) {
      unpaired += 1
      continue
    }

    const call = callEvent.get(event.callId)
    if (!call || call.event.time === null || event.time === null) {
      unpaired += 1
      continue
    }
    const durationMs = event.time - call.event.time
    if (durationMs <= threshold) continue

    // 并发判定：call 与 result 之间若还有别的 tool/call，墙钟不可信
    if (hasOtherCallBetween(events, call.index, index)) {
      concurrentSkipped += 1
      continue
    }

    const record = { turn: event.turn, time: event.time, tool: call.event.toolName, durationMs }
    if (call.event.toolName && excluded.has(call.event.toolName)) humanWait.push(record)
    else matches.push(record)
  }
  return { count: matches.length, matches, humanWait, unpaired, concurrentSkipped }
}

/**
 * `callIndex` 与 `resultIndex` 之间是否夹着另一个 `tool/call`（= 这次是并发调用）。
 *
 * 下标由 `countLongTools` 的主循环直接给出 —— 归一化后数组顺序**就是**日志顺序
 * （`bySession()` 按 seq 升序排过），而且每个事件对象在数组里只出现一次，
 * 所以"扫描时的下标"与旧实现 `events.indexOf(event)` 的结果**逐字相同**，
 * 但省掉了每次判定两遍全数组扫描。区间内出现 `turn/start` 同样算并发：
 * 跨回合说明结果不是紧接着这次调用产生的。
 */
function hasOtherCallBetween(events, callIndex, resultIndex) {
  if (callIndex < 0 || resultIndex < 0 || resultIndex <= callIndex) return false
  for (let i = callIndex + 1; i < resultIndex; i++) {
    const type = events[i].type
    if (type === 'tool/call') return true
    if (type === 'turn/start') return true
  }
  return false
}

/**
 * 判据 3 —— 「工具反复失败」。
 *
 * 定义：**同一个工具连续失败**达到 `repeatFailMin` 次（默认 3）。
 * 失败判据取 `tool/result` 的 `data.error !== undefined`（实测：失败结果带
 * 一个 `{name, code, reason?}` 的 `error` 对象，例如
 * `{name:'FsError', code:'FS_NOT_OBSERVED'}`、`{name:'WebError', code:'WEB_UNSUPPORTED_CONTENT_TYPE'}`）。
 * 同时也接受 `message.isError === true`（两者取或，因为实测存在只有其一的样本）。
 *
 * 游走规则：按事件顺序维护 `tool → 连续失败次数`；
 * **任何一次成功**把该工具的次数清零；达到阈值就记一次并把计数清零
 * （所以连续失败 7 次在阈值 3 下记 2 次：3 次 + 3 次，剩 1 次不够）。
 * 不同工具各自独立计数，交错出现互不影响。
 *
 * ## ⚠️ 已知偏差：配对不上的失败结果全落进同一个 `(unknown)` 桶
 *
 * `callName.get(event.callId) ?? '(unknown)'` —— 若某条 `tool/result` 的 callId
 * 配不到本次事件流里的 `tool/call`（例如会话文件第一帧被截断、调用发生在扫描
 * 窗口之外），它会被假想成一个名叫 `(unknown)` 的"工具"，于是**不同工具**的
 * 这种结果会互相把 streak 清零 / 加长。这条偏差**故意留着不改**：任何"猜工具名"
 * 的改法都会动到计数口径（这个信号的数字是要跟历史版本比的）。
 *
 * 实测（本机会话库快照）：819 条 `tool/result` 全部带 callId，且全部能在同会话内
 * 配上（unpaired=0），所以这个桶目前是空的 —— 偏差只存在于理论上。
 * 也**没有**更准确的分桶键可用：819 条 `tool/result` 的 message 键固定为
 * `role/source/toolCallId/content/isError/id`，**没有** name/toolName 字段，
 * 所以 `event.toolName ?? '(unknown)'` 在结果事件上恒为 `undefined ?? '(unknown)'`
 * = 与现状逐字相同，换成它只是把注释里的坑藏进代码里。
 */
export function countRepeatFailures(events, options) {
  const need = options.repeatFailMin
  const callName = new Map()
  /** @type {Map<string, number>} 工具 → 当前连续失败次数 */
  const streak = new Map()
  const matches = []
  for (const event of events) {
    if (event.type === 'tool/call' && event.callId) {
      callName.set(event.callId, event.toolName)
      continue
    }
    if (event.type !== 'tool/result') continue
    const tool = callName.get(event.callId) ?? '(unknown)'
    const failed = event.isError === true || event.errorCode != null
    if (!failed) {
      streak.set(tool, 0)
      continue
    }
    const next = (streak.get(tool) ?? 0) + 1
    if (next >= need) {
      matches.push({
        turn: event.turn,
        time: event.time,
        tool,
        run: next,
        lastErrorCode: event.errorCode ?? null,
      })
      streak.set(tool, 0)
    } else {
      streak.set(tool, next)
    }
  }
  return { count: matches.length, matches }
}

/**
 * `answerWindowMs` 的兜底值：**与 `lib/schema.js` 的 `.default(1800000)` 同值**。
 *
 * ⚠️ 改这个值必须把库里所有同值处**一起**改（实测现在共三处）：
 *   · `lib/schema.js` 的 `.default(1800000)` —— 真实宿主路径（schema 默认值赢）
 *   · `lib/index.js` `resolveConfig()` 的 `defaults.signals.answerWindowMs` ——
 *     测试路径（`loadtest`/`httptest` 直接 `apply(root, cfg)` 时才轮到它）
 *   · **本常量** —— 有人直接调 `countFreeformAnswers(events, options)` 且 options
 *     漏了这个字段时的最后一层兜底
 * 与 `index.js` 里 `maxTokens` 那套"两处都要改"的约定同源（见 `defaults.profile`
 * 的注释：不是"defaults 优先"，而是两条路径各有一份、必须同值）。
 *
 * 为什么要有这一层：判据里原来写的是 `dt > options.answerWindowMs`，字段缺失时
 * `window === undefined`，`dt > undefined` 恒为 false → **时间窗整块静默失效**，
 * 跨半小时的发言会被当成本次提问的回答。真实宿主路径上 `resolveConfig()` 一定
 * 会填这个字段，所以线上没暴露；但"漏传一个字段就少一道约束、且不报错"正是
 * 这个项目最不想要的失败方式。兜底成默认值，而不是"缺失就不过滤"。
 */
export const DEFAULT_ANSWER_WINDOW_MS = 1800000

/**
 * 给事件流推算**有效轮号**（本地兜底，供本文件内需要"轮号比较"的判据用）。
 *
 * 为什么需要这一层（实测根因，不是理论担忧）：
 * `user/message` 在日志里的 `data` **就是** message 本身，键只有
 * `content/source/role/id` —— **没有 `turn`**（本机实测：28 条真人发言所在的
 * `user/message` 里，data 带 `turn` 键的有 **0 条**）。而 `turn/start`、
 * `assistant/message`、`tool/call`、`tool/result` 都带 `data.turn`
 * （`{turn:1}` 这种，实测 27 条 turn/start 全带）。于是归一化后
 * **真人发言的 turn 恒为 null**，任何"比较两条事件轮号"的判据都会退化成空判据。
 *
 * 规则（严格兜底，不覆盖外部结论）：
 *   - **只在 `event.turn === null` 时**贴推算的轮号；外部（sessions.js 的
 *     `bySession()`）已经按位置补过 turn 的输入**原样保留** —— 这个兜底与那
 *     正交的修复同时存在也不会互相打架；
 *   - `currentTurn` 由 `turn/start` 或任何自带 `data.turn` 的事件推进。
 *
 * ⚠️ 刻意**不**在 `turn/end` 处清空 currentTurn：真实日志里 turn/end 之后到
 * 下一条 turn/start 之间的事件（如 session/title、todo/write）本来就属于
 * 刚结束的那一轮，贴着它才不会把同一轮的发言判成跨轮。
 *
 * @param {object[]} events 已按 seq 升序的事件
 * @returns {Array<number|null>} 与 events 等长的有效轮号
 */
function resolveEventTurns(events) {
  const turns = new Array(events.length)
  let currentTurn = null
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    // `data.turn` 是日志里的原始来源（`event.turn` 就是归一化时从它取的；
    // 这里一并接受，是为了手写的事件对象（测试）只带 turn 也能用）。
    const declared = event.data?.turn ?? event.turn
    // `turn/start` 是轮号的权威声明；但它若没给轮号就不推进 currentTurn
    // （否则会把已知轮号覆盖成 null）。
    if (event.type === 'turn/start' || declared != null) {
      if (declared != null) currentTurn = declared
    }
    turns[i] = event.turn ?? currentTurn
  }
  return turns
}

/**
 * 判据 4 —— 「给了选项但用户自己另说」。
 *
 * 定义：AI 调了 `ask_user_question` **并且给了 options**，之后该会话的
 * 下一条**真人发言**既不等于任何一个选项 label、也不包含 / 被包含于任何
 * label → 计一次（用户没按给的选项走，而是自己另说）。
 *
 * ## 实测到的数据形态（这是判据能成立的前提）
 *
 * `ask_user_question` 的**回答不在 `tool/result` 事件里**：
 * 全库 50 次调用，按 callId 去 `tool/result` 配对的结果是 **0 条**。
 * 回答的真正落点是 `tool/result` 事件里 `data.message.content` 为
 * `tool-result` block、且 `data.message.role === 'user'` 的那种事件，
 * 其内容形如：
 *
 *   {"answers":[{"id":"restart_qq","selected":["先不重启，我自己稍后重启"]}, ...]}
 *
 * 这是**选择**的结果。所以"用户自己另说"必须从**下一条真人发言**上判，
 * 而不是从回答 JSON 上判 —— 回答 JSON 里只有被选中的 label，
 * 看不出用户是否在选项之外自己补了话。
 *
 * 选项 label 从 `tool/call.arguments` 的 JSON 里取
 * （实测 `{"questions":[{"id","header","question","options":[{"label","description"}]}]}`）。
 *
 * 匹配规则（宽进严出，宁可漏计也不误计）：
 *   - 文本全等某个 label → 视为"选了选项"
 *   - 文本包含某个 label，或某个 label 包含文本 → 视为"选了选项"
 *     （实测点击选项后补一句说明、或 label 被引号包裹的情况）
 *   - 否则 → "自己另说"
 *
 * ## 「自己另说」还必须真的是在回答
 *
 * 实测发现的假阳性：用户没回答那个提问，而是**直接开了个新话题**，例如
 *
 *   问：能看到 LiteLoaderQQNT 吗？ [能看到 / 看不到 / 有选项但里面不对]
 *   答：总结一下为了成功安装，你做的关键步骤…
 *
 * 这条被第一版判成了"给了选项但用户自己另说"，但那其实是换话题，
 * 不是"不按选项回答"。所以再加一条**位置约束**：
 * 这条真人发言必须紧跟在**提问所在的那一轮之后**。
 * 判据是"两者之间没有出现新的人工回合"—— 若中间隔着别的 `turn`，
 * 说明用户先处理了别的事，这条发言与提问无关。
 *
 * ## ⚠️ 上面这条位置约束曾经是**死代码**（实测根因，本次修掉）
 *
 * 旧判据写的是 `askTurn !== null && candidate.turn !== null && candidate.turn !== askTurn`
 * 再去看中间有没有 `turn/start`。而 `candidate` 是 `user/message`，
 * **它的 turn 恒为 null**：真实日志里 `user/message` 的 `data` 就是 message
 * 本身，键只有 `content/source/role/id`，**没有 `turn`**（本机实测：带 turn 键的
 * `user/message` 有 0 条，真人发言 28 条），归一化后 `turn: null`。
 * 于是 `candidate.turn !== null` 永远为假，
 * 整个位置约束**一次都没生效**：用户"换了个新话题"被照单收成
 * "给了选项但用户自己另说"。
 *
 * 修复：先用 `resolveEventTurns()` 给事件流推一遍**有效轮号**（本地兜底，
 * 只在 `event.turn === null` 时贴，不覆盖外部已补的 turn），再拿有效轮号比较。
 *
 * 实测（本机会话库快照：14 个会话、27 条 turn/start、6 次带选项的
 * ask_user_question）：旧判据 4 条命中，其中 **3 条**是"提问之后跨了 turn 边界
 * 才出现的新话题"（用户粘贴 GitHub 链接、要求删军训内容、要求写指导老师评语），
 * 修复后只剩 1 条真正的"自己另说"。用户机器上的 `freeformAnswers: 2` 同源 ——
 * 画像生成器自己都在 notes 里写"在材料里找不到可对应的具体发言"。
 *
 * 时间窗 `answerWindowMs` 仍然生效（超窗说明隔太久，与提问无关）。
 */
export function countFreeformAnswers(events, options) {
  // 时间窗兜底（见 DEFAULT_ANSWER_WINDOW_MS 的说明）：缺失 / 非有限值
  // （undefined、NaN、Infinity、非数字）一律退回默认值，**绝不退化成"不过滤"**。
  // 负数 / 0 不回退：schema 的 `.natural().min(1000)` 不允许，且它们只会让窗更严
  // （漏计而不是多计），失败方向是安全的。
  const configured = options?.answerWindowMs
  const window = Number.isFinite(configured) ? configured : DEFAULT_ANSWER_WINDOW_MS
  const matches = []
  let considered = 0

  // ── 一次前向扫描建立索引 ───────────────────────────────────────────────
  // 旧实现是"对每条 ask 向后 for j 找下一条真人发言，再 for k 数中间有没有
  // turn/start"：提问数 × 事件数，库越大越慢。这里改成一趟扫描把下面这些东西
  // 全部备好，之后每条提问 O(log H) 出结果（H = 真人发言数）。
  const turns = resolveEventTurns(events)
  const total = events.length
  /** `[0,k)` 区间内的 turn/start 条数（前缀和）→ O(1) 判断"中间跨没跨轮" */
  const turnStartsBefore = new Int32Array(total + 1)
  /** 真人发言的下标（升序） */
  const humanIndices = []
  /** 有效轮号 → 该轮的真人发言下标（升序），跨轮时用来找"同轮的下一句" */
  const humanByTurn = new Map()
  /** 带选项的 ask_user_question 的下标 */
  const asks = []
  let turnStarts = 0
  for (let i = 0; i < total; i++) {
    const event = events[i]
    turnStartsBefore[i] = turnStarts
    if (event.type === 'turn/start') turnStarts += 1
    if (isHumanMessage(event)) {
      humanIndices.push(i)
      const bucket = humanByTurn.get(turns[i])
      if (bucket) bucket.push(i)
      else humanByTurn.set(turns[i], [i])
    }
    if (event.type === 'tool/call' && event.toolName === 'ask_user_question') asks.push(i)
  }
  turnStartsBefore[total] = turnStarts

  /** 升序下标数组里第一个 `> index` 的元素，没有则 -1。 */
  const firstAfter = (sorted, index) => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] > index) hi = mid
      else lo = mid + 1
    }
    return lo < sorted.length ? sorted[lo] : -1
  }

  for (const askIndex of asks) {
    const event = events[askIndex]
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
    if (labels.length === 0) continue // 没给选项的提问不参与本判据

    const askTurn = turns[askIndex]

    // 提问之后的第一条真人发言
    const next = firstAfter(humanIndices, askIndex)
    if (next < 0) continue
    let human = next

    // 位置约束：提问轮之后、跨了 turn 边界才出现的真人发言不算回答。
    // 与旧判据逐字对应，只把 `candidate.turn` 换成**有效轮号** `turns[next]`。
    // （旧判据里那个 `candidate.turn !== null` 的守卫被省掉了：提问轮非 null 时
    //   有效轮号也非 null —— currentTurn 只被推进、永远不会被清回 null，
    //   所以那个守卫恒真，留着只会是又一处死判据。）
    if (askTurn !== null && turns[next] !== askTurn &&
        turnStartsBefore[next] > turnStartsBefore[askIndex + 1]) {
      // 旧实现在这里 `continue`，继续往后找下一条真人发言。等价改写：
      // 跨过轮边界之后，候选能通过约束的唯一条件就是"有效轮号仍等于提问轮"
      // （提问轮非 null ⇒ 其后的发言有效轮号都非 null，不再需要 `!== null`），
      // 所以直接取该轮的第一条真人发言，不必再逐条重扫。
      human = firstAfter(humanByTurn.get(askTurn) ?? [], askIndex)
    }
    if (human < 0) continue

    const said = events[human]
    if (event.time !== null && said.time !== null && said.time - event.time > window) continue

    considered += 1
    const text = humanText(said)
    if (!text) continue
    const picked = labels.some(label => text === label || text.includes(label) || label.includes(text))
    if (!picked) {
      matches.push({
        turn: event.turn,
        time: said.time,
        offered: labels,
        said: text.slice(0, 200),
      })
    }
  }
  return { count: matches.length, matches, considered }
}

/**
 * 对**单个会话**的事件流算出全部四个信号。
 * @param {object[]} events 该会话的事件（seq 升序）
 * @param {object} options `config.signals`
 * @param {{details?: boolean}} [behavior] `details: false` 时**不构造明细数组**
 *   （`details` 为 `null`）。默认 `true` —— `getSessionSignals()`（界面点开某个
 *   会话）要的就是明细。
 */
export function computeSessionSignals(events, options, { details = true } = {}) {
  const delegate = countDelegateRuns(events, options)
  const longTool = countLongTools(events, options)
  const repeatFail = countRepeatFailures(events, options)
  const freeform = countFreeformAnswers(events, options)
  const human = events.filter(isHumanMessage)
  return {
    humanMessages: human.length,
    delegateRuns: delegate.count,
    longTools: longTool.count,
    repeatFailures: repeatFail.count,
    freeformAnswers: freeform.count,
    unpairedToolResults: longTool.unpaired,
    /** 被排除在「命令失控」之外的人类等待时长（单独归类，不丢信息） */
    humanWaitTools: longTool.humanWait.length,
    /** 因并发而墙钟不可信、被跳过的调用数 */
    concurrentSkipped: longTool.concurrentSkipped,
    // `details: false` 时用 `null` 表示"这次没构造"，**不省略键** ——
    // 省略键会让 JSON 形状随调用方式变化（同 lib/profile.js 的 diagnostics 注释：
    // 诊断字段用 null / 空数组表示"没问题"）。
    // 省掉的是"把这份明细挂进返回结构"：原来全库汇总那条路径会把每个会话的
    // excerpt / offered 数组一路带回去，再由调用点整包丢掉。四个计数器本身仍会
    // 构造各自的 matches（它们是独立导出的，可能被单独调用），所以这一步省的是
    // **持有**（191 个会话同时存活的那份），不是**计算**；想连构造一起省，
    // 得再给四个计数器加开关 —— 那会扩大导出面，本次没做。
    details: details ? {
      delegateRuns: delegate.matches,
      longTools: longTool.matches,
      humanWaitTools: longTool.humanWait,
      repeatFailures: repeatFail.matches,
      freeformAnswers: freeform.matches,
    } : null,
  }
}

/**
 * 对全部会话算出汇总信号 + 每个会话的明细。
 * @param {Map<string, object[]>} bySession
 * @param {object} options `config.signals`
 * @param {{details?: boolean}} [behavior] 同 computeSessionSignals。
 *   `details: false` 是给"只要 totals / sessionCount"的调用点用的（全库扫描，
 *   每个会话的明细原来构造完就被整包丢掉）；默认 `true` 保持原调用方式不变。
 */
export function computeAllSignals(bySession, options, { details = true } = {}) {
  const sessions = {}
  const totals = {
    sessions: 0,
    humanMessages: 0,
    delegateRuns: 0,
    longTools: 0,
    repeatFailures: 0,
    freeformAnswers: 0,
    unpairedToolResults: 0,
    humanWaitTools: 0,
    concurrentSkipped: 0,
  }
  for (const [sessionId, events] of bySession) {
    const result = computeSessionSignals(events, options, { details })
    // 只有出现过真人发言的会话才进统计：子代理会话、纯注入会话不该算
    if (result.humanMessages === 0) continue
    sessions[sessionId] = result
    totals.sessions += 1
    totals.humanMessages += result.humanMessages
    totals.delegateRuns += result.delegateRuns
    totals.longTools += result.longTools
    totals.repeatFailures += result.repeatFailures
    totals.freeformAnswers += result.freeformAnswers
    totals.unpairedToolResults += result.unpairedToolResults
    totals.humanWaitTools += result.humanWaitTools
    totals.concurrentSkipped += result.concurrentSkipped
  }
  return { totals, sessions }
}
