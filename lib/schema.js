/**
 * 插件配置 Schema（schemastery）。
 *
 * ## 为什么导出 `Config` 是必须的
 *
 * cordis 的 loader 读的是 `runtime.Config`，而 `runtime` 就是**本模块的默认导出对象**
 * （见 dsh-qq/lib/index.js 的注释：只做命名导出 `export { Config }` 不够，
 * 那样 loader 采集不到，设置页不会按 Schema 生成）。所以本文件同时被
 * `lib/index.js` 命名导出、并挂在默认导出对象的 `Config` 字段上。
 *
 * ## ⚠️ 绝不用 `.volatile()`
 *
 * dsh-qq/lib/schema.js 顶部记录了一个实测坑：schemastery 3.18 下给字段加
 * `.volatile()` 会让 `~standard.validate()` **同时丢弃默认值和传入值**
 * （`{ a: 'q' }` 校验成 `{ a: {} }`），而宿主正是通过该路径把配置送进来的。
 * 因此这里所有字段都不带 volatile。
 *
 * ## 配置里没有的东西（有意为之）
 *
 * - **没有 API key / 凭据**：画像生成走 `ctx.llm.stream()`，复用宿主已配置的
 *   provider/model 与凭据，本插件不接触任何密钥。
 * - **没有三个模式的开关**：模式与自定义文本、画像文本都属于**用户数据**，
 *   落在 `$DSH_HOME/prompt-adapt/state.json`，由 UI 侧通过宿主服务读写；
 *   放进配置会导致"改一次模式就重载插件"。
 *   本文件的字段全是**部署级调参**，改完由 Loader 重新 apply 即可。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /**
   * 状态目录。留空用 `$DSH_HOME/prompt-adapt`。
   * 与 dsh-qq / dsh-whale-widget 的落盘约定一致。
   */
  stateDir: z
    .string()
    .default('')
    .description('状态与画像数据的目录。留空使用 $DSH_HOME/prompt-adapt。'),

  /**
   * 会话日志根目录。留空用 `$DSH_HOME/sessions`。
   * **只读**：本插件绝不写这个目录下的任何文件。
   */
  sessionsRoot: z
    .string()
    .default('')
    .description('会话日志根目录（只读）。留空使用 $DSH_HOME/sessions。'),

  signals: z
    .object({
      /**
       * 「让你代跑」的句式正则。
       *
       * ⚠️ 第一版用的是"包含『需要你/请你/你自己』"。对真实日志抽样后发现
       * **命中的全是假阳性**：这些措辞在中文论说文里常作"需要你**注意**"、
       * "请**你**看这一点"用。所以改成要求"请求句式"（措辞 + 可选助词 + 动词），
       * 并且只判该轮**最后一条** assistant 消息。
       */
      delegatePatterns: z
        .array(z.string())
        .default([
          '(请你|需要你|你自己)\\s*[去来把帮做先再重试看查改加写跑执行处理确认补删增]',
          '(请|麻烦|劳驾)你[^，。；\\n]{0,12}(一下|一趟|帮忙)',
        ])
        .description(
          '「让你代跑」的句式正则（JavaScript RegExp 语法）。' +
            '判据是：该轮没有调用任何工具，且该轮最后一条 AI 消息命中其中任一正则。' +
            '误判时直接改这里。',
        ),

      /** 「命令失控」的墙钟阈值（毫秒） */
      longToolMs: z
        .natural()
        .min(1000)
        .default(60000)
        .description('命令类工具调用墙钟超过这个毫秒数就计一次「命令失控」。默认 60000（60 秒）。'),

      /**
       * 不算「命令失控」的工具：它们的耗时是在等人或等后台任务。
       * 实测 `ask_user_question` 的耗时全部是用户在思考（最长 5.5 小时），
       * 把它算成"命令失控"在语义上是错的。这些耗时会被单独归类为 humanWaitTools。
       */
      humanWaitTools: z
        .array(z.string())
        .default([
          'ask_user_question',
          'job_output',
          'job_list',
          'job_kill',
          'subagent',
          'list_agents',
          'send_message',
          'plugin_manager',
        ])
        .description('等待人类或后台任务的工具：耗时不计入「命令失控」，单独归类。'),

      /** 「工具反复失败」至少连续失败几次才算 */
      repeatFailMin: z
        .natural()
        .min(2)
        .default(3)
        .description('同一工具连续失败达到这个次数才算一次「工具反复失败」。默认 3。'),

      /** 「给了选项但用户自己另说」判定的时间窗（毫秒） */
      answerWindowMs: z
        .natural()
        .min(1000)
        .default(1800000)
        .description('ask_user_question 之后多久内的真人发言算作对该提问的回答。默认 30 分钟。'),
    })
    .description('四个零 LLM 计数信号的判据参数'),

  profile: z
    .object({
      /** 触发画像更新的新增真人发言条数 */
      triggerUserMessages: z
        .natural()
        .min(1)
        .default(12)
        .description('累计新增真人发言达到这个条数就触发一次画像更新。默认 12。'),

      /** 触发画像更新的新会话数 */
      triggerNewSessions: z
        .natural()
        .min(1)
        .default(3)
        .description('累计新增会话达到这个数量就触发一次画像更新。默认 3。两个判据先到者触发。'),

      /** 单次喂给模型的真人发言条数上限（按时间从新到旧取） */
      maxEvidenceMessages: z
        .natural()
        .min(10)
        .default(400)
        .description('单次画像生成最多喂多少条真人发言。控制 token 成本。'),

      /** 单条真人发言截断长度 */
      maxMessageChars: z
        .natural()
        .min(20)
        .default(500)
        .description('单条真人发言截断到这个字符数，避免一条超长粘贴占满预算。'),

      /**
       * 单次喂给模型的真人发言**总字符**上限。
       *
       * 为什么要有：上面两个字段只是**逐条**的上界（默认 400 × 500 = 20 万字符），
       * 而触发阈值只有 12 条新发言 —— 发言很多的老用户每触发一次就要把这 20 万
       * 字符整包重发一遍。这里按 `text.length` 从**最旧**的开始丢，最新一条永不丢。
       *
       * ⚠️ 与 `lib/profile.js` 的 `DEFAULT_MAX_MATERIAL_CHARS`、
       *    `lib/index.js` 里 `resolveConfig()` 的
       *    `defaults.profile.maxMaterialChars` 必须**同值 80000**（三处一致才有
       *    一致的默认行为，理由与 `inject.budgetTokens` 完全相同：真实宿主走这里的
       *    默认值，`loadtest.mjs` 那种直接 `apply(root, cfg)` 才轮到 defaults）。
       *    调小它会直接减少画像可依据的材料。
       */
      maxMaterialChars: z
        .natural()
        .min(1000)
        .default(80000)
        .description('单次画像生成喂给模型的真人发言总字符上限（从最旧的开始丢，最新一条永不丢）。默认 80000。'),

      /**
       * 画像生成一次调用的输出上限。
       *
       * 16000 是**余量**，不是根治手段：老契约要求"未变动的条目逐字照抄"，
       * 输出量随**画像总量**增长，实测 8000 会在条目变多后间歇性截断
       * （JSON 写到一半就到顶）。根治已经落在 `profile.js` 的**差量输出契约**
       * 上（`entries` 只放变化条目，未变的只列 id），输出量改为随变化量增长。
       * 这个上限保留为兜底 —— 万一模型不守契约、又退回去重打全文，
       * 16000 至少给它留够空间；真撞上了也有截断抢救（`lib/profile.js`）。
       */
      maxTokens: z
        .natural()
        .min(256)
        .default(16000)
        .description('画像生成这一次 LLM 调用的输出上限。'),

      /** 画像生成一次调用的硬超时 */
      timeoutMs: z
        .natural()
        .min(5000)
        .default(300000)
        .description('画像生成一次 LLM 调用的硬超时（毫秒）。'),

      /** 覆盖 provider；留空用宿主默认模型选择 */
      provider: z.string().default('').description('画像生成用的 provider。留空使用宿主当前默认模型。'),
      model: z.string().default('').description('画像生成用的 model。留空使用宿主当前默认模型。'),

      /** 是否允许插件自动触发画像生成 */
      autoRun: z
        .boolean()
        .default(true)
        .description('达到触发间隔时是否自动生成画像。关闭后只能由 UI 侧手动触发。'),
    })
    .description('自动画像的触发间隔与预算'),

  scan: z
    .object({
      /** 定期扫描会话日志的间隔 */
      intervalMs: z
        .natural()
        .min(5000)
        .default(120000)
        .description('后台增量扫描会话日志的间隔（毫秒）。默认 120000（2 分钟）。'),

      /** 单次扫描最多处理多少个 zstd 帧，防止一次卡死 */
      maxFramesPerScan: z
        .natural()
        .min(1)
        .default(400)
        .description('单次扫描最多解压多少个新帧。防止首次全量扫描把事件循环卡住。'),

      /** 单帧解压的窗口上限 */
      maxWindowSize: z
        .natural()
        .min(1 << 20)
        .default(64 << 20)
        .description('zstdDecompressSync 的 maxWindowSize。默认 64MiB（与实测一致）。'),

      /** 启动时是否立即扫描一次 */
      scanOnStart: z.boolean().default(true).description('插件 apply 后立即扫描一次会话日志。'),
    })
    .description('会话日志增量扫描'),

  inject: z
    .object({
      /** 生效画像的注入位置 */
      order: z
        .natural()
        .min(-1000)
        .max(10000)
        .default(30)
        .description(
          '系统提示里这段画像的排序位次。内置锚点：HARNESS_IDENTITY=-1000、' +
            'DEPLOYMENT_PERSONA_PREFIX=0、PLAN_POLICY=500。取 30 让画像紧跟部署人格、' +
            '排在所有工具说明之前。',
        ),
      name: z
        .string()
        .default('dsh-prompt-adapt:effective-profile')
        .description('系统提示段的注册名。同一 scope 内同名会抛，插件内只注册一次。'),

      /**
       * 注入预算（按 `estimateTokens()` 估算）。
       *
       * ⚠️ 改默认值必须**同时**改 `resolveConfig()` 的
       * `defaults.inject.budgetTokens`（本项目已知的易错点）。哪一处生效取决于
       * 路径：真实宿主走 `validate()` → **这里赢**；`loadtest.mjs` 那种直接
       * `apply(root, cfg)` 才轮到 defaults。两条路径共用一个值。
       *
       * 取舍规则：总预算 1500 里，A 类保底 30%（450，防止被 B/C 挤死）、
       * **B、C 合计**上限 50%（750，两类共用一个池子、超出按证据强度截断）、
       * 剩下 20% 是弹性；D 类（证据不足）不注入。
       * ⚠️ 是**合计** 750，不是"B/C 各自 750"：各自 750 时两类都堆满就是全部
       *    预算，A 的保底被挤成 0（实测 `{A:0,B:15,C:13}`），那正是要防的事。
       * 用户「置顶」（pin）的条目**豁免预算**，一定注入（条数上限见 `maxPinned`）。
       * 超预算的条目只在**注入侧**省略 —— 画像本身不删，界面与"复制到模式 2"
       * 拿到的仍是全文。
       */
      budgetTokens: z
        .natural()
        .min(0)
        .default(1500)
        .description(
          '注入系统提示的画像最多占多少（估算口径：中文 1 字≈1、ASCII 4 字符≈1）。' +
            '默认 1500。其中 A 类保底 30%、B、C 合计上限 50%、剩下 20% 弹性；' +
            'A 与 B/C 都按证据强度降序截断；D 类不注入；用户置顶的条目豁免预算、一定注入。' +
            '超预算的条目只在注入侧省略，画像与"复制到模式 2"的文本不受影响。',
        ),

      /**
       * 用户「置顶（pin）」的条数上限。
       *
       * 置顶 = 界面置顶 + **豁免注入预算、保证注入**（用户原话："pin 是界面置顶
       * 加上保证注入"）。**必须**有上限：没有它，用户把几十条都 pin 上就等于把
       * 注入预算作废 —— 那正是本插件（"画像不许无上限注入"）要防的事。
       * 到顶时界面上的「置顶」按钮会被禁用并说明原因（上限由宿主经 `/state`
       * 的 `maxPinned` 告诉界面，界面不写死数字）。
       *
       * ⚠️ 与 `lib/index.js` 里 `resolveConfig()` 的 `defaults.inject.maxPinned`
       *    必须一致（理由同 `budgetTokens`）。
       */
      maxPinned: z
        .natural()
        .min(0)
        .max(100)
        .default(10)
        .description(
          '用户「置顶」的条数上限（默认 10）。置顶的条目豁免注入预算、一定进系统提示，' +
            '所以必须有上限，否则等于取消预算。到顶后界面禁用「置顶」按钮并说明原因。',
        ),
    })
    .description('系统提示注入'),

  logLevel: z
    .union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')])
    .default('info')
    .description('日志详细程度。日志同时写入 $DSH_HOME/prompt-adapt/plugin.log。'),
})
