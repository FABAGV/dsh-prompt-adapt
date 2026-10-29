/**
 * 宿主侧持久化。
 *
 * 落点与 dsh-qq / dsh-whale-widget 的约定一致：
 * `$DSH_HOME/<plugin>/`，其中 `DSH_HOME` 优先取环境变量，否则 `~/.dsh`。
 * 本插件的目录是 `$DSH_HOME/prompt-adapt/`。
 *
 * ## 目录内容
 *
 *   state.json        用户数据 + 画像 + 上次生成水位（**UI 侧读写的唯一文件**）
 *   cursor.json       会话日志的帧偏移水位（每个文件已解压到第几字节）
 *   plain/<sha1>.jsonl 已解压的会话明文缓存（保证每帧只解一次）
 *   profile-history/  每次生成的画像快照，只增不删（便于回看"画像怎么变的"）
 *   plugin.log        日志镜像（桌面端 stdout 是 Electron 空管，看不到）
 *
 * ## 写盘的原子性
 *
 * `writeFileSync(tmp)` + `renameSync(tmp, target)`。rename 在同一分区上是原子的，
 * 所以进程在写一半时被杀不会留下半个 JSON —— 只会留下一个 tmp 文件。
 * （与 dsh-qq/lib/dsh/state.js:170-171 相同的做法。）
 *
 * ## 模式互斥是怎么落实的
 *
 * `mode` 只能是 `'auto'` 或 `'custom'`，**单字段枚举**而不是两个布尔量。
 * 用两个布尔量（`autoEnabled` / `customEnabled`）在结构上就允许"两个都 true"，
 * 需要靠每次读的时候额外断言去兜。单字段枚举让"同时开启"这种状态
 * **根本无法表示** —— 这是硬规则，用类型而不是用检查来保证。
 *
 * `effectiveText()` 是"当前生效画像文本"的**唯一**产出点：模式 1 给画像文本，
 * 模式 2 给用户手写文本，两者不会同时出现。
 *
 * 它有两个出口，**不要混用**：
 *   - `effective()`            全文。UI 预览、复制到模式 2、复制快照都用它。
 *   - `effectiveForInjection()` 注入系统提示用；模式 1 下画像部分按 token
 *     预算裁剪（超预算的条目只在**注入侧**省略，画像本身不删）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const STATE_VERSION = 1

/** 工作笔记上限：项目/工具类事实只存最近这些条，不参与画像槽位预算。 */
export const WORKING_NOTES_CAP = 50

/** 两个互斥的模式。模式 3（提示词大厅）不参与生效，所以不是 mode 的取值。 */
export const MODE = {
  /** 模式 1：自动画像（LLM 归纳，用户只读） */
  AUTO: 'auto',
  /** 模式 2：自定义（用户手写的系统提示词） */
  CUSTOM: 'custom',
}

/**
 * 解析 DSH 主目录。与 dsh-qq 完全相同：环境变量优先，否则 `~/.dsh`。
 * @returns {string}
 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 空白状态。
 * @returns {object}
 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    mode: MODE.AUTO,

    /** 模式 2 的文本（用户手写）。切到模式 1 时**不清空**，切回来还在。 */
    customText: '',

    /** 模式 1 的画像。`null` 表示还没生成过。 */
    profile: null,

    /** 模式 1 生效时附加在画像后面的补充说明（可为空）。 */
    autoExtraText: '',

    /**
     * **条目处置标记**（界面上每条画像条目旁的「置顶 / 封印 / 删除」三个按钮）。
     *
     * 三种状态（`pinned` / `sealed` / `deleted`）落在**同一个数组**里，每条记录带
     * 一个 `status` —— 三种状态互斥，一份清单让"同一条同时出现在两个区"在结构上
     * 不可能。理由与记录形状见 `lib/profile.js` 的"条目处置标记"一节。
     *
     * 为什么放在 state 顶层而**不是** `profile` 里：画像会被整份替换（重新生成）、
     * 会被清空（`clearProfile()`）、生成还可能失败只留上一版 —— 而用户的处置决定
     * 必须比任何一版画像活得久（被封印/删过的结论下一轮会从同一批材料里重新长出来）。
     */
    entryMarks: [],

    /**
     * 工作笔记：项目 / 工具 / 路径 / 账号 / 仓库类事实。
     *
     * 为什么单独存：这类事实**不是**用户本人的稳定特质，不该占 44 条画像槽位，
     * 也不该被无条件注入（换一个项目就不成立）。模型在生成时把它们写进
     * `projectNotes`，宿主合并到这里；界面单独展示，默认不注入。
     *
     * 形状：`[{ text, at }]`；按 text 去重，最多 `WORKING_NOTES_CAP` 条。
     */
    workingNotes: [],

    /** 一次性迁移标记：把旧画像里 3 条"本插件设计需求"移到工作笔记，只跑一次。 */
    workingNotesMigrated: false,

    /** 上次"复制画像文本"时的快照，用来告诉用户"你复制之后画像又变了"。 */
    copiedSnapshot: {
      /** 复制时的生效文本。`null` = 从没复制过。 */
      text: null,
      at: null,
      /** 复制时的画像版本号。 */
      profileVersion: null,
    },

    /** 上次成功生成画像时的水位，用于算"累计新增"。 */
    lastGeneration: {
      at: null,
      humanMessages: 0,
      sessions: 0,
      /**
       * 这一版材料的时间上界（最近一条真人发言的时间戳）。
       * 触发判据只数它之后的新增；缺省 0 = 还没生成过 / 旧 state，第一次按全量算。
       */
      materialCutoff: 0,
    },

    /** 最近一次四个信号的汇总（每次扫描后刷新）。 */
    lastSignals: null,

    /**
     * 注入落账：每一版画像**真正进了 system prompt** 的条目 id 与累计次数。
     *
     * 为什么需要（实测）：`injectedIds` 只活在单次 `planProfileInjection()` 的返回值里，
     * 用完即丢。于是系统从不知道"这条一次都没注入过"——本机 108 条里 60 条
     * 从生成到现在一次都没进过 prompt，而生成器仍在按同一套分数继续加条目。
     * 落账之后，"从未交付"与"反复交付"才成为可查询的事实（新生试用位要用它）。
     *
     * 形状：`{ version, identity, ids, counts, frozenCounts, lastAt }`
     *   · `version` = 展示用的画像版本号
     *   · `identity` = 版本身份（`generatedAt:version`）。`clearProfile()` 后版本号
     *     会从 1 重来，只用 version 去重会把新 v1 当成旧 v1（那会丢掉整本账）。
     *   · `ids`     = 那一版真正注入的条目 id（渲染顺序 + 中途补记的并集）
     *   · `counts`  = id → 被注入过的版本数（条目被删/改写后旧 id 可能留在账上）
     *   · `frozenCounts` = **上一版记录之前**的计数快照。渲染这一版时必须用它，
     *     不能用 `counts`：落账会让新生条目的计数从 0 变成 1，而"新生试用位"
     *     的判据正是 `count===0` —— 用实时计数会让试用位在落账的下一帧就被取消，
     *     记录下来的交付集合与实际渲染集合对不上。
     */
    injectionLedger: {
      version: null,
      identity: null,
      ids: [],
      counts: {},
      frozenCounts: {},
      lastAt: null,
    },

    /** 最近一次生成的状态，给 UI 显示"为什么没更新"。 */
    lastRun: {
      at: null,
      ok: null,
      reason: '',
      error: null,
      spuriousRate: null,
      diff: null,
      /**
       * 最近一次生成用的材料预算 `{ chars, kept, dropped, total }`（超上限被裁掉多少）。
       *
       * 这里给 `null` 只是**形状**占位（`/state` 是界面契约，字段位从一开始就得在，
       * 否则界面按 `lastRun.material.dropped` 读会炸）。真实值由
       * index.js 的 `runProfileGeneration()` 在成功与失败两条路径都写入 ——
       * 那一侧的原则是"静默省略最糟"：材料被裁过就必须看得见。
       */
      material: null,
    },

    /**
     * 连续多少轮生成是 0 变更（新增 + 删除 + 改写 = 0）。
     *
     * 只用于自动生成的**饱和守卫**：画像超过软上限、且连续两轮零变更时，
     * 再跑一次也不会改变任何东西，暂停自动生成；等用户删除/封印后由
     * markEntry/clearMark 清零再重试。手动“重新生成”（force）不受限。
     */
    zeroChangeStreak: 0,

    updatedAt: 0,
  }
}

/**
 * 合并工作笔记：按 text 去重、单条 4–300 字、最多 `WORKING_NOTES_CAP` 条。
 * 返回新增条数；已有笔记原样保留（不重排、不改写）。
 *
 * @param {object} state
 * @param {string[]} notes
 * @param {number} [now]
 * @returns {number}
 */
export function appendWorkingNotes(state, notes, now = Date.now()) {
  if (!state || typeof state !== 'object') return 0
  if (!Array.isArray(state.workingNotes)) state.workingNotes = []
  const seen = new Set()
  for (const note of state.workingNotes) {
    const text = typeof note === 'string' ? note : note?.text
    if (typeof text === 'string') seen.add(text)
  }
  let added = 0
  for (const raw of Array.isArray(notes) ? notes : []) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text.length < 4 || text.length > 300 || seen.has(text)) continue
    state.workingNotes.push({ text, at: now })
    seen.add(text)
    added += 1
  }
  if (state.workingNotes.length > WORKING_NOTES_CAP) {
    state.workingNotes = state.workingNotes.slice(-WORKING_NOTES_CAP)
  }
  return added
}

/**
 * 一次性迁移：把旧画像里**本插件设计需求**那几条移到工作笔记。
 *
 * 只匹配 3 条铁证（"模式 1/2 同时生效"、"画像文本无上限"、"画像归纳器"），
 * 不用宽泛的项目关键词 —— "改动本机配置/插件"、"更新工具链"这类是通用的
 * 安全纪律，误移会丢规则。迁移是可逆的：文本进了 workingNotes，没有删。
 *
 * @param {object} state
 * @param {number} [now]
 * @returns {number} 迁移条数
 */
export function migrateProjectEntries(state, now = Date.now()) {
  if (!state || state.workingNotesMigrated === true) return 0
  const entries = Array.isArray(state.profile?.entries) ? state.profile.entries : []
  if (entries.length === 0) {
    // 还没有画像（新装）就没有旧数据可迁：直接置位。否则首版画像生成后的下一次启动，
    // 提到"模式 1/2""画像文本"的新条目会被当成旧的设计需求移走。
    state.workingNotesMigrated = true
    return 0
  }
  const matched = entries.filter(
    entry => typeof entry?.claim === 'string' && /模式\s*[12]|画像文本|画像归纳器/.test(entry.claim),
  )
  if (matched.length > 0) {
    appendWorkingNotes(state, matched.map(entry => entry.claim), now)
    const removed = new Set(matched)
    state.profile.entries = entries.filter(entry => !removed.has(entry))
  }
  state.workingNotesMigrated = true
  return matched.length
}

/** 极简文件日志：桌面端 stdout 不可见，必须同时落盘。 */
export function createLogger(name, level, file) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 }
  const threshold = levels[level] ?? 20
  const write = (lvl, args) => {
    if ((levels[lvl] ?? 20) < threshold) return
    const line = `${new Date().toISOString()} [${lvl}] ${name}: ${args
      .map(value => (typeof value === 'string' ? value : safeStringify(value)))
      .join(' ')}`
    console[lvl === 'debug' ? 'log' : lvl]?.(line)
    if (file) {
      try {
        fs.appendFileSync(file, `${line}\n`, 'utf8')
      } catch {
        /* 日志写不进去不能影响功能 */
      }
    }
  }
  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 状态仓库。
 */
export class StateStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dir] 状态目录，默认 `$DSH_HOME/prompt-adapt`
   * @param {ReturnType<typeof createLogger>} opts.log
   */
  constructor({ dir, log }) {
    this.log = log
    this.dir = dir || path.join(resolveDshHome(), 'prompt-adapt')
    this.stateFile = path.join(this.dir, 'state.json')
    this.cursorFile = path.join(this.dir, 'cursor.json')
    this.plainDir = path.join(this.dir, 'plain')
    this.historyDir = path.join(this.dir, 'profile-history')
    this.logFile = path.join(this.dir, 'plugin.log')
    this.state = emptyState()
    this.cursor = { version: 1, files: {} }
    this.#ensureDirs()
    this.#loadState()
    this.#loadCursor()
  }

  #ensureDirs() {
    for (const dir of [this.dir, this.plainDir, this.historyDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (error) {
        this.log?.warn(`[state] 无法创建目录 ${dir}: ${error?.message ?? error}`)
      }
    }
  }

  #loadState() {
    if (!fs.existsSync(this.stateFile)) return
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
    } catch (error) {
      // 读不动 / 解析不出来（半个 JSON、被清空、被另一个进程占住）时**不能就这么算了**：
      // 下一次 saveState() 会把这份文件整个覆盖掉，用户的 customText 与画像就没了。
      // 先原样挪到同目录留档，用户还能人工把内容抢救回去。
      const kept = this.#quarantineStateFile()
      this.log?.warn(
        `[state] 载入失败（将重新开始）: ${error?.message ?? error}` +
          (kept ? `；原文件已留档为 ${kept}` : '；⚠️ 原文件留档失败，下一次写盘会覆盖它'),
      )
      return
    }
    try {
      if (!parsed || typeof parsed !== 'object') return
      const base = emptyState()
      // 原样留一份：判断"旧账有没有 frozenCounts"必须看**磁盘上的对象**，
      // 合并后的对象总会带上 base 的 `{}`（看不到键缺失）。
      const rawLedger = parsed.injectionLedger
      this.state = {
        ...base,
        ...parsed,
        // 逐层兜底，避免半旧的文件留下 undefined 字段
        copiedSnapshot: { ...base.copiedSnapshot, ...(parsed.copiedSnapshot ?? {}) },
        lastGeneration: { ...base.lastGeneration, ...(parsed.lastGeneration ?? {}) },
        lastRun: { ...base.lastRun, ...(parsed.lastRun ?? {}) },
        injectionLedger: { ...base.injectionLedger, ...(parsed.injectionLedger ?? {}) },
      }
      // 模式值兜底：非法值一律退回自动画像，绝不出现"两个都开"的状态
      if (this.state.mode !== MODE.AUTO && this.state.mode !== MODE.CUSTOM) {
        this.log?.warn(`[state] mode 取值非法（${parsed.mode}），已退回 ${MODE.AUTO}`)
        this.state.mode = MODE.AUTO
      }
      // 字段类型兜底：`effective()` 会对这两个字段调 `.trim()`，非字符串会让**每一次**
      // GET /state 变成 500（设置页显示"未连接宿主"），用户连看到状态、动手修的机会都没有。
      for (const field of ['customText', 'autoExtraText']) {
        if (typeof this.state[field] !== 'string') {
          this.log?.warn(`[state] ${field} 不是字符串（${typeof this.state[field]}），已按空文本处理`)
          this.state[field] = ''
        }
      }
      // 饱和守卫的计数器：旧 state 没有这个字段（base 会给 0），手改坏时兜成 0。
      if (!Number.isFinite(this.state.zeroChangeStreak) || this.state.zeroChangeStreak < 0) {
        this.state.zeroChangeStreak = 0
      }
      // 条目处置标记必须是数组：`Array.isArray` 的判据散布在注入/生成/界面三处，
      // 这里不兜住的话，一个手改坏的 state.json 会让每一次渲染都抛（同上，500）。
      // ⚠️ 这只是**形状**兜底，不是"清空标记"：合法的处置记录一个都不动。
      if (!Array.isArray(this.state.entryMarks)) {
        this.log?.warn(
          `[state] entryMarks 不是数组（${typeof this.state.entryMarks}），已按空标记清单处理`,
        )
        this.state.entryMarks = []
      }
      // 清掉清单里形状不对的项（`null` / 字符串），否则它们会在比对时被当成"空结论"。
      // 只过滤，不改写留下来的那些。
      const markKept = this.state.entryMarks.filter(
        record => record && typeof record === 'object',
      )
      if (markKept.length !== this.state.entryMarks.length) {
        this.log?.warn(
          `[state] entryMarks 里有 ${this.state.entryMarks.length - markKept.length} 项不是对象，已丢弃`,
        )
        this.state.entryMarks = markKept
      }
      // 注入落账的形状兜底：`ids` 必须是数组、`counts` 必须是普通对象。
      // 坏形状会让"新生试用位"把 undefined 当计数（`NaN >= 0` 恒 false 之类的静默失效）。
      if (!this.state.injectionLedger || typeof this.state.injectionLedger !== 'object') {
        this.state.injectionLedger = { version: null, ids: [], counts: {}, frozenCounts: {}, lastAt: null }
      }
      if (!Array.isArray(this.state.injectionLedger.ids)) {
        this.log?.warn('[state] injectionLedger.ids 不是数组，已清空')
        this.state.injectionLedger.ids = []
      }
      const counts = this.state.injectionLedger.counts
      if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
        this.log?.warn('[state] injectionLedger.counts 不是对象，已清空')
        this.state.injectionLedger.counts = {}
      }
      const frozen = this.state.injectionLedger.frozenCounts
      if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)) {
        // 旧账没有 frozenCounts：用当前 counts 补一个，避免"这一版渲染时突然全部
        // 变成新生"（会把试用位挤爆）。
        this.state.injectionLedger.frozenCounts = { ...this.state.injectionLedger.counts }
      } else if (
        rawLedger &&
        typeof rawLedger === 'object' &&
        !Object.prototype.hasOwnProperty.call(rawLedger, 'frozenCounts')
      ) {
        // 关键：磁盘上的旧账**没有这个键**时，合并后的 `{}` 是 base 给的假对象，
        // 上面的 `!frozen` 判不出来。这里必须补一份，否则旧账升级后这一版
        // 所有条目都是"新生"，试用位会一次挤进两个本不该有的条目。
        // 用**已兜底过的** counts（raw 的可能是数组/坏值，spread 出来是索引键）。
        this.state.injectionLedger.frozenCounts = { ...this.state.injectionLedger.counts }
      }
      // 工作笔记：数组 + 每项 {text, at}；去重、裁剪；旧 state 没有 → 空数组。
      const rawNotes = Array.isArray(parsed.workingNotes) ? parsed.workingNotes : []
      const notesSeen = new Set()
      const notes = []
      for (const item of rawNotes) {
        const text =
          typeof item === 'string'
            ? item.trim()
            : item && typeof item.text === 'string'
              ? item.text.trim()
              : ''
        if (text.length < 4 || notesSeen.has(text)) continue
        notesSeen.add(text)
        notes.push({ text, at: Number(item?.at) || 0 })
      }
      if (!Array.isArray(parsed.workingNotes)) {
        this.log?.warn('[state] workingNotes 不是数组，已按空清单处理')
      }
      this.state.workingNotes = notes.slice(-WORKING_NOTES_CAP)
      if (typeof this.state.workingNotesMigrated !== 'boolean') {
        this.state.workingNotesMigrated = false
      }
      this.log?.info(
        `[state] 已载入 mode=${this.state.mode} 画像条目=${
          this.state.profile?.entries?.length ?? 0
        } 自定义文本=${this.state.customText?.length ?? 0} 字`,
      )
    } catch (error) {
      this.log?.warn(`[state] 载入失败（将重新开始）: ${error?.message ?? error}`)
    }
  }

  /**
   * 把读不动的 `state.json` 原样挪到同目录留档，返回留档路径。
   *
   * 挪不动（权限 / 被占用）时返回 `null`：那种情况下只能靠日志告诉用户
   * "它将被下一次写盘覆盖"。**只对 state.json 做这件事** ——
   * `cursor.json` 是派生数据（坏了只是从零全量重扫），`plain/` 可以重新解压，
   * 都没有"用户数据被覆盖掉就回不来"的问题。
   *
   * @returns {string|null}
   */
  #quarantineStateFile() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const kept = `${this.stateFile}.corrupt-${stamp}`
    try {
      fs.renameSync(this.stateFile, kept)
      return kept
    } catch (error) {
      this.log?.warn(`[state] 留档失败: ${error?.message ?? error}`)
      return null
    }
  }

  #loadCursor() {
    try {
      if (!fs.existsSync(this.cursorFile)) return
      const parsed = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.files) {
        /**
         * ⚠️ `rotor`（帧预算的轮转起点，见 `lib/sessions.js` 的"位置性饥饿"）必须
         * 一起读回来：它由 `scan()` 写在 `cursor` 上、由这里落盘，漏掉它就是
         * "写进去但读不回来" —— 轮转相位每次重启都归零，冷启动后要重新一轮轮前移
         * （正确性不受影响，因为 `rotateFrom()` 找不到那个 rel 时会退回表头，
         * 但"排在后面的文件"会重新挨饿）。
         */
        this.cursor = { version: parsed.version ?? 1, files: parsed.files, rotor: parsed.rotor ?? null }
        this.log?.info(`[cursor] 已载入 ${Object.keys(this.cursor.files).length} 个文件的帧水位`)
      }
    } catch (error) {
      this.log?.warn(`[cursor] 载入失败（将从零全量扫描）: ${error?.message ?? error}`)
    }
  }

  /**
   * 原子写。
   *
   * ⚠️ 临时文件名**必须带 pid**。同一台机器上可能同时跑着两个宿主进程、共用同一个
   * `DSH_HOME`（桌面端 + CLI/QQ 宿主），固定叫 `${file}.tmp` 时两个进程会 rename
   * 到**对方正在写**的那个临时文件上：先 rename 的那个把对方那份**写到一半**的
   * 文件发布成了正式文件 —— 对方若在同一瞬间被中断（进程被杀 / 断电），
   * state.json 就永久停在半个 JSON 上；即使对方没被中断，后 rename 的那个也会
   * 拿到 ENOENT（`saveState` 只记一条 warn，这一次写盘静默丢失）。
   * 带上 pid 之后每个进程只动自己的临时文件，互相看不见。
   */
  #writeJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  saveState() {
    try {
      this.state.updatedAt = Date.now()
      this.#writeJson(this.stateFile, this.state)
    } catch (error) {
      this.log?.warn(`[state] 保存失败: ${error?.message ?? error}`)
    }
  }

  saveCursor() {
    try {
      this.#writeJson(this.cursorFile, this.cursor)
    } catch (error) {
      this.log?.warn(`[cursor] 保存失败: ${error?.message ?? error}`)
    }
  }

  /**
   * 把一次注入计划的交付结果记进 `state.injectionLedger`。
   *
   * 语义：`identity` 是**版本身份**（`generatedAt:version`），`version` 只用于展示。
   * 为什么不用版本号当身份：`clearProfile()` 之后版本号会从 1 重新开始，用 `version`
   * 去重会把清空后的新 v1 当成旧 v1（实测会丢掉整本账）。
   *
   * 同一身份：
   *   · 已记过的 id 不重复计数（生成时落账 + 封印/解封后同步会各调一次）；
   *   · **新进注入集合的 id 会补记一次**（用户封印前面的条目后，原本被预算截掉的
   *     条目可能在这一版中途进入 prompt —— 它确实交付了，账要跟上）；
   *   · `frozenCounts` 不动：它是这一版渲染时做试用位判据的快照，中途改会让
   *     同一版的取舍抖动。
   * 换身份：先冻结旧 counts（供这一版渲染用），再给新进集合自增。
   *
   * 为什么用条目 id 记账：`planProfileInjection()` 的 `injectedIds` 就是 id，
   * 试用位/退役判据都按 id 查。条目被删掉后旧 id 会留在账上（无害的死键）；
   * 条目被改写后沿用旧 id 的情况会被算作"同一条"，这是当前契约下的已知近似。
   *
   * @param {{injectedIds?: string[]}} plan `planProfileInjection()` 的结果
   * @param {number|null} version 画像版本号（展示用）
   * @param {string} [identity] 版本身份（`generatedAt:version`）；省略时退回 `v<version>`
   * @returns {boolean} 是否真的记了一笔（同身份同集合重复调用返回 false）
   */
  recordInjection(plan, version, identity) {
    const versionNumber = Number.isFinite(version) ? Number(version) : null
    const identityKey = identity === undefined || identity === null ? `v${versionNumber}` : String(identity)
    const ledger = this.state.injectionLedger
    if (!ledger || typeof ledger !== 'object') return false
    const ids = Array.isArray(plan?.injectedIds)
      ? plan.injectedIds.filter(id => typeof id === 'string' && id.length > 0)
      : []
    const counts = ledger.counts && typeof ledger.counts === 'object' && !Array.isArray(ledger.counts)
      ? ledger.counts
      : {}
    const increment = id => {
      const previous = Number(counts[id])
      counts[id] = (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1
    }
    if (ledger.identity !== identityKey) {
      // 换版本：冻结"落账之前"的计数（这一版渲染时的试用位判据），重置本版集合。
      ledger.frozenCounts = { ...counts }
      ledger.identity = identityKey
      ledger.version = versionNumber
      ledger.ids = []
      for (const id of ids) increment(id)
      ledger.ids = ids
      ledger.lastAt = Date.now()
      this.state.injectionLedger = ledger
      return true
    }
    // 同一版本中途的补充：只给**新进集合**的 id 记一次；已记过的不重复。
    const known = new Set(ledger.ids)
    const merged = [...ledger.ids]
    let added = 0
    for (const id of ids) {
      if (known.has(id)) continue
      known.add(id)
      merged.push(id)
      increment(id)
      added += 1
    }
    if (added === 0) return false
    ledger.ids = merged
    ledger.counts = counts
    ledger.lastAt = Date.now()
    this.state.injectionLedger = ledger
    return true
  }

  /**
   * 「当前生效画像文本」的**唯一**产出点。
   *
   * 硬规则：模式 1 与模式 2 不能同时开启 —— 由 `mode` 单字段枚举保证，
   * 这个函数是它唯一的读取出口。
   *
   * ⚠️ 这里是**全文**：UI 的 `getState().effectiveText`、复制快照
   * （`markCopied`）、以及「从模式 1 填入」都读它，所以它绝不能裁剪。
   * 注入系统提示请用 `effectiveForInjection()`。
   *
   * @returns {{mode:string, text:string, source:string}}
   */
  effective() {
    const mode = this.state.mode === MODE.CUSTOM ? MODE.CUSTOM : MODE.AUTO
    if (mode === MODE.CUSTOM) {
      const text = (this.state.customText ?? '').trim()
      return { mode, text, source: 'customText' }
    }
    // 动态 import 会破坏"每步求值必须同步且极快"的要求，
    // 所以渲染函数由 index.js 注册进来（见 setProfileRenderer）。
    const rendered = this.#renderProfile()
    const extra = (this.state.autoExtraText ?? '').trim()
    const text = [rendered, extra].filter(Boolean).join('\n\n').trim()
    return { mode, text, source: 'profile' }
  }

  /**
   * 「注入系统提示」用的生效文本。
   *
   * 与 `effective()` **只差一处**：模式 1 下画像部分按 token 预算裁剪
   * （渲染函数是 `setInjectionRenderer` 注册的那个）。
   * 模式 2 是用户手写的文本，按原样注入，不裁剪 —— 那是用户明确要注入的内容。
   *
   * 裁剪只发生在这里：`state.profile` 里仍是完整画像，`effective()` 仍是全文，
   * 所以 `state.json`、界面、复制、`diffProfiles()` 都不受影响。
   *
   * @returns {{mode:string, text:string, source:string}}
   */
  effectiveForInjection() {
    const mode = this.state.mode === MODE.CUSTOM ? MODE.CUSTOM : MODE.AUTO
    if (mode === MODE.CUSTOM) return this.effective()
    const rendered = this.#renderProfileForInjection()
    const extra = (this.state.autoExtraText ?? '').trim()
    const text = [rendered, extra].filter(Boolean).join('\n\n').trim()
    return { mode, text, source: 'profile' }
  }

  /** @type {null | ((profile:object|null)=>string)} */
  #profileRenderer = null

  /**
   * 注入专用的渲染函数（**带 token 预算**，由 `lib/index.js` 注册）。
   *
   * ⚠️ 与 `#profileRenderer` 分开是硬要求，不是洁癖：
   * `effective()` 的产出是「用户复制到模式 2 的**全文**」，
   * 它绝不能是被预算裁剪过的注入版 —— 两条路径共用一个渲染器时，
   * 用户一复制就会拿到残缺的画像，而界面上显示的还是完整的那份。
   */
  /** @type {null | ((profile:object|null)=>string)} */
  #injectionRenderer = null

  setProfileRenderer(fn) {
    this.#profileRenderer = fn
  }

  /**
   * 注册注入用的渲染函数（按预算裁剪）。
   *
   * 没有注册时注入侧**什么都不注入**（fail-closed）：宁可这一步没有画像，
   * 也不要退回"全量注入"那条无上限的老路（本函数存在的理由就是它）。
   */
  setInjectionRenderer(fn) {
    this.#injectionRenderer = fn
  }

  #renderProfile() {
    if (!this.#profileRenderer) return ''
    try {
      return this.#profileRenderer(this.state.profile)
    } catch (error) {
      // 画像形状不是渲染器预期的样子（外部改过 state.json、旧版本残留）时，
      // **绝不能让 effective() 抛**：`getState()` 读它，抛了就是每一次 GET /state 都 500,
      // 设置页只会显示"未连接宿主"，用户连看到状态、动手修的机会都没有。
      // 这里只把**生效文本**当作空；`state.profile` 原样留在状态里（GET /state 仍能看到）。
      this.log?.warn(`[state] 画像渲染失败（本次按空画像处理）: ${error?.message ?? error}`)
      return ''
    }
  }

  #renderProfileForInjection() {
    if (!this.#injectionRenderer) return ''
    return this.#injectionRenderer(this.state.profile)
  }

  /** 把画像快照写进 `profile-history/`，只增不删。 */
  archiveProfile(profile, diff) {
    try {
      const stamp = new Date(profile.generatedAt ?? Date.now()).toISOString().replace(/[:.]/g, '-')
      const file = path.join(this.historyDir, `v${profile.version}-${stamp}.json`)
      this.#writeJson(file, { profile, diff })
      return file
    } catch (error) {
      this.log?.warn(`[state] 画像归档失败: ${error?.message ?? error}`)
      return null
    }
  }
}
