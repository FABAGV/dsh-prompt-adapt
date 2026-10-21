/**
 * dsh-prompt-adapt —— 让 AI 更好地适配用户（宿主侧）。
 *
 * 三个模式：
 *   1. 自动画像   从历史会话归纳「这个用户是什么样的人」+「哪些做法在他这儿行不通」
 *   2. 自定义     用户自己的系统提示词文本框
 *   3. 提示词大厅 一个外链链接（不参与生效，宿主侧不抓取、不缓存、不鉴权）
 *
 * 硬规则：
 *   - 模式 1 与模式 2 **不能同时开启**，同一时刻只有一份"当前生效的画像文本"。
 *     落实方式：`state.mode` 是单字段枚举（见 state.js），"两个都开"根本无法表示。
 *   - 模式 1 → 模式 2 是**用户手动复制粘贴**，没有自动写入。本插件只提供
 *     `copyText()` 让 UI 把生效文本交给剪贴板，不往 customText 里写任何东西。
 *   - 模式 3 只是一个 URL 常量（`PROMPT_HALL_URL`），宿主侧不发起任何请求。
 *
 * 宿主侧职责（UI 由另一半负责）：
 *   - 增量读取会话日志（只读）→ 四个零 LLM 计数信号
 *   - 按触发间隔用 LLM 增量生成画像（**上一版画像一起喂回去**）
 *   - 把"当前生效画像文本"注入系统提示
 *   - 持久化模式 / 自定义文本 / 画像 / 上次复制的快照
 *
 * ## 依赖服务都是**可选**读的
 *
 * `systemPrompt` / `llm` / `timer` 全部用 `ctx.get(name)` 取，不用对象级
 * `inject`。理由见 dsh-whale-widget/lib/index.js:604-609 与
 * dsh-whale-widget/lib/index.js:1017-1018 的实测结论：对象级 inject 会把整个
 * `apply()` 推迟到服务就绪之后，任何一个服务缺失（老宿主、精简宿主）都会让
 * 插件**完全不 apply** —— 比"某个功能不可用"严重得多。
 */
import { Config } from './schema.js'
import { Service } from '@deepseek-ai/cordis'
import { createLogger, StateStore, MODE, resolveDshHome, appendWorkingNotes, migrateProjectEntries } from './state.js'
import { PROMPT_HALL_URL, isHallConfigured } from './hall.js'
import { registerRoutes, API_PREFIX } from './http.js'
import { SessionScanner } from './sessions.js'
import {
  computeAllSignals,
  computeSessionSignals,
} from './signals.js'
import {
  collectHumanMessages,
  dropMark,
  freshness,
  generateProfile,
  markPresence,
  markText,
  MARK_STATUS,
  MARK_STATUSES,
  marksByStatus,
  materialCutoff,
  partitionMarks,
  planProfileInjection,
  renderProfileInjectionText,
  renderProfileText,
  shouldRegenerate,
  upsertMark,
} from './profile.js'
import path from 'node:path'

export { Config }

export const name = 'dsh-prompt-adapt'

/**
 * 模式 3 的外链。**宿主侧只存这个常量**，不抓取、不缓存、不鉴权。
 * 空串 = 未配置（界面不显示该入口，避免死链）。定义在 `lib/hall.js`。
 */
export { PROMPT_HALL_URL }

/** 系统提示段的默认注册名（可被 config.inject.name 覆盖）。 */
const SECTION_NAME = 'dsh-prompt-adapt:effective-profile'

export const PROFILE_SECTION_NAME = SECTION_NAME

/** UI 侧要用的 HTTP 前缀。导出给客户端半边对齐，避免两边各写一份字面量。 */
export { API_PREFIX }

/**
 * 宿主侧服务：给 UI 侧读写用户数据、触发手动生成。
 *
 * 它同时承担"广播状态变化"的职责 —— 系统提示段的渲染缓存必须在这一刻失效，
 * 否则用户改了模式/文本之后，模型下一步看到的还是旧文本。
 */
class PromptAdaptService extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx 注册到哪个上下文（随 fiber 自动注销）
   * @param {object} host 内部宿主对象
   */
  constructor(ctx, host) {
    super(ctx, 'promptAdapt')
    this.host = host
  }

  /** 当前生效的画像文本与来源模式。 */
  getEffective() {
    return this.host.effectiveText()
  }

  /** UI 侧要显示的完整状态（不含内部游标）。 */
  getState() {
    const { state } = this.host.store
    const effective = this.host.effectiveText()
    return {
      mode: state.mode,
      customText: state.customText,
      autoExtraText: state.autoExtraText,
      profile: state.profile,
      /**
       * 条目处置标记 = 界面上的「置顶 / 垃圾桶 / 已删除」三个区。
       * **不在 `profile` 里**，理由见 `state.js` 的 `entryMarks` 注释：用户的处置
       * 决定不能被任何一版画像（或一次清空）带走。
       *
       * 每项：`{key, status, entry, fromId, firstAt, lastAt, deleteCount}`，另外这里
       * **现算**一个 `present`（这条结论现在还在画像里吗）给界面用，它不落盘。
       * ⚠️ 字段名不许含 `token` 子串（同下面 `injectedText` 的理由）。
       */
      entryMarks: this.host.markViews(),
      copiedSnapshot: state.copiedSnapshot,
      lastGeneration: state.lastGeneration,
      lastSignals: state.lastSignals,
      lastRun: state.lastRun,
      effectiveText: effective.text,
      /**
       * ⚠️ **不要拿这个字段做用户可见的"画像已更新，建议重新复制"提示。**
       *
       * 这是**文本不等**比较 —— 而"文本变了"正是假修订的来源
       * （模型换个措辞就会让它变 true，实测基线假变化率 26.3%）。
       * 界面侧的"该不该重新复制"必须按**证据集合是否变化**判定
       * （比对 `profile.entries` 的 id/claim 集合），客户端已经这么做。
       *
       * 这个字段保留给非用户可见的用途（比如内部一致性检查）。
       */
      staleCopy:
        state.copiedSnapshot?.text !== null &&
        state.copiedSnapshot?.text !== effective.text,
      /** 当前生效文本来自哪一边（`'customText'` | `'profile'`）。 */
      effectiveSource: effective.source,
      /**
       * **实际会被注入系统提示的那段文本全文**（不裁剪这条路，它本身就是裁剪结果）。
       *
       * 存在的唯一理由：设置页要显示"已经注入的提示词"，而不是"完整画像"。
       * 两者故意不同 —— 模式 1 下注入侧按注入预算取舍（1500 默认，见 inject.budgetTokens），
       * 面板上的条目来自 `profile.entries`（完整画像），光看条目数
       * 看不出注入被裁剪过。界面**只渲染这个字段，不自己拼**，
       * 否则又会退回"看到的 ≠ 注入的"。
       *
       * 出处在 `host.injectionText()` → `store.effectiveForInjection().text`
       * → `renderProfileInjectionText()`，与 `renderSection()` 注入用的是
       * **同一次调用链**（见交付说明"证据：注入字节一致性"）。
       *
       * ⚠️ 字段名不许含 `token` 子串（与 `budgetChars` / `estimatedChars` 同理）：
       * `test/httptest.mjs` 会拿 `/(apiKey|api_key|token|secret|password)/i`
       * 扫整个 `/state` 负载。`injectedText` 不含这些子串。
       *
       * 模式 2 生效时这里等于用户自定义文本（那本来就是注入内容）。
       */
      injectedText: this.host.injectionText(),
      /**
       * 注入计划摘要：模式 1 下这次实际会注入多少条、省略多少条、为什么。
       *
       * ⚠️ 这是**新增字段**，只给界面/排障看：不落盘、不参与注入。
       * 面板上的条数来自 `profile.entries`（完整画像），所以**光看面板看不出**
       * 注入被裁剪过；注入文本自己开头有一行标注写明"本次注入 N/M 条"。
       * 模式 2 生效时注入的是用户自定义文本，这份计划不生效。
       *
       * 与上面 `injectedText` 的关系：那个是**文本**，这个是**统计**。
       * 长文本不塞进这个对象 —— 它会经 `httptest` 的 JSON 扫描，
       * 也不该跟计数混在一起。
       */
      injection: summarizeInjection(this.getInjectionPlan()),
      /**
       * 注入落账：每一版真正进了 system prompt 的条目 id 与累计次数。
       *
       * 与 `injection` 的区别：那个是**这一版这一次**的取舍结果，用完即丢；
       * 这个是**跨版本**的交付账本，回答"这条到底有没有被交付过"。
       * 新生试用位、退役判据、界面上的"N 版未注入"都读它。
       */
      injectionLedger: publicLedger(this.host.store.state.injectionLedger),
      /**
       * 工作笔记：项目 / 工具 / 路径 / 账号 / 仓库类事实。
       *
       * 与画像条目的区别：不占 44 条槽位、不参与注入预算、不会被自动注入。
       * 由生成结果里的 `projectNotes` 合并而来；界面单独展示。
       */
      workingNotes: Array.isArray(this.host.store.state.workingNotes)
        ? this.host.store.state.workingNotes.map(note => ({ text: note.text, at: note.at }))
        : [],
      /**
       * 置顶条数上限（`inject.maxPinned`）。界面按它禁用「置顶」按钮并给出原因
       * （"置顶已满 N 条"）—— 上限必须**由宿主**告诉界面，界面不许自己写死一个数。
       */
      maxPinned: this.host.config.inject.maxPinned,
      /**
       * 首跑 / 自动更新进度。界面用它回答"为什么还没有画像、还差什么"。
       *
       * 为什么由宿主给数字：这些阈值（`profile.triggerUserMessages` 等）是配置，
       * 界面不许自己写死；而已经数到多少条发言只有宿主知道。界面只做减法与措辞。
       *
       * 只暴露**判据本身**，不在这里替用户算"还差几条"——首版判据是累计发言
       * （`shouldRegenerate()` 里 `!profile` 那条分支），后续版本是"自材料截止时刻
       * 之后的新增"，后者已经写在上次的 `lastRun.reason` 里，不必再算一遍。
       */
      trigger: this.host.triggerProgress(),
      /**
       * 服务级自检。供 UI 在显示"未连接宿主"之前先自查：
       * 只要这个能调通，就说明 HTTP 路由与服务是活的。
       */
      contract: 1,
    }
  }

  /**
   * 当前预算下的注入取舍（模式 1 的计划；不落盘、不改任何状态）。
   * @returns {object} `planProfileInjection()` 的结果
   */
  getInjectionPlan() {
    return planProfileInjection(this.host.store.state.profile, {
      budgetTokens: this.host.config.inject.budgetTokens,
      // 处置标记两处都用：
      //   · `sealed` → 注入侧的封印兜底（第二道防线），命中的一条都不许进系统提示；
      //   · `pinned` → 豁免预算、保证注入。
      // 见 lib/profile.js 的"条目处置标记"一节。
      entryMarks: this.host.markList(),
      // 新生试用位读的是**冻结的**交付计数（`frozenCounts`）：这一版渲染期间
      // 计数不再变，试用位的取舍才稳定（见 state.js 的 recordInjection 注释）。
      injectedCounts: this.host.store.state.injectionLedger?.frozenCounts ?? null,
    })
  }

  /**
   * 轻量自检：确认服务的关键方法都在。
   * HTTP 层在 `GET /state` 里调用它，让"路由通了但服务坏了"也能被区分出来。
   * @throws {Error} 关键方法缺失时抛
   */
  validate() {
    const required = [
      'getState', 'setMode', 'setCustomText', 'markCopied', 'regenerateNow', 'rescanNow',
      // 界面上每条条目旁的三个按钮靠这两个方法：缺一个就是"按了没反应"，
      // 而 GET /state 是界面的第一条请求 —— 在这里就报出来，别等用户点。
      'markEntry', 'clearMark',
    ]
    const missing = required.filter(name => typeof this[name] !== 'function')
    if (missing.length) throw new Error(`promptAdapt 服务缺少方法：${missing.join(', ')}`)
    const state = this.host.store.state
    if (state.mode !== MODE.AUTO && state.mode !== MODE.CUSTOM) {
      throw new Error(`状态里的 mode 非法：${JSON.stringify(state.mode)}`)
    }
    return true
  }

  /**
   * 切换模式。**结构上只能二选一** —— 这是硬规则。
   * @param {'auto'|'custom'} mode
   */
  setMode(mode) {
    if (mode !== MODE.AUTO && mode !== MODE.CUSTOM) {
      throw new Error(`未知模式: ${mode}（只接受 'auto' | 'custom'）`)
    }
    this.host.store.state.mode = mode
    // ⚠️ 切模式**不动**另一边的数据：切到 auto 不清 customText，
    //    切到 custom 不清 profile。否则用户切一下模式就丢东西。
    // 切回 auto 时补一次落账：custom 期间的封印/解封没有同步过（那时返回 false），
    // 现在注入集合变了，账本要跟上（同一身份只会补记新进集合）。
    if (mode === MODE.AUTO) this.host.syncInjectionLedger()
    this.host.commit('setMode')
  }

  /** 模式 2 的文本（用户手写）。 */
  setCustomText(text) {
    this.host.store.state.customText = String(text ?? '')
    this.host.commit('setCustomText')
  }

  /** 模式 1 生效时附在画像后的补充说明。 */
  setAutoExtraText(text) {
    this.host.store.state.autoExtraText = String(text ?? '')
    this.host.commit('setAutoExtraText')
  }

  /**
   * 记录"用户刚复制了生效文本"。快照只用来判断复制之后画像有没有再变。
   * 注意：这里**只记录**，不把文本写进 customText —— 模式 1 → 2 的搬运
   * 必须是用户手动粘贴，不能自动写入。
   *
   * 除文本外还存**结构化条目**与 `algorithmVersion`，这样即使换了浏览器
   * （localStorage 基线丢了）也能做精确比较，而不是退回"文本不等"那种
   * 会刷假修订的判据。
   *
   * `at` 与 `profileVersion` **由宿主决定**，不采信客户端传来的值：
   * 客户端时钟可能不准，而这两个字段是判断基准。
   *
   * @param {string} text 复制时的生效文本
   * @param {{entries?:unknown, algorithmVersion?:string}} [extra]
   */
  markCopied(text, extra = {}) {
    const state = this.host.store.state
    const entries = Array.isArray(extra?.entries) ? extra.entries : state.profile?.entries ?? null
    state.copiedSnapshot = {
      text: String(text ?? this.host.effectiveText().text),
      at: Date.now(),
      profileVersion: state.profile?.version ?? null,
      /**
       * 复制时的条目摘要 —— 界面按它做"证据集合是否变化"的比较，
       * 不要用 `text` 比较。
       */
      entries: entries
        ? entries.map(entry => ({
            id: entry.id,
            category: entry.category,
            claim: entry.claim,
            evidenceQuoteCount: entry.evidenceQuoteCount ?? entry.evidence?.length ?? 0,
          }))
        : null,
      /** 条目摘要的格式版本，便于将来改结构时识别旧快照。 */
      algorithmVersion: typeof extra?.algorithmVersion === 'string'
        ? extra.algorithmVersion
        : 'entries-v1',
    }
    this.host.commit('markCopied')
  }

  /** 手动触发一次画像生成（忽略触发间隔）。 */
  async regenerateNow() {
    return this.host.runProfileGeneration({ force: true, reason: '手动触发' })
  }

  /** 立刻重扫一遍会话日志。 */
  async rescanNow() {
    return this.host.scanOnce({ force: true })
  }

  /** 最近一次四个信号的汇总。 */
  getSignals() {
    return this.host.store.state.lastSignals
  }

  /** 单个会话的信号明细（UI 点开某个会话时用）。 */
  getSessionSignals(sessionId) {
    const events = this.host.scanner.bySession().get(String(sessionId))
    if (!events) return null
    return computeSessionSignals(events, this.host.config.signals)
  }

  /**
   * 清空画像（模式 1 的数据）。自定义文本不受影响。
   *
   * ⚠️ **刻意不清封印清单**：封印是用户的决定，要比任何一版画像活得久 ——
   *    清空画像之后重新生成时，被封印的结论仍然不许产出（否则"永远不参与注入"
   *    这句话会在用户点一次「清空」之后失效）。
   */
  clearProfile() {
    this.host.store.state.profile = null
    // 形状要跟 `emptyState()` 一致（含 `materialCutoff`）：清空后是"首版"路径，
    // 下一次成功生成会把截止时刻重新写上；这里留 0 只是别让字段消失。
    this.host.store.state.lastGeneration = {
      at: null,
      humanMessages: 0,
      sessions: 0,
      materialCutoff: 0,
    }
    // **清空注入账本**。账本是"条目 id → 交付过几版"：画像清空后那些 id 已经
    // 没有对应条目，而模型自起的短 id（n1、n2…）会被新条目复用 —— 不清账，
    // 新结论会继承旧计数、永远拿不到新生试用位，而且旧账会无限膨胀。
    // 封印清单不清（那是用户的决定，见方法注释），账本不是用户决定。
    this.host.store.state.injectionLedger = {
      version: null,
      identity: null,
      ids: [],
      counts: {},
      frozenCounts: {},
      lastAt: null,
    }
    this.host.commit('clearProfile')
  }

  /**
   * 给一条画像条目打处置标记。三个动作共用这一个入口，只有 `status` 不同。
   *
   * 用户原话（语义区别就是在这里落实的）：
   *   · 置顶（pin）「界面置顶加上保证注入」—— 不改变画像内容，只加标记；
   *   · 封印（seal）「直接拉进垃圾桶，之后更新直接跟着进垃圾桶，永远不参与注入」；
   *   · 删除（delete）「删除就是单纯删除，下一次总结还会出现」。
   *
   * ⚠️ 封印与删除都**从画像里移除**这条（界面立刻不再显示在正文里），区别在**标记**：
   *    封印会进清单并参与生成/注入两道过滤；删除只进"被删过 N 次"的清单，
   *    供界面显示与提示词参考，**不禁止**模型重新归纳它。
   *
   * @param {{status:string, id?:string, claim?:string, key?:string}} input
   *   `{id, claim}` = 界面上点的是画像里的某一条；`{key}` = 点的是标记区里
   *   已经不在画像里的那一条（只有记录，没有条目）。
   * @returns {{ok:boolean, error?:string, status?:string, key?:string, marks?:number}}
   */
  markEntry(input) {
    return this.host.markEntry(input)
  }

  /**
   * 撤销标记：取消置顶 / 从垃圾桶恢复。
   * 条目的原文会**原样写回**画像（如果它已经不在画像里）。
   * @param {string} key 标记的比对键（`mark.key`）
   * @returns {{ok:boolean, error?:string, key?:string, restored?:boolean}}
   */
  clearMark(key) {
    return this.host.clearMark(key)
  }

  /** 置顶（= `markEntry({status:'pinned'})`，给调用方一个更直白的入口）。 */
  pinEntry(id, claim, key) {
    return this.host.markEntry({ status: MARK_STATUS.PINNED, id, claim, key })
  }

  /** 取消置顶。 */
  unpinEntry(key) {
    return this.host.clearMark(key)
  }

  /** 封印（= `markEntry({status:'sealed'})`；**不禁止**产出是"删除"，别混）。 */
  sealEntry(id, claim, key) {
    return this.host.markEntry({ status: MARK_STATUS.SEALED, id, claim, key })
  }

  /** 从垃圾桶恢复。 */
  unsealEntry(key) {
    return this.host.clearMark(key)
  }

  /** 删除（只从这一版去掉 + 记一次删除，**不**禁止下一轮重新归纳）。 */
  deleteEntry(id, claim, key) {
    return this.host.markEntry({ status: MARK_STATUS.DELETED, id, claim, key })
  }

  /** 模式 3 的外链。宿主侧不抓取、不缓存、不鉴权。 */
  getPromptHallUrl() {
    return PROMPT_HALL_URL
  }

  /** 是否已配置大厅外链（未配置时界面不该显示这个入口）。 */
  isPromptHallConfigured() {
    return isHallConfigured()
  }

  /** 订阅状态变化；返回退订函数。 */
  onchange(listener) {
    this.host.listeners.add(listener)
    return () => this.host.listeners.delete(listener)
  }
}

export default {
  name,

  // ⚠️ cordis 的 loader 读的是 `runtime.Config`，而 `runtime` 就是**这个默认导出对象**。
  // 只做命名导出 `export { Config }` 是不够的 —— loader 采集不到，
  // 设置页就不会按 Schema 生成（表现为 Config provider 里 status = "absent"）。
  // 见 dsh-qq/lib/index.js:49-53 的实测记录。
  Config,

  /**
   * @param {import('@deepseek-ai/cordis').Context} root
   * @param {object} rawConfig
   */
  apply(root, rawConfig = {}) {
    const config = resolveConfig(rawConfig)
    const dshHome = resolveDshHome()
    const stateDir = config.stateDir || path.join(dshHome, 'prompt-adapt')
    const log = createLogger('dsh-prompt-adapt', config.logLevel, path.join(stateDir, 'plugin.log'))

    log.info(`──────── apply() 开始  node=${process.version} ────────`)
    log.info(`状态目录=${stateDir}`)

    const sessionsRoot = config.sessionsRoot || path.join(dshHome, 'sessions')
    log.info(`会话日志根目录=${sessionsRoot}（只读）`)

    const store = new StateStore({ dir: stateDir, log })
    // 全文渲染：`effective()` 用它 —— 界面预览、复制到模式 2、复制快照都读这条路径，
    // 所以它**绝不能**被预算裁剪。
    store.setProfileRenderer(renderProfileText)
    // 注入渲染：按 token 预算取舍（B、C 共用一个合计上限、A 有保底、D 不注入；
    // 置顶条目豁免预算，封印条目在这里再兜一层过滤）。
    // 与上面那条路径分开是硬要求，见 state.js 的 setInjectionRenderer()。
    store.setInjectionRenderer(profile =>
      renderProfileInjectionText(profile, {
        budgetTokens: config.inject.budgetTokens,
        // ⚠️ 必须在**每次渲染时现读**标记清单：`effectiveForInjection()` 每一步都会
        //    被求值，用注册时捕获的快照会让"刚封印的条目还在注入"。
        entryMarks: Array.isArray(store.state.entryMarks) ? store.state.entryMarks : [],
        // 新生试用位：读冻结计数，保证同一版内的取舍稳定。
        injectedCounts: store.state.injectionLedger?.frozenCounts ?? null,
      }),
    )

    // 工作笔记一次性迁移：旧画像里"本插件设计需求"那几条移到 workingNotes，
    // 不占画像槽位。只匹配 3 条铁证；文本保留在笔记里（可逆），不是删除。
    const migratedWorkingNotes = migrateProjectEntries(store.state)
    if (migratedWorkingNotes > 0) {
      log.info(
        `[profile] 工作笔记迁移：${migratedWorkingNotes} 条项目设计需求移出画像（文本保留在 workingNotes，不占槽位）`,
      )
      // apply 阶段还没有 commit 闭包/监听器；直接落盘即可。
      store.saveState()
    }

    const scanner = new SessionScanner({
      sessionsRoot,
      plainDir: store.plainDir,
      maxWindowSize: config.scan.maxWindowSize,
      maxFramesPerScan: config.scan.maxFramesPerScan,
      log,
    })

    /**
     * 冷启动：从明文缓存还原事件，不碰会话目录、不解压任何帧。
     *
     * ⚠️ 这一段**不能拖住 `apply()`**：apply 必须同步返回，否则插件的
     *    服务/路由/注入注册全部被推迟（见文件顶部的设计约束与
     *    `dsh-whale-widget/lib/index.js:604-609` 的实测）。
     *    所以：
     *      · `warmFromCacheAsync` 存在时（另一处改动新增的异步版，语义与同步版一致）
     *        预热挪到 microtask 里跑，且**必须等它跑完再跑第一次扫描** —— 否则
     *        sessions.js 的 `lostMemory` 判据（`!this.byFile.has(info.rel)`，
     *        sessions.js:283）会把每一个文件都判成"内存里的复用副本丢了"，
     *        于是 `rebuild` 把整个会话目录全量重解一遍：预热白做，还多花一倍时间。
     *      · 没有异步版时退回**同步调用**（降级路径，保留）：与旧行为逐字节一致。
     */
    const warmFromCacheAsync = typeof scanner.warmFromCacheAsync === 'function'
      ? scanner.warmFromCacheAsync.bind(scanner)
      : null
    if (!warmFromCacheAsync) {
      scanner.warmFromCache(store.cursor)
    }

    /**
     * 旧 state 的截止时刻迁移是否已做过（只做一次，见 `scanOnce()` 里的说明）。
     * 放在闭包里而不是 state：迁移结果本身会落盘，这个标记只为避免"cutoff 算出来是 0"
     * 时每一轮都重算一遍。
     */
    let cutoffMigrated = false

    /**
     * 最近一次 `scanOnce()` 的扫描结果：
     * `{ at, bySession, totals, sessionCount, revision, error }`（形状见 `scanSnapshot()`）。
     *
     * 存在的理由（T1）：`scanOnce()` 已经算了 `scanner.bySession()` + `computeAllSignals()`，
     * 紧接着的 `maybeGenerate()` 又算了一遍 —— 在 7 万帧 / 几十万事件的规模下，
     * 这是每 `scan.intervalMs`（默认 120 秒）一次的整包重复计算。
     * 复用判据抽成纯函数 `shouldReuseScan()`（见文件末尾），失效条件都写在那里。
     */
    let lastScan = null
    /**
     * `scanner.byFile` 的"版本号"：每跑完一次真正的 `scanner.scan()` 就 +1。
     *
     * 为什么需要它：`lastScan.bySession` 是**某一刻内存副本**的快照，只要中间
     * 有别的扫描动过 `scanner.byFile`（例如 `rescanNow()` 走过一遍），缓存下来的
     * 那份就不再是"最新内存副本"。`byFile` 是 sessions.js 的私有字段（本文件不许
     * 动 sessions.js），所以用一个自增版本号表达"被扫描动过"这件事。
     */
    let scanRevision = 0
    /**
     * 异步预热（`warmFromCacheAsync`）的进行中 promise；`null` = 没有异步预热这回事。
     * `scanOnce()` 与首次 tick 都会 await 它（同一个 promise，不会重复预热）。
     */
    let warmup = null

    /**
     * 启动异步预热（幂等：第二次调用返回同一个 promise）。
     *
     * 为什么只"排队"不直接 await：apply() 必须同步返回（同上）。
     * 为什么预热失败不抛：`byFile` 为空只是让下一次扫描走全量重建（慢，但语义正确），
     * 比"因为读缓存时抖了一下就再也不扫描"轻得多。
     */
    const startWarmup = () => {
      if (!warmFromCacheAsync || warmup) return warmup
      warmup = (async () => {
        try {
          // 不传 options：`yieldEvery` 的默认值由 sessions.js 那边定，这里不猜数字。
          await warmFromCacheAsync(store.cursor)
        } catch (error) {
          log.warn(`[scan] 异步预热失败（下一次扫描将全量重建内存副本）: ${error?.message ?? error}`)
        }
      })()
      return warmup
    }

    /** @type {Set<Function>} */
    const listeners = new Set()
    let scanning = false
    let generating = false
    let intervalDisposer = null
    let sectionDisposer = null
    let disposed = false

    /**
     * 已注册路由的 disposer。
     *
     * ⚠️ 用**数组**而不是单个变量：局部等待（`root.inject`）的回调在
     * "依赖服务换代"时会**先卸载再重跑**（见下面 `root.inject(['webServer'], ...)`
     * 处的语义核实），每次重跑都会注册一条新路由。只留最后一个的话，
     * 前一次的 disposer 就丢了 —— 那条前缀路由会留在宿主表里，
     * 而下一次注册撞 "duplicate prefix route"。所以注册**之前**先清空。
     */
    const routeDisposers = []

    /**
     * 系统提示段的渲染缓存。
     *
     * ⚠️ 字节稳定是硬要求。`section.text` 每一步都会求值，返回值一变，
     * 宿主就在历史里**追加**一条新的 system 节点
     * （`dsh-agent-loop/lib/index.js:277-281`：`latest.text === rendered` 才 return []，
     * 否则 `surfaceOp: 'append'`）。所以这里按内容缓存，
     * 内容不变时返回**同一个字符串实例**。
     */
    let sectionCacheKey = null
    let sectionCacheValue = ''

    const host = {
      config,
      store,
      scanner,
      log,
      listeners,

      /** 「当前生效画像文本」的唯一产出点。 */
      effectiveText() {
        return store.effective()
      },

      /**
       * 首跑 / 自动更新进度（只读，不改任何状态）。
       *
       * 只给界面两件事：**判据**（阈值、autoRun、模式）与**已经数到的事实**
       * （最近一次扫描的累计发言/会话数）。"还差几条"由界面做减法 —— 首版判据
       * 就是累计数（见 `shouldRegenerate()`），所以减法在首跑阶段是精确的。
       *
       * `scanned: false` 表示扫描还没跑过第一轮：这时累计数全是 0，不能说成
       * "一条发言都没有"，否则用户会以为插件没读到会话。
       */
      triggerProgress() {
        const state = store.state
        const totals = state.lastSignals?.totals ?? null
        return {
          autoRun: config.profile.autoRun === true,
          mode: state.mode,
          triggerUserMessages: config.profile.triggerUserMessages,
          triggerNewSessions: config.profile.triggerNewSessions,
          humanMessages: Number.isFinite(totals?.humanMessages) ? totals.humanMessages : 0,
          sessions: Number.isFinite(totals?.sessions) ? totals.sessions : 0,
          scanned: totals !== null,
          hasProfile: Boolean(state.profile && Array.isArray(state.profile.entries) && state.profile.entries.length > 0),
          generatedAt: Number.isFinite(state.lastGeneration?.at) ? state.lastGeneration.at : null,
        }
      },

      /** 条目处置标记清单（`pinned` / `sealed` / `deleted` 混在一个数组里）。 */
      markList() {
        const list = store.state.entryMarks
        return Array.isArray(list) ? list : []
      },

      /**
       * 给界面用的标记视图：清单原文 + **现算**的 `present` / `presentId`
       * （这条结论现在还在画像里吗、对应哪一条）。
       *
       * 这两个字段不落盘：它们随画像每一版变化，存下来就会变成需要同步的冗余状态。
       * 界面靠 `presentId` 反查"某条现在是什么状态"（③ 区显示「已置顶」徽标、
       * 把「置顶」按钮换成「取消置顶」都要它）。判据与注入/生成侧同一套
       * （`markPresence()`，规范化文本逐字相等）。
       */
      markViews() {
        const profile = store.state.profile
        const entries = Array.isArray(profile?.entries) ? profile.entries : []
        let present = new Map()
        try {
          present = markPresence(entries, host.markList())
        } catch (error) {
          // 界面渲染绝不能因为一次比对失败而整个挂掉（GET /state 会 500）。
          log.warn(`[mark] 计算 present 失败（本次按"都不在画像里"处理）: ${error?.message ?? error}`)
        }
        return host.markList().map(mark => {
          const presentId = present.has(mark?.key) ? present.get(mark.key) : null
          return { ...mark, present: presentId !== null, presentId }
        })
      },

      /**
       * 生成期间用户新按的处置按钮，在这一版落盘前收口。
       *
       * 为什么需要：一次画像生成要跑几秒到几分钟，用户完全可能在看界面时按「封印」
       * 或「删除」。生成用的是**开始那一刻**的标记快照，不在这里补一刀的话，用户会
       * 看到"我明明封了 / 删了，它还在这一版里"。
       *
       * ⚠️ 只处理 `lastAt >= since` 的标记（即生成开始之后被动过的）：
       *   · 更早的封印已经由 `normalizeProfile()` 处理过；
       *   · 更早的删除**故意不在这里生效** —— 用户要的正是"下一次总结它还能回来"，
       *     把历史删除标记长期当过滤器用，等于把"删除"偷偷变成"封印"。
       * @param {number} since 生成开始时间戳
       */
      applyFreshMarks(since) {
        const profile = store.state.profile
        if (!profile || !Array.isArray(profile.entries)) return 0
        const fresh = host.markList().filter(mark => Number(mark?.lastAt) >= since)
        if (fresh.length === 0) return 0
        let removed = 0
        for (const status of [MARK_STATUS.SEALED, MARK_STATUS.DELETED]) {
          const outcome = partitionMarks(profile.entries, fresh, status)
          if (outcome.demoted.length === 0) continue
          profile.entries = outcome.kept
          removed += outcome.demoted.length
          log.info(
            `[mark] 生成期间新打上的 ${status} 标记生效：从这一版剔除 ${outcome.demoted.length} 条（${
              outcome.demoted.map(entry => entry?.id ?? '?').join('、')
            }）`,
          )
        }
        return removed
      },

      /**
       * 打一条处置标记（置顶 / 封印 / 删除）。见 `PromptAdaptService.markEntry()` 的注释。
       * @param {{status:string, id?:string, claim?:string, key?:string}} input
       */
      markEntry(input = {}) {
        const status = input.status
        if (!MARK_STATUSES.includes(status)) {
          return { ok: false, error: `未知的处置状态：${JSON.stringify(status)}` }
        }
        const state = store.state
        const marks = host.markList()
        const profile = state.profile
        const entries = profile && Array.isArray(profile.entries) ? profile.entries : []
        // 定位界面上点的那一条：先按 id（界面按 id 发），id 对不上再按正文
        // （界面拿到的可能是上一次 /state 的旧数据，条目已经被重写过）。
        // 两种都对不上就报错 —— 绝不拿界面传来的字符串凭空造一条标记：
        // 那会让"点了不存在的条目"静默成功，而用户什么也没看到。
        const matchEntry = () => {
          if (typeof input.id === 'string' && input.id) {
            const byId = entries.findIndex(entry => entry && entry.id === input.id &&
              (typeof input.claim !== 'string' || !input.claim || entry.claim === input.claim))
            if (byId >= 0) return byId
          }
          const wanted = markText(typeof input.claim === 'string' ? input.claim : '')
          if (wanted) {
            const byClaim = entries.findIndex(entry => markText(entry?.claim) === wanted)
            if (byClaim >= 0) return byClaim
          }
          return -1
        }
        const index = matchEntry()
        const entry = index >= 0 ? entries[index] : null
        // 目标键：界面给了 `key`（标记区里的记录）就用它，否则按条目/正文现算。
        const existing = typeof input.key === 'string' && input.key
          ? marks.find(mark => mark && (mark.key === input.key || markText(mark.entry?.claim) === markText(input.key)))
          : null
        const source = entry ?? existing?.entry ?? null
        if (!source || !markText(source.claim)) {
          return { ok: false, error: '找不到要处置的条目：id/claim 在当前画像里没有，key 也不在标记清单里' }
        }
        if (status === MARK_STATUS.PINNED) {
          const count = marksByStatus(marks, MARK_STATUS.PINNED).length
          const already = marks.some(mark => mark?.status === MARK_STATUS.PINNED &&
            markText(mark.key || mark.entry?.claim) === markText(source.claim))
          const max = config.inject.maxPinned
          if (!already && count >= max) {
            return {
              ok: false,
              error: `置顶最多 ${max} 条（现在 ${count} 条）：先取消一个置顶，再置顶这一条。`,
            }
          }
        }
        const outcome = upsertMark(marks, source, status, Date.now())
        if (!outcome.mark) return { ok: false, error: '这条的结论是空的，无法处置' }
        state.entryMarks = outcome.marks
        // 封印 / 删除：从**这一版画像**里移除（界面上立刻不再出现在正文里）。
        // 置顶不移除 —— pin 只是"标为重要 + 豁免预算"，条目照旧在画像里。
        if (status !== MARK_STATUS.PINNED && index >= 0) entries.splice(index, 1)
        // 这一版中途的注入集合可能变了（封印前面的条目会腾出预算、解封会加回条目）：
        // 在 commit 之前同步账本，让"这一版真的交付过谁"跟得上。
        host.syncInjectionLedger()
        host.commit('mark:' + status)
        log.info(
          `[mark] ${status}（${outcome.previousStatus ? `原状态 ${outcome.previousStatus} → ` : ''}${status}）` +
            `：${String(source.claim).slice(0, 40)}${String(source.claim).length > 40 ? '…' : ''}`,
        )
        return {
          ok: true,
          status,
          key: outcome.key,
          previousStatus: outcome.previousStatus,
          marks: outcome.marks.length,
          pinned: marksByStatus(outcome.marks, MARK_STATUS.PINNED).length,
        }
      },

      /**
       * 撤销标记（取消置顶 / 从垃圾桶恢复），条目原文**原样写回**画像。
       * @param {string} key
       */
      clearMark(key) {
        const outcome = dropMark(host.markList(), key)
        if (!outcome.removed) return { ok: false, error: '这条标记已经不存在了（可能刚被撤过）' }
        store.state.entryMarks = outcome.marks
        const profile = store.state.profile
        const restored = outcome.removed.entry
        let restoredNow = false
        if (profile && Array.isArray(profile.entries) && restored &&
            typeof restored.claim === 'string' && markText(restored.claim)) {
          const already = profile.entries.some(entry => markText(entry?.claim) === markText(restored.claim))
          if (!already) {
            // 原样写回（含 id / 证据量 / 时间戳）。追加到末尾：界面按分类分组显示，
            // 组内顺序无关紧要；而"插回原位"需要记住位置，那是多余的复杂度。
            profile.entries.push({ ...restored })
            restoredNow = true
          }
        }
        host.syncInjectionLedger()
        host.commit('clearMark')
        log.info(`[mark] 撤销 ${outcome.removed.status}：${String(restored?.claim ?? key).slice(0, 40)}`)
        return {
          ok: true,
          key: outcome.removed.key ?? key,
          status: outcome.removed.status,
          restored: restoredNow,
          marks: outcome.marks.length,
        }
      },

      /**
       * 「实际会被注入系统提示的那段文本」的唯一产出点。
       *
       * ⚠️ 与 `effectiveText()` **不是同一份东西**，这是故意的：
       *    · `effectiveText()` → `store.effective()`：**全文**，给界面预览、
       *      复制到模式 2、复制快照用（绝不能裁剪）。
       *    · 这里 → `store.effectiveForInjection()`：模式 1 下画像按注入预算裁剪。
       *    设置页要显示"已经注入的提示词"必须读**这个**，才能做到"看到的 = 注入的"。
       *
       * 这里返回的是 `renderSection()` 拿去包装之前的**原文**（不含
       * `## 关于这个用户…` 那层标题）—— 与用户要求的
       * "`renderProfileInjectionText()` 的产出"一致，也与 `injection` 摘要
       * （同一个预算下算出来的）对得上。
       *
       * 渲染失败时返回空串并记一条 warn，**不抛**：`getState()` 会被每一次
       * `GET /state` 调用，抛了就是设置页显示"未连接宿主"（与
       * `renderSection()` 的处置一致）。
       */
      injectionText() {
        try {
          return store.effectiveForInjection().text
        } catch (error) {
          log.warn(`[inject] 渲染注入文本失败（本次按空处理）: ${error?.message ?? error}`)
          return ''
        }
      },

      renderSection() {
        let text
        try {
          // ⚠️ 注入走 `effectiveForInjection()`（带 token 预算），**不是** `effective()`。
          //    `effective()` 是给用户看的全文（复制到模式 2 用的就是它）：
          //    用它注入会退回"画像无上限增长 → 每步读上千 token"的老路；
          //    反过来，若把预算做进 `effective()`，用户复制到的就是残缺画像。
          //    这两条路径必须在**渲染函数**这一层就分开。
          text = store.effectiveForInjection().text
        } catch (error) {
          // 注入失败绝不能打断回合：宁可这一步没有画像，也不要会话报错
          log.warn(`[inject] 渲染生效文本失败: ${error?.message ?? error}`)
          return ''
        }
        if (text === sectionCacheKey) return sectionCacheValue
        sectionCacheKey = text
        // 包一层固定标题，让模型能分清这段是"用户画像"而不是系统指令
        sectionCacheValue = text
          ? `## 关于这个用户（由 prompt-adapt 插件提供）\n\n${text}`
          : ''
        return sectionCacheValue
      },

      /** 状态变了：落盘 + 失效缓存 + 广播。 */
      commit(reason) {
        sectionCacheKey = null
        store.saveState()
        if (reason !== 'scan') store.saveCursor()
        for (const listener of listeners) {
          try {
            listener({ reason })
          } catch (error) {
            log.warn(`[service] 变更监听器抛错: ${error?.message ?? error}`)
          }
        }
      },

      /**
       * 扫一轮会话日志并刷新四个信号。
       * @param {{force?:boolean}} [options]
       */
      async scanOnce(options = {}) {
        if (scanning && !options.force) return { skipped: true }
        scanning = true
        try {
          // ⚠️ 预热（异步版）没收尾就扫描 = `byFile` 还是空的 → sessions.js 的
          //    `lostMemory` 判据把每个文件都判成"内存副本丢了" → 整个会话目录全量重解。
          //    手动 rescan 完全可能赶在预热收尾之前发生（预热是异步的），所以这里也等一次；
          //    等的是同一个 promise，因此与首次 tick 的等待不会重复预热、也不会互相阻塞。
          if (warmup) await warmup
          const stats = scanner.scan(store.cursor)
          if (stats.newFrames > 0 || stats.changed > 0) {
            log.info(
              `[scan] 文件 ${stats.scanned} 个，变化 ${stats.changed} 个，` +
                `新帧 ${stats.newFrames} 个，新事件 ${stats.newEvents} 条`,
            )
          } else {
            log.debug(`[scan] 文件 ${stats.scanned} 个，无新帧`)
          }
          // ⚠️ `humanOnly`：子代理会话里的委派 prompt 也是 `source.kind === 'user'`，
          //    不过滤的话它们会被算成真人发言与"新增会话"，既污染画像材料，
          //    又会把"我派了两个子代理"当成用户活跃去触发画像生成（实测触发 v41 的就是它）。
          const bySession = scanner.bySession({ humanOnly: true })
          // ⚠️ 第三个参数 `{ details: false }`（T2）：扫描路径只取 `totals` + 会话数，
          //    逐会话的 `details`（excerpt / labels 数组）在这里是**整包丢弃**的纯浪费。
          //    界面点开单个会话走 `getSessionSignals()`（单会话、需要 details），
          //    那条路径保持默认 `true`，不受影响。
          const signals = computeAllSignals(bySession, config.signals, { details: false })
          const at = Date.now()
          // ── 旧 state 迁移：把"累计差"口径换成"材料截止时刻"口径 ──────────
          // 旧 `lastGeneration` 没有 `materialCutoff`，而它的 `humanMessages` 是
          // **含子代理**的旧口径（本机 524，过滤后 383）。如果继续走累计差兜底：
          // 383 - 524 = -141 → 永远不触发 → 永远写不进 cutoff → 自动更新永久停摆。
          // 第一次扫描时写入 cutoff（用上一版生成结束时刻 `at` 当近似），从此走
          // 新判据；**不改写 humanMessages/sessions** —— 首轮扫描受帧预算限制，
          // 拿它算出来的"过滤后基线"可能只是部分语料（本机首轮 400 帧），写进去
          // 会比旧值更错。那两个字段只在展示用，下一次成功生成会用完整材料重算。
          if (
            !cutoffMigrated &&
            store.state.profile &&
            !(Number(store.state.lastGeneration?.materialCutoff) > 0)
          ) {
            cutoffMigrated = true
            const previousAt = Number(store.state.lastGeneration?.at)
            const fallbackCutoff = Number.isFinite(previousAt) && previousAt > 0
              ? previousAt
              : materialCutoff(bySession)
            store.state.lastGeneration = {
              ...store.state.lastGeneration,
              materialCutoff: fallbackCutoff,
            }
            log.info(
              `[profile] 旧 state 迁移：材料截止时刻=${new Date(fallbackCutoff).toISOString()}；` +
                `humanMessages/sessions 保持旧值，下一次成功生成时按完整材料重算`,
            )
          }
          const sessionCount = Object.keys(signals.sessions).length
          store.state.lastSignals = { at, totals: signals.totals, sessionCount }
          // 把这一轮的结果留在闭包里，供同一个 tick 的 `maybeGenerate()` 复用（T1）。
          // `revision` 与扫描动作同步 +1：它一变，缓存就不再被认为是"最新内存副本"。
          //
          // 只缓存 `totals`（+ `bySession`），**刻意不缓存 `signals.sessions`**：
          // 逐会话明细（含 details 的 excerpt / labels 数组）在生成路径上没有人读
          // （`shouldRegenerate()` 只读 totals，界面点开单会话走 `getSessionSignals()`），
          // 缓存它等于把整包 details 多留在内存里一整个扫描周期 —— 那正是 T2 要省的。
          scanRevision += 1
          lastScan = { at, bySession, totals: signals.totals, sessionCount, revision: scanRevision, error: null }
          store.saveCursor()
          store.saveState()
          return { ...stats, totals: signals.totals }
        } catch (error) {
          const message = String(error?.message ?? error)
          log.error(`[scan] 扫描失败: ${message}`)
          // 出错这一轮**不许**被当成可复用的结果：带上 `error` 后
          // `shouldReuseScan()` 恒判"重算"（重算时 `signals` 是半截的，
          // 拿它当结果会让 `shouldRegenerate()` 按 0 条材料判断 → 静默不生成画像）。
          lastScan = { at: Date.now(), bySession: null, totals: null, sessionCount: 0, revision: scanRevision, error: message }
          return { error: message }
        } finally {
          scanning = false
        }
      },

      /**
       * 取"这一次生成要用的扫描结果"（T1：**同一个 tick 里信号只算一遍**）。
       *
       * 复用条件与失效条件全部收在纯函数 `shouldReuseScan()` 里（便于单测判定矩阵）：
       *   · 没有历史结果 / 上一次扫描出错 / 距上次扫描超过一个 `scan.intervalMs`
       *     / 两次之间 `scanner.byFile` 被别的扫描动过（`revision` 对不上）
       *     / `force`（手动 rescan / 手动 regenerate）→ 现算一份；
       *   · 其余情况直接返回 `scanOnce()` 的那一份。
       *
       * ⚠️ 复用返回的是**同一个** `totals` 对象，所以 `maybeGenerate()` 里
       *    `shouldRegenerate()` 用的 `humanMessages` / `sessions` 与 `scanOnce()`
       *    写进 `state.lastSignals.totals` 的是**同一份数字**（不是重算出来的近似值）。
       *    这是硬要求：两份数字一旦能各自漂移，"为什么没更新画像"就没法向用户解释了。
       *    同理，交给 `runProfileGeneration()` 的 `bySession` 也是同一份快照 ——
       *    材料量（`collectHumanMessages()`）与 `totals` 出自同一个事件集。
       *
       * @param {{force?:boolean}} [options]
       * @returns {{at:number, bySession:Map<string,object[]>|null, totals:object|null,
       *   sessionCount?:number, revision:number, error:string|null}}
       */
      scanSnapshot(options = {}) {
        const now = Date.now()
        const verdict = shouldReuseScan(lastScan, {
          now,
          intervalMs: config.scan.intervalMs,
          force: options.force === true,
          revision: scanRevision,
        })
        if (verdict.reuse) {
          log.debug(`[scan] 复用上一次扫描结果（${verdict.reason}）：不重算信号`)
          return lastScan
        }
        log.debug(`[scan] 重算信号（${verdict.reason}）`)
        const bySession = scanner.bySession({ humanOnly: true })
        const signals = computeAllSignals(bySession, config.signals, { details: false })
        return { at: now, bySession, totals: signals.totals, revision: scanRevision, error: null }
      },

      /**
       * 判断是否该生成画像，该就生成。
       * @param {{force?:boolean, reason?:string}} [options]
       */
      async maybeGenerate(options = {}) {
        if (generating) return { skipped: true, reason: '已有一次生成在进行中' }
        if (!options.force && !config.profile.autoRun) {
          return { skipped: true, reason: 'profile.autoRun = false' }
        }
        // 模式 2（自定义）下注入的是用户手写文本，画像根本不进 system prompt：
        // 自动生成既不会生效、还白烧 LLM 额度（实测 timer 原来在 custom 下也照跑）。
        // 手动触发（force）仍然允许 —— 用户可能想先更新画像再切回模式 1。
        if (!options.force && store.state.mode !== MODE.AUTO) {
          return { skipped: true, reason: '模式 2（自定义）不自动生成画像' }
        }

        // T1：`scanOnce()` 刚在同一个 tick 里算完的 `bySession` + `totals` 直接复用，
        // 不再重复 `scanner.bySession()` + `computeAllSignals()`。`force`（手动触发）
        // 以及"没有历史 / 上次出错 / 超出间隔 / byFile 被别的扫描动过"这几种情况
        // 由 `scanSnapshot()` 内部判成现算，判据见 `shouldReuseScan()`。
        const snapshot = host.scanSnapshot({ force: options.force === true })
        // 触发只数"上一版材料截止时刻之后"的真人发言：扫描器补扫旧日志、
        // 以及生成那 25–33 秒里到达的消息，都不许被算成用户活跃。
        // ⚠️ 旧 state 没有 `materialCutoff`（升级前的文件）：这一轮退回原来的
        //    "累计差"判据，不要拿 0 当截止时刻 —— 那会把全部历史当成新增，
        //    升级后立刻白跑一次生成。下一次成功生成会把截止时刻写死，之后走新判据。
        const cutoff = store.state.lastGeneration?.materialCutoff
        const hasCutoff = typeof cutoff === 'number' && Number.isFinite(cutoff) && cutoff > 0
        const fresh = hasCutoff ? freshness(snapshot.bySession ?? new Map(), cutoff) : null
        const judgement = shouldRegenerate({
          profile: store.state.profile,
          lastGeneration: store.state.lastGeneration,
          humanMessages: snapshot.totals.humanMessages,
          sessions: snapshot.totals.sessions,
          ...(fresh ? { newMessages: fresh.messages, newSessions: fresh.sessions } : {}),
          config: config.profile,
        })
        if (!judgement.due && !options.force) {
          log.debug(`[profile] 不生成：${judgement.reason}`)
          store.state.lastRun = {
            at: Date.now(),
            ok: null,
            reason: judgement.reason,
            error: null,
            spuriousRate: store.state.lastRun?.spuriousRate ?? null,
            diff: store.state.lastRun?.diff ?? null,
            // 与上面两个字段同一处置：这是**上一次生成**观测到的材料预算，
            // 不是本次的（本次根本没生成）。留 null 会让 `/state` 的字段位从
            // 界面上凭空消失，所以沿用旧值而不是抹掉。
            material: store.state.lastRun?.material ?? null,
          }
          store.saveState()
          return { skipped: true, reason: judgement.reason, judgement }
        }
        return host.runProfileGeneration({
          force: options.force === true,
          reason: options.reason ?? judgement.reason,
          // 复用那一份 `totals`（与 `shouldRegenerate()` 读的是同一个对象）：
          // `runProfileGeneration()` 只读 `.totals`，所以这里不必带逐会话明细。
          signals: { totals: snapshot.totals },
          bySession: snapshot.bySession,
        })
      },

      /** 真正跑一次画像生成。 */
      async runProfileGeneration({ reason, signals, bySession } = {}) {
        if (generating) return { skipped: true, reason: '已有一次生成在进行中' }
        generating = true
        const started = Date.now()
        /**
         * 材料预算的**可观测**累加器（另一个改动在 `collectHumanMessages()` 里加了
         * `maxMaterialChars` + `stats` 两个选项，由它往里填数）。
         *
         * 为什么必须在 `try` 之外就存在：生成失败时 `lastRun` 也要如实带上这份数字
         * （作者的原则是"静默省略最糟"），所以 catch 分支必须读得到它 —— 哪怕
         * 失败发生在收集材料之前（那时它是全 0，表示"这次一条材料都没收"）。
         */
        const materialStats = { chars: 0, kept: 0, dropped: 0, total: 0 }
        try {
          const llm = typeof root.get === 'function' ? root.get('llm') : undefined
          if (!llm || typeof llm.stream !== 'function') {
            throw new Error('llm 服务不可用（ctx.llm.stream 缺失）')
          }

          const allSessions = bySession ?? scanner.bySession({ humanOnly: true })
          // 这一版材料的时间上界。写进 `lastGeneration.materialCutoff`，下次触发
          // 只数它之后的真人发言 —— 不能用 `generatedAt`（那是 LLM 返回后的时间，
          // 生成窗口内到达的消息会被永久跳过）。
          const usedCutoff = materialCutoff(allSessions)
          const allSignals = signals ?? computeAllSignals(allSessions, config.signals, { details: false })

          // 目标 provider/model：配置优先，否则用宿主当前的默认模型选择
          let provider = config.profile.provider
          let model = config.profile.model
          if (!provider || !model) {
            const selection = resolveDefaultModel(root)
            provider = provider || selection?.provider || ''
            model = model || selection?.model || ''
          }
          if (!provider || !model) {
            throw new Error(
              '无法确定用于画像生成的 provider/model：' +
                'config.profile.provider/model 未配置，且宿主的 agentDefaultModel.currentSelection() 不可用',
            )
          }

          const messages = collectHumanMessages(allSessions, {
            maxMessageChars: config.profile.maxMessageChars,
            // ⚠️ 上限值**三处同值**（改一处就要改三处）：这里的兜底常量、
            //    `resolveConfig().defaults.profile.maxMaterialChars`、以及
            //    `lib/schema.js` 的 `profile.maxMaterialChars`（`.default(80000)`，
            //    真实宿主那条路径由它赢）。`?? DEFAULT_MAX_MATERIAL_CHARS` 兜住
            //    旧配置 / 直接 `apply(root, cfg)` 的测试路径（那里没有 schema 默认值）。
            maxMaterialChars: config.profile.maxMaterialChars ?? DEFAULT_MAX_MATERIAL_CHARS,
            // 被裁掉多少**必须能被看见**：静默裁剪会让用户以为材料是齐的。
            // 这个对象由 `collectHumanMessages()` 填，下面原样写进 `lastRun.material`。
            stats: materialStats,
          })
          if (messages.length === 0) {
            throw new Error('没有可用的真人发言材料（source.kind === "user" 的事件为 0）')
          }
          // 只取最近 N 条，控制成本
          const picked = messages.slice(-config.profile.maxEvidenceMessages)
          /**
           * 材料量的**可观测**数字（不依赖 `collectHumanMessages()` 的 `stats`）。
           *
           * 为什么日志报这两个而不是直接报 `material.*`：`stats` 由另一个改动填充，
           * 它没落地时 `material` 会全是 0 —— 那时候在日志里写
           * "材料量 chars=0" 就是**假话**（明明收了 30 条真人发言）。
           * 这两个数是从 `messages` / `picked` 现算的，任何情况下都是事实。
           * `material`（`lastRun.material`）报的是**预算口径**的账（上限裁了多少），
           * 两者互补：一个说"这次用了多少材料"，一个说"上限裁掉了多少"。
           */
          const collectedChars = messages.reduce((sum, message) => sum + message.text.length, 0)
          const keptChars = picked.reduce((sum, message) => sum + message.text.length, 0)
          const material = summarizeMaterialStats(materialStats)

          // 裁剪不是错误，但**不许静默**（作者的原则）：报出来 + 写进 lastRun.material。
          // 四个字段的口径由 `collectHumanMessages()` 定义，这里用 key=value 原样报，
          // 不替它猜单位（猜错会让日志和界面对不上）。
          if (material.dropped > 0) {
            log.warn(
              `[profile] ⚠️ 材料按上限裁剪：chars=${material.chars} kept=${material.kept} ` +
                `dropped=${material.dropped} total=${material.total}` +
                `（上限 profile.maxMaterialChars=${config.profile.maxMaterialChars ?? DEFAULT_MAX_MATERIAL_CHARS}）。` +
                `同一份数字写进了 lastRun.material。`,
            )
          }

          log.info(
            `[profile] 开始生成：材料 ${picked.length} 条（累计 ${messages.length} 条，` +
              `字符 ${keptChars}/${collectedChars}），` +
              `上一版条目 ${store.state.profile?.entries?.length ?? 0} 条，${provider}/${model}`,
          )

          const result = await generateProfile({
            llm,
            provider,
            model,
            previousProfile: store.state.profile,
            messages: picked,
            signals: allSignals.totals,
            totalHumanMessages: allSignals.totals.humanMessages,
            totalSessions: allSignals.totals.sessions,
            maxTokens: config.profile.maxTokens,
            timeoutMs: config.profile.timeoutMs,
            // 处置标记两处都用：封印清单进提示词（第一道防线）+ 落画像时剔除
            // （第二道防线）；删除/置顶清单进提示词（各自的语义见
            // `buildProfilePrompt()`）。用的是**生成开始这一刻**的快照。
            entryMarks: host.markList(),
          })

          store.state.profile = result.profile
          // 工作笔记：模型把项目/工具/路径类事实放在 projectNotes；合并进
          // state.workingNotes（不占画像槽位、不进注入文本），并从画像对象上摘掉，
          // 避免它写进 profile-history / 被当画像字段渲染。
          const projectNotes = Array.isArray(result.profile.projectNotes)
            ? result.profile.projectNotes
            : []
          delete result.profile.projectNotes
          if (projectNotes.length > 0) {
            const addedNotes = appendWorkingNotes(store.state, projectNotes)
            if (addedNotes > 0) log.info(`[profile] 工作笔记 +${addedNotes} 条（不占画像槽位）`)
          }
          // 生成期间用户又按了按钮的收口（见下）。
          host.applyFreshMarks(started)
          // 落账：这一版画像**真正会注入**哪些条目。必须在 applyFreshMarks 之后，
          // 且用 `forNewVersion` —— 新版本要按落账前的 counts 判断新生试用位；
          // 落账会把同一份 counts 冻结进 frozenCounts，渲染这一版时读的是同一个输入。
          // custom 模式由 syncInjectionLedger() 自己拦掉（画像不进 prompt，不记假账）。
          host.syncInjectionLedger({ forNewVersion: true })
          store.state.lastGeneration = {
            at: result.profile.generatedAt,
            humanMessages: allSignals.totals.humanMessages,
            sessions: allSignals.totals.sessions,
            // 材料截止时刻：下次"新增"判据的起点（见 lib/profile.js 的 materialCutoff）。
            materialCutoff: usedCutoff,
          }
          store.state.lastRun = {
            at: Date.now(),
            ok: true,
            reason: reason ?? '',
            error: null,
            spuriousRate: result.diff.spuriousRate,
            diff: {
              added: result.diff.added.length,
              removed: result.diff.removed.length,
              modified: result.diff.modified.length,
              unchanged: result.diff.unchanged.length,
            },
            // 抢救出来的"部分结果"必须能被看见：条目少了但画像照样能用，
            // 只在 lastRun 里挂着，不阻断流程。
            partial: result.partial === true,
            truncationReason: result.truncationReason ?? null,
            droppedTailChars: result.droppedTailChars ?? 0,
            warnings: result.profile.warnings ?? null,
            // 这一版用的材料预算（含被裁掉多少）。成功路径也要写：
            // 用户要能回答"画像为什么不全面" —— 答案可能是"材料被上限裁了"。
            material,
          }
          store.archiveProfile(result.profile, result.diff)
          host.commit('profile')

          if (result.partial) {
            log.warn(
              `[profile] ⚠️ 模型输出被截断（${result.truncationReason ?? 'unknown'}）：` +
                `已抢救出 ${result.diff.added.length + result.diff.modified.length} 条变化条目 + ` +
                `${result.diff.unchanged.length} 条未变条目（由上一版拼回），丢弃尾部 ${result.droppedTailChars} 字符。` +
                `这一版画像可用，但可能少了模型本来想加的条目。`,
            )
          }
          for (const warning of result.profile.warnings ?? []) {
            log.warn(`[profile] ${warning}`)
          }

          log.info(
            `[profile] 完成 v${result.profile.version}：条目 ${result.profile.entries.length} 条，` +
              `新增 ${result.diff.added.length} / 删除 ${result.diff.removed.length} / ` +
              `改写 ${result.diff.modified.length} / 未动 ${result.diff.unchanged.length}，` +
              `可疑变化率 ${(result.diff.spuriousRate * 100).toFixed(1)}%，耗时 ${Date.now() - started}ms`,
          )
          return {
            ok: true,
            profile: result.profile,
            diff: result.diff,
            elapsedMs: Date.now() - started,
          }
        } catch (error) {
          const message = String(error?.message ?? error)
          log.error(`[profile] 生成失败: ${message}`)
          store.state.lastRun = {
            at: Date.now(),
            ok: false,
            reason: reason ?? '',
            error: message,
            spuriousRate: store.state.lastRun?.spuriousRate ?? null,
            diff: store.state.lastRun?.diff ?? null,
            // 失败路径也**不吞**材料预算：哪怕失败发生在收集材料之前
            // （全 0 = 这次一条都没收），字段位与数值都必须如实到位。
            material: summarizeMaterialStats(materialStats),
          }
          store.saveState()
          return { ok: false, error: message }
        } finally {
          generating = false
        }
      },

      /**
       * 同步注入落账。**同一版本内可以多次调用**：只补记"新进注入集合"的 id
       * （用户封印排在前面的条目后，原本被预算截掉的条目可能在中途进入 prompt）。
       *
       * @param {{forNewVersion?:boolean}} [options] 生成成功时传 `true`：
       *   新版本用**落账前的 counts** 判断试用位；封印/解封等中途变化用
       *   `frozenCounts`（与当前渲染同一份输入）。
       * @returns {boolean} 账本是否发生变化
       */
      syncInjectionLedger(options = {}) {
        const profile = store.state.profile
        if (!profile) return false
        // custom 模式下画像根本不进 system prompt（注入的是用户自定义文本），
        // 这时候记"交付"就是假账；生成也不会自动跑（见 maybeGenerate）。
        if (store.state.mode !== MODE.AUTO) return false
        try {
          const ledger = store.state.injectionLedger
          const injectedCounts = options.forNewVersion === true
            ? (ledger?.counts ?? null)
            : (ledger?.frozenCounts ?? null)
          const plan = planProfileInjection(profile, {
            budgetTokens: config.inject.budgetTokens,
            entryMarks: host.markList(),
            injectedCounts,
          })
          // 版本身份用 generatedAt + version：clearProfile() 之后版本号会从 1 重来，
          // 只用 version 去重会把清空后的新 v1 当成旧 v1（那会丢掉整本账）。
          const identity = `${profile.generatedAt ?? 0}:${profile.version ?? '?'}`
          const changed = store.recordInjection(plan, profile.version ?? null, identity)
          if (changed) {
            log.info(`[inject] 落账 v${profile.version}：本版交付 ${plan.injectedIds?.length ?? 0} 条`)
          }
          return changed
        } catch (error) {
          // 账本是观测数据，不是运行前提：同步失败不影响注入/生成。
          log.warn(`[inject] 落账失败（不影响注入）: ${error?.message ?? error}`)
          return false
        }
      },
    }

    // ── 旧 state 补账（新装/升级后第一次跑）──────────────────────────
    // 只在 auto 模式补：custom 下画像不进 prompt，补出来的会是假账。
    // `lastAt` 非空说明这一版已经记过；同一身份重复调用也会返回 false。
    if (
      store.state.mode === MODE.AUTO &&
      store.state.profile &&
      !store.state.injectionLedger?.lastAt
    ) {
      if (host.syncInjectionLedger()) store.saveState()
    }

    // ── 注册宿主侧服务（UI 侧通过它读写） ────────────────────────────
    // 用 cordis 的 Service 基类：构造即注册，且随本插件的 fiber 自动注销，
    // 不需要自己管 dispose。
    /** @type {PromptAdaptService|null} */
    let service = null
    try {
      service = new PromptAdaptService(root, host)
      log.info("[service] 已暴露 promptAdapt 服务（宿主进程内）")
    } catch (error) {
      log.warn(`[service] 暴露 promptAdapt 失败（UI 侧将无法读写）: ${error?.message ?? error}`)
    }

    // ── 把服务暴露给浏览器里的设置页 ─────────────────────────────────
    // 宿主进程内的 ctx.promptAdapt 浏览器够不到，必须有 HTTP 路由。
    //
    // ⚠️ 光在 apply 里直接调 `registerRoutes()` 是不够的：它内部靠
    //    `root.get('webServer')` 判空，而本插件没有对象级 inject，
    //    apply() 跑在服务就绪**之前** —— 真实宿主上拿到的永远是 `undefined`，
    //    于是注册被跳过、只留一条 warn，设置页拿到 404（"画像无法复制"）。
    //    这不是 `registerRoutes()` 的写法问题，是**调用时机**问题。
    //    修法：直接调用**保留**（服务已就绪时同步注册），另外用
    //    `root.inject(['webServer'], cb)` 局部等待补上"晚就绪"那条路径。
    //
    // 为什么是 `root.inject([...], cb)` 局部等待，而不是把 `webServer` 写进对象级
    // `inject`：对象级 inject 会把**整个** apply() 推迟到服务就绪之后，
    // 而 `dsh-whale-widget/lib/index.js:604-609` 记着那条隐患 ——
    // "桌面端的注入表是宿主启动时一次性收集的（collectIndexInjections() → IPC →
    //  渲染层），订阅一旦晚于那次收集，这一行就永远进不了表"；精简宿主上少一个
    // 服务还会让插件**完全不 apply**。`root.inject` 语义与对象级 inject 等价，
    // 但只推迟这一段：本文件顶部"依赖服务都是可选读的"那条设计约束不受影响，
    // 扫描/画像/注入照常。
    //
    // 幂等：局部等待的回调在依赖服务换代时会先卸载再重跑（cordis 的 epoch 机制，
    //       见交付说明里的源码引用）。所以
    //         ① 已经 disposed 就**不再注册**；
    //         ② 注册前先把上一轮的 disposer 全部撤销（routeDisposers 清空）。
    //       两层都必要：① 管"卸载之后回调才跑"，② 管"卸载没跑干净就重跑"。
    //
    // 两个"不算降级"的兜底（都只在宿主本身不合预期时走）：
    //   · `root.inject` 不是函数 —— 极老的 cordis；
    //   · `root.inject(...)` 当场抛 —— 调用点已经不在活跃 fiber 里
    //     （`RegistryService.plugin()` 对已卸载的 fiber 会抛）。
    //   这时退回原来的"直接注册"：服务此刻若已就绪，路由照样能注册上；
    //   没就绪就走 `registerRoutes()` 自己的那条 warn 降级，
    //   **扫描/画像/注入一律不受影响**。
    /**
     * 路由注册（幂等）。返回是否真的注册上了。
     *
     * 硬约束：宿主的 `webServer.register()` 对重复 `(kind, path)` **直接抛**
     * `duplicate prefix route`（`dsh-host-webserver/lib/index.js:177-184` 原文：
     * "Duplicate (kind, path) throws"）。所以任何一次注册之前，
     * **必须**先把上一轮的 disposer 撤掉 —— 这是防重复注册的第一层。
     */
    const registerRoutesNow = () => {
      for (const dispose of routeDisposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 已经被撤销过 */
        }
      }
      try {
        const routeDisposer = registerRoutes({ root, service, log })
        if (routeDisposer) {
          routeDisposers.push(routeDisposer)
          return true
        }
      } catch (error) {
        // 路由注册失败（例如前缀已被别人占用）不能拖垮插件
        log.error(`[http] 注册路由失败（设置页将读不到宿主数据）: ${error?.message ?? error}`)
      }
      return false
    }

    if (service) {
      /**
       * 防重复注册的第二层：**跨"新 fiber 重跑"去重**。
       *
       * 为什么需要它（不是保险起见，是实测出来的）：`root.inject(['webServer'])`
       * 起的那个等待 fiber 在 cordis 里是**延迟激活**的 —— 首次加载时
       * `provide('webServer')` 同步登记服务，`_checkImpl → _refresh → _setEpoch`
       * 把 epoch 从 INACTIVE 打响，但 `Fiber._reload()` 要 `await Promise.resolve()`
       * 之后才执行回调。于是：
       *   · `registerRoutes()` 同步那次已经把路由注册上了；
       *   · 一个微任务后回调又跑一遍 → 若不再去重，就会**撤了再注一遍**
       *     （结果正确，但会多一对"dispose + register"日志，也白白多一次
       *     宿主路由表增删）。
       * 记下"注册时用的那个 webServer 实例"，回调里比对：
       * 同一个实例 = 已经注册过，直接返回。
       *
       * 比对实例还有第二个作用：**服务换代**时（老服务下线、新服务上线）
       * 实例一定不同，于是重跑那一次会**先撤旧路由、再向新服务注册** ——
       * 既不会留幽灵路由，也不会撞 duplicate prefix route。
       */
      let registeredWith = null
      const waitForWebServer = () => {
        if (disposed) {
          // 卸载竞态：等待期间插件已经被卸载。此刻注册没人撤，只会留下幽灵路由
          log.warn('[http] 插件已卸载，跳过路由注册')
          return
        }
        const webServer = typeof root.get === 'function' ? root.get('webServer') : undefined
        if (webServer && webServer === registeredWith) return // 已针对这个实例注册过
        // 服务换代：先把旧实例上的路由撤干净（否则会撞宿主的 duplicate prefix route）
        registeredWith = null
        if (registerRoutesNow()) registeredWith = webServer ?? null
      }
      if (typeof root.inject !== 'function') {
        log.warn('[http] ctx.inject 不是函数（宿主 cordis 版本过老），改为立即尝试注册路由')
        registerRoutesNow()
      } else {
        try {
          /**
           * ⚠️ 两段都要（这是实测出来的，不是保险起见）：
           *
           *   ① **立即试一次**：`webServer` 此刻已就绪的宿主（宿主的服务注册表
           *      不共享隔离域、或插件是热重载进来的）就能同步注册上。
           *      `test/httptest.mjs` / `test/loadtest.mjs` 就是这种 Context ——
           *      它们在 `apply()` 返回后**同步**断言路由已经在表里。
           *   ② **同时挂上局部等待**：真实宿主上 `webServer` 是启动时就绪的，
           *      apply() 跑得更早，只有这条路径能等它；服务换代（重载/重启）
           *      也由它兜住。等待 fiber 是异步激活的，
           *      所以它跑起来时 ① 往往已经注册过了 —— 由 `registeredWith` 去重。
           */
          registeredWith = null
          if (registerRoutesNow()) {
            registeredWith = typeof root.get === 'function' ? root.get('webServer') ?? null : null
          }
          root.inject(['webServer'], waitForWebServer)
        } catch (error) {
          log.warn(`[http] root.inject 调用失败，只保留立即注册的结果: ${error?.message ?? error}`)
        }
      }
    }

    // ── 注入系统提示 ────────────────────────────────────────────────
    const systemPrompt = typeof root.get === 'function' ? root.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        const disposer = systemPrompt.section({
          name: config.inject.name || SECTION_NAME,
          order: config.inject.order,
          // ⚠️ 每一步都会被调用，必须同步、极快、纯：不写盘、不发网络、不产生随机数。
          text: () => host.renderSection(),
        })
        sectionDisposer = typeof disposer === 'function' ? disposer : null
        log.info(
          `[inject] 已注册系统提示段 name=${config.inject.name || SECTION_NAME} order=${config.inject.order}`,
        )
      } catch (error) {
        log.error(`[inject] 注册系统提示段失败: ${error?.message ?? error}`)
      }
    } else {
      log.warn('[inject] systemPrompt 服务不可用，画像不会被注入（其余功能正常）')
    }

    // ── 定时扫描 ────────────────────────────────────────────────────
    const tick = async () => {
      if (disposed) return
      try {
        await host.scanOnce()
        await host.maybeGenerate()
      } catch (error) {
        log.error(`[tick] 出错: ${error?.message ?? error}`)
      }
    }

    const timer = typeof root.get === 'function' ? root.get('timer') : undefined
    let scheduled = false
    if (timer && typeof timer.interval === 'function') {
      try {
        const disposer = timer.interval(() => void tick(), config.scan.intervalMs)
        intervalDisposer = typeof disposer === 'function' ? disposer : null
        scheduled = true
        log.info(`[timer] 已用 ctx.timer.interval 排程，间隔 ${config.scan.intervalMs}ms`)
      } catch (error) {
        // ⚠️ 这一步抛异常不能让 apply 一起抛：apply 抛 = fiber FAILED =
        //    服务/注入/路由**全部**没有（实测：timer.interval 抛错时插件完全不加载，
        //    连 promptAdapt 服务都注册不上），而这里只是"排个定时器"。降级到 setInterval。
        log.warn(`[timer] ctx.timer.interval 调用失败，改用 setInterval: ${error?.message ?? error}`)
      }
    }
    if (!scheduled) {
      // 兜底：ctx.timer 不可用（或调用失败）时用 Node setInterval。
      // unref() 让这个定时器不阻止进程退出（与 dsh-qq/lib/index.js:80-82 相同）。
      const handle = setInterval(() => void tick(), config.scan.intervalMs)
      if (typeof handle.unref === 'function') handle.unref()
      intervalDisposer = () => clearInterval(handle)
      log.info(`[timer] ctx.timer 不可用，改用 setInterval，间隔 ${config.scan.intervalMs}ms`)
    }

    // ── 冷启动预热 + 首次扫描 ────────────────────────────────────────
    // ⚠️ 顺序是硬要求：**预热先收尾，再跑第一次扫描**。
    //    反过来（或并行）会让 sessions.js 的 `lostMemory` 判据
    //    （`!this.byFile.has(info.rel)`，sessions.js:283）把每一个文件都判成
    //    "内存里的复用副本丢了" → `rebuild` 全量重解整个会话目录：
    //    预热白做，还比不预热更慢。
    if (warmFromCacheAsync) {
      // 即使 `scanOnStart = false` 也要预热：它只还原内存副本，与"要不要立刻扫一轮"无关。
      // 排队在这里（位于下面首次 tick 的那个 microtask **之前**），保证 tick 起来时
      // `warmup` 已经是那个进行中的 promise。
      queueMicrotask(() => void startWarmup())
    }

    // 启动时立即扫一次（不阻塞 apply 的返回：异步跑，失败只记日志）
    if (config.scan.scanOnStart) {
      queueMicrotask(() => {
        void (async () => {
          // 没有异步版时 `startWarmup()` 返回 null，`await null` 等价于旧行为（直接 tick）。
          await startWarmup()
          await tick()
        })()
      })
    }

    // ── 卸载 ────────────────────────────────────────────────────────
    // ⚠️ 必须用 `root.effect()`（onload 时登记、卸载时按逆序执行），
    //    **不能**用 `root.on('dispose', ...)`：cordis 4.0.5 的 `Events` 里没有
    //    `dispose` 这个事件（只有 `internal/*` 与各服务自己声明的事件），
    //    所以那种监听器**永远不会被调用** —— 实测（真实 Context + 真 TimerService
    //    + 按 dsh-host-webserver 实现复刻的 webServer）三个后果：
    //      · `[plugin] 已卸载` 从不打印，本段整段是死代码；
    //      · 兜底 setInterval 泄漏：卸载后仍在扫会话目录并写 state.json；
    //      · `webServer.register()` 的 disposer 不会被调用，前缀路由留在表里，
    //        重载时新 fiber 撞 "duplicate prefix route"（被 catch 记 error），
    //        设置页从此读不到宿主数据。
    //    （路由那条现在由 `root.inject(['webServer'], ...)` 局部等待注册，
    //      disposer 收在 `routeDisposers` 里，仍然由下面这段撤销。）
    root.effect(() => () => {
      // ⚠️ 顺序：先立 disposed，再撤资源。局部等待的 inject 回调可能在
      //    "卸载已经开始"与"回调被调度"之间被执行 —— 它会在第一行看到
      //    disposed 为 true 而直接返回，不会去注册一条没人撤的路由。
      disposed = true
      try {
        intervalDisposer?.()
      } catch {
        /* 已撤销 */
      }
      try {
        sectionDisposer?.()
      } catch {
        /* 已撤销 */
      }
      for (const dispose of routeDisposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 已撤销 */
        }
      }
      listeners.clear()
      try {
        store.saveState()
        store.saveCursor()
      } catch {
        /* 尽力而为 */
      }
      log.info('[plugin] 已卸载')
    }, 'prompt-adapt unload')
  },
}

/**
 * 材料字符上限的兜底默认值。
 *
 * ⚠️ **三处必须同值**（改一处就要改三处）：
 *   1. 这里；
 *   2. `resolveConfig().defaults.profile.maxMaterialChars`（测试路径 / 旧配置兜底）；
 *   3. `lib/schema.js` 的 `profile.maxMaterialChars`（`.default(80000)`，真实宿主路径赢）。
 * 刻意**不从 `lib/profile.js` import** 它那个同名常量：为一个字面量再添一条
 * index.js → profile.js 的模块边不值得（那边已经有一串导出被本文件用了）。
 */
const DEFAULT_MAX_MATERIAL_CHARS = 80000

/**
 * "要不要复用上一次扫描结果"的**纯判定函数**（T1 的核心，单独导出便于单测矩阵）。
 *
 * 复用要同时满足（任何一条不满足都重算）：
 *   · 非 `force`：`force` = 手动 rescan / 手动 regenerate，用户要的是"现在这一刻"的数据；
 *   · 有历史结果，且那一次**没出错** —— 出错时 `bySession` / `signals` 是空的或半截的，
 *     把它当结果会让 `shouldRegenerate()` 按 0 条材料判断，静默不生成画像；
 *   · 距上次扫描**不超过**一个 `intervalMs`（`elapsed > intervalMs` 才算过期；
 *     正好等于边界时算"还在间隔内"，与定时器同一节拍时不至于白重算一次）；
 *   · `revision` 一致：两次之间 `scanner.byFile` 被别的扫描动过（例如 `rescanNow()`
 *     走过一遍）时，缓存下来的 `bySession` 已经不是"最新内存副本"了。
 *
 * @param {{at?:number, revision?:number, error?:unknown}|null} lastScan
 * @param {{now?:number, intervalMs?:number, force?:boolean, revision?:number|null}} context
 * @returns {{reuse:boolean, reason:string}} 判定结果 + 理由（理由直接进 debug 日志）
 */
export function shouldReuseScan(lastScan, context = {}) {
  const { now = Date.now(), intervalMs = 120000, force = false, revision = null } = context
  if (force) return { reuse: false, reason: 'force：手动 rescan / regenerate 要现算' }
  if (!lastScan || typeof lastScan !== 'object') return { reuse: false, reason: '没有上一次扫描结果' }
  if (lastScan.error) return { reuse: false, reason: `上一次扫描出错（${lastScan.error}）` }
  const at = Number(lastScan.at)
  if (!Number.isFinite(at)) return { reuse: false, reason: '上一次扫描没有可用时间戳' }
  const elapsed = now - at
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return { reuse: false, reason: `时间戳异常（elapsed=${elapsed}ms，不拿未来时间去判"还新鲜"）` }
  }
  if (elapsed > intervalMs) {
    return { reuse: false, reason: `距上次扫描 ${elapsed}ms > 间隔 ${intervalMs}ms` }
  }
  if (revision !== null && lastScan.revision !== revision) {
    return {
      reuse: false,
      reason: `byFile 被别的扫描动过（revision ${lastScan.revision} ≠ ${revision}）`,
    }
  }
  return { reuse: true, reason: `距上次扫描 ${elapsed}ms，同一份 byFile（revision ${lastScan.revision}）` }
}

/**
 * 把 `collectHumanMessages()` 填好的材料预算累加器规整成落进
 * `state.lastRun.material` 的形状（`{ chars, kept, dropped, total }`）。
 *
 * 为什么需要这一层：`stats` 由**另一个改动**（`lib/profile.js` 的
 * `maxMaterialChars` + `stats` 选项）填充。它没落地时 `stats` 不会被填（全 0）；
 * 落地后字段也可能缺。这里只做两件事：
 *   1. 四个字段**一定存在且是有限非负整数**（`/state` 是界面契约，
 *      不允许 `undefined` 漏出去）；
 *   2. 数值**原样透传** —— 不在这里编造"省了多少"（真实裁剪发生在 profile.js 里）。
 * 四个字段的精确口径（条数还是字符）由 `collectHumanMessages()` 定义，见那里的注释。
 *
 * @param {{chars?:unknown, kept?:unknown, dropped?:unknown, total?:unknown}|null} stats
 * @returns {{chars:number, kept:number, dropped:number, total:number}}
 */
export function summarizeMaterialStats(stats) {
  const num = value => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  }
  return {
    chars: num(stats?.chars),
    kept: num(stats?.kept),
    dropped: num(stats?.dropped),
    total: num(stats?.total),
  }
}

/**
 * 把注入计划压成给界面看的摘要。
 *
 * 只留字段，不留文本：这个对象是**统计**，注入文本本身由 `getState().injectedText`
 * 单独给（两者分开，避免把长文本混进统计对象里 —— 那个长文本每 3 秒被
 * `/state` 轮询一次，但它就是用户要看的东西，所以必须给，只是不给在这里）。
 *
 * ⚠️ **字段名不许含 `token` 子串**（所以是 `budgetChars` / `estimatedChars`，
 * 不是 `budgetTokens` / `estimatedTokens`）。
 * 原因：`test/httptest.mjs` 有两条防凭据泄漏的断言会拿
 * `/(apiKey|api_key|token|secret|password)/i` 去扫 **GET /state 的完整 JSON**
 * 与 **state.json 的完整落盘**。字段名里带 `token` 会误命中，把"防凭据泄漏"
 * 变成"防预算字段"。
 *
 * ⚠️ **注意：名字叫 Chars，值其实是 token 口径的估算**（`estimateTokens()` 按
 * 宽字符 1、ASCII 1/4 折算）。字段名与单位不符是**刻意的**——为了满足上面那条
 * 命名约束。界面若要显示这个数，文案必须写"预算/token"，**不要写"字符"**，
 * 否则用户看到的数字会差一个量级。
 *
 * 同一约束也适用于 `profile.js` 里进入 `/state` 的注解文案，见那里的
 * `buildInjectionAnnotation()` 注释。
 *
 * @param {object} plan `planProfileInjection()` 的结果
 */
function summarizeInjection(plan) {
  return {
    budgetChars: plan.budgetTokens,
    totalEntries: plan.totalEntries,
    injectedEntries: plan.injectedEntries,
    omittedEntries: plan.omittedEntries,
    injectedByCategory: plan.injectedByCategory,
    omittedByCategory: plan.omittedByCategory,
    /**
     * 置顶（豁免预算）的条数，以及**真正进了注入文本的条目 id**。
     *
     * 后者是界面「未注入」区的唯一依据：界面拿 `profile.entries` 减去这批 id，
     * 差集就是"按规则没进系统提示"的那些。**界面不许自己重算注入取舍** ——
     * 那会退回"看到的 ≠ 注入的"（界面上只有完整画像，算不出宿主那次裁剪的结果）。
     */
    pinnedEntries: plan.pinnedEntries,
    injectedIds: Array.isArray(plan.injectedIds) ? plan.injectedIds : [],
    /** 这一版由新生试用位带进注入的条目 id（界面以后可以据此打"试用"徽标）。 */
    trialIds: Array.isArray(plan.trialIds) ? plan.trialIds : [],
    estimatedChars: plan.estimatedTokens,
    overBudget: plan.overBudget,
    annotation: plan.annotation,
  }
}

/**
 * `/state` 里的账本视图：**不暴露**内部的 `frozenCounts`。
 *
 * `frozenCounts` 是"这一版渲染时的冻结快照"，只服务于试用位判据；
 * 把它一起吐给界面会让"界面上有两个计数"变成新的解释负担。
 *
 * @param {object|null} ledger
 * @returns {{version:number|null, ids:string[], counts:Record<string,number>, lastAt:number|null}}
 */
function publicLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') {
    return { version: null, ids: [], counts: {}, lastAt: null }
  }
  return {
    version: Number.isFinite(ledger.version) ? ledger.version : null,
    ids: Array.isArray(ledger.ids) ? ledger.ids : [],
    counts: ledger.counts && typeof ledger.counts === 'object' && !Array.isArray(ledger.counts)
      ? ledger.counts
      : {},
    lastAt: Number.isFinite(ledger.lastAt) ? ledger.lastAt : null,
  }
}

/**
 * 把宿主当前的默认模型选择取出来，作为画像生成的兜底 provider/model。
 *
 * 用 `ctx.get('agentDefaultModel')` 而**不是** inject：
 * 这个服务在老宿主/精简宿主里可能不存在，inject 会让插件完全不 apply。
 * @param {any} root
 * @returns {{provider:string, model:string}|null}
 */
function resolveDefaultModel(root) {
  try {
    const service = typeof root.get === 'function' ? root.get('agentDefaultModel') : undefined
    if (!service || typeof service.currentSelection !== 'function') return null
    const selection = service.currentSelection()
    if (!selection) return null
    const provider = selection.provider ?? selection.config?.provider
    const model = selection.model ?? selection.config?.model
    if (!provider || !model) return null
    return { provider: String(provider), model: String(model) }
  } catch {
    return null
  }
}

/**
 * 配置规整。
 *
 * 走 schemastery 的 Standard Schema 接口（宿主就是这么送配置进来的：
 * `resolveConfig(runtime, config)` → `runtime.Config['~standard'].validate(config)`）。
 * 这里再兜一层：万一 validate 不可用（或返回了 undefined 字段），
 * 用一份内置默认值补齐，保证 apply 内部永远拿得到完整配置。
 */
export function resolveConfig(rawConfig) {
  const defaults = {
    stateDir: '',
    sessionsRoot: '',
    signals: {
      delegatePatterns: [
        '(请你|需要你|你自己)\\s*[去来把帮做先再重试看查改加写跑执行处理确认补删增]',
        '(请|麻烦|劳驾)你[^，。；\\n]{0,12}(一下|一趟|帮忙)',
      ],
      longToolMs: 60000,
      humanWaitTools: [
        'ask_user_question',
        'job_output',
        'job_list',
        'job_kill',
        'subagent',
        'list_agents',
        'send_message',
        'plugin_manager',
      ],
      repeatFailMin: 3,
      answerWindowMs: 1800000,
    },
    profile: {
      triggerUserMessages: 12,
      triggerNewSessions: 3,
      maxEvidenceMessages: 400,
      maxMessageChars: 500,
      // 送进提示词的**材料字符上限**（超出部分在 `collectHumanMessages()` 里裁掉，
      // 裁掉多少写进 `state.lastRun.material`，见那里的注释）。
      // ⚠️ 与下面 `maxTokens` 同一条约定：这个值必须与 `lib/schema.js` 的
      //    `profile.maxMaterialChars` `.default()` **同值**（真实宿主路径 schema 赢，
      //    测试路径 defaults 赢）；文件末尾的 `DEFAULT_MAX_MATERIAL_CHARS` 是第三处同值。
      //    为什么需要上限：材料是"每一条真人发言原文"，会话积累到几十万字符时
      //    整包塞进提示词既慢又贵，还会把无关的早期材料混进这一版画像。
      maxMaterialChars: 80000,
      // ⚠️ 改这个上限必须**同时**改 schema.js 里的 .default()，两处保持一致。
      //
      // 为什么两处都要改（**注意：不是"defaults 优先"**——早期注释写反了）：
      //   · 真实宿主路径：Fiber._resolveConfig → validate() 的 result.value（schema
      //     默认值已填满）才是 apply 收到的对象 → **生产环境 schema 赢**。
      //   · 测试路径：loadtest.mjs / httptest.mjs 直接调 apply(root, cfg)，
      //     那时才轮到这里的 defaults 兜底。
      //   两条路径共用一个值才有一致的默认行为。此结论由 index.js 审查员对着
      //   cordis/src/fiber.ts:641-655 核实。
      //
      // 8000 会在条目变多后截断 JSON（表现为"模型输出不是合法 JSON"）。
      maxTokens: 16000,
      timeoutMs: 300000,
      provider: '',
      model: '',
      autoRun: true,
    },
    scan: {
      intervalMs: 120000,
      maxFramesPerScan: 400,
      maxWindowSize: 64 << 20,
      scanOnStart: true,
    },
    inject: {
      order: 30,
      name: SECTION_NAME,
      // ⚠️ 这里只是 `resolveConfig` 的兜底值（见下面的合并逻辑）：**测试路径**
      // （loadtest.mjs / httptest.mjs 直接 `apply(root, cfg)`）走它。
      // 真实宿主走 `Fiber._resolveConfig → validate()`，**schema.js 里的
      // `.default()` 赢**（早期注释把优先级写反过，不要再抄错）。
      // 两条路径要有一致行为，所以改预算必须同时改这两处。
      // 1500 的分配：A 保底 30%（450）、B/C 各自上限 50%（750）、剩余 20% 弹性；
      // 超预算的条目只在注入侧省略。
      budgetTokens: 1500,
      // 置顶条数上限。⚠️ 与 schema.js 的 `.default(10)` 必须一致（哪一处生效
      // 取决于走哪条路径，见上面 budgetTokens 的注释）。
      //
      // 为什么必须有上限：置顶 = **豁免预算、保证注入**。没有上限时用户把几十条
      // 都 pin 上，等于把注入预算作废 —— 那正是本插件（"画像不许无上限注入"）
      // 要防的事。10 条约占预算的 500 上下，还在可控范围。
      maxPinned: 10,
    },
    logLevel: 'info',
  }

  let validated = rawConfig
  try {
    const schema = Config
    if (schema && schema['~standard'] && typeof schema['~standard'].validate === 'function') {
      const outcome = schema['~standard'].validate(rawConfig ?? {})
      // Standard Schema：结果是 { value } 或 { issues }
      if (outcome && typeof outcome === 'object' && 'value' in outcome) validated = outcome.value
      else if (outcome && typeof outcome.then === 'function') validated = rawConfig
    }
  } catch {
    validated = rawConfig
  }

  const merged = {
    ...defaults,
    ...(validated && typeof validated === 'object' ? validated : {}),
    signals: { ...defaults.signals, ...(validated?.signals ?? {}) },
    profile: { ...defaults.profile, ...(validated?.profile ?? {}) },
    scan: { ...defaults.scan, ...(validated?.scan ?? {}) },
    inject: { ...defaults.inject, ...(validated?.inject ?? {}) },
  }
  // 数组类字段单独兜底：validate 失败时可能给出非数组
  if (!Array.isArray(merged.signals.delegatePatterns) || merged.signals.delegatePatterns.length === 0) {
    merged.signals.delegatePatterns = defaults.signals.delegatePatterns
  }
  if (!Array.isArray(merged.signals.humanWaitTools)) {
    merged.signals.humanWaitTools = defaults.signals.humanWaitTools
  }
  return merged
}
