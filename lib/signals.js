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

  /** callId → 该次 tool/call 事件 */
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
    // 没有 callId 的结果同样**配不上任何一次调用**，必须计入 unpaired。
    // 之前这里直接 continue，于是这类结果在四个信号里既不配对也不计入
    // unpaired —— 成了计数口径上的黑洞（实测本机 8917 条 tool/result 全是
    // 有 callId 的，所以当前数字不变，但口径不该留洞）。
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

    // 并发判定：call 与 result 之间若还有别的 tool/call，墙钟不可信
    const concurrent = hasOtherCallBetween(events, call, event)
    if (concurrent) {
      concurrentSkipped += 1
      continue
    }

    const record = { turn: event.turn, time: event.time, tool: call.toolName, durationMs }
    if (call.toolName && excluded.has(call.toolName)) humanWait.push(record)
    else matches.push(record)
  }
  return { count: matches.length, matches, humanWait, unpaired, concurrentSkipped }
}

/**
 * `call` 与 `result` 之间是否夹着另一个 `tool/call`（= 这次是并发调用）。
 *
 * 用事件数组下标定位区间 —— 归一化后数组顺序**就是**日志顺序
 * （`bySession()` 按 seq 升序排过），比重新按 seq 查表更直接也更省。
 * 区间内出现 `turn/start` 同样算并发：跨回合说明结果不是紧接着这次调用产生的。
 */
function hasOtherCallBetween(events, call, result) {
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
 * 时间窗 `answerWindowMs` 仍然生效（超窗说明隔太久，与提问无关）。
 */
export function countFreeformAnswers(events, options) {
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
    if (labels.length === 0) continue // 没给选项的提问不参与本判据

    const askTurn = event.turn

    // 找之后的下一条真人发言（同会话事件流内）
    let human = null
    for (let j = i + 1; j < events.length; j++) {
      const candidate = events[j]
      if (candidate.type !== 'user/message') continue
      if (!isHumanMessage(candidate)) continue
      // 位置约束：提问轮与这条发言之间不能又开了新的人工回合。
      // `turn/start` 出现在提问轮之后、且不是同轮 → 说明用户先做别的了。
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
    const text = humanText(human)
    if (!text) continue
    const picked = labels.some(label => text === label || text.includes(label) || label.includes(text))
    if (!picked) {
      matches.push({
        turn: event.turn,
        time: human.time,
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
 */
export function computeSessionSignals(events, options) {
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
    details: {
      delegateRuns: delegate.matches,
      longTools: longTool.matches,
      humanWaitTools: longTool.humanWait,
      repeatFailures: repeatFail.matches,
      freeformAnswers: freeform.matches,
    },
  }
}

/**
 * 对全部会话算出汇总信号 + 每个会话的明细。
 * @param {Map<string, object[]>} bySession
 * @param {object} options `config.signals`
 */
export function computeAllSignals(bySession, options) {
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
    const result = computeSessionSignals(events, options)
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
