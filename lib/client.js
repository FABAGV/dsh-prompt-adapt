/**
 * dsh-prompt-adapt —— 浏览器半边（客户端插件）。
 *
 * ============================================================================
 * 这是什么
 * ============================================================================
 * 「让 AI 更好地适配用户」的设置界面。挂在 `settings.section`（设置里的
 * 一个独立页面），而不是 `settings.general.item`（General 里的一行）——
 * 理由见 UI-IMPLEMENTATION.md 第二节。
 *
 * 三块内容：
 *   模式 1 · 自动画像   只读展示 LLM 归纳的画像（A/B/C/D 四类）+ 证据量，
 *                       提供「复制」与「重新生成」。
 *   模式 2 · 自定义     用户自己写系统提示词的多行文本框，
 *                       提供「从模式 1 填入」（点了才填，不自动覆盖）。
 *   模式 3 · 提示词大厅 只是一个外链。不抓取、不缓存、不鉴权、不显示内容。
 *
 * 模式 1 与模式 2 **互斥**：由宿主侧 `state.mode` 单字段枚举保证，
 * 本界面只做选择器 + "切换后会以模式 1 为准"的提醒，不自己维护第二份真相。
 *
 * ============================================================================
 * 为什么这个文件长这样（没有构建步骤）
 * ============================================================================
 * DSH 的客户端插件 bundle 就是一个注册 factory 的脚本，格式见
 * `@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js`：
 *
 *     window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {...} });
 *
 * 本文件**手写**成同一格式，因此不需要 tsdown、不需要 TypeScript、
 * 不需要任何构建步骤就能被 `/plugins/dsh-prompt-adapt/client.js` 直接提供。
 * 代价（有意为之）：
 *   - 不用 JSX，改用 `react/jsx-runtime` 的 `jsx/jsxs`；
 *   - 只 `require("react")` 与 `require("react/jsx-runtime")`——这两个在
 *     外壳的静态模块基座里（PLATFORM_MODULES），因此 `dsh.client.external`
 *     留空即可；
 *   - `ctx.slots` / `ctx.locale` 一律从插件 ctx 拿，**不 import 任何
 *     @deepseek-ai/* 包**，避免依赖 `dsh.client.external` 的动态解析。
 *
 * ============================================================================
 * 与宿主侧怎么通信（契约已实现，已验证）
 * ============================================================================
 * 宿主半边暴露了一个 cordis 服务（`lib/index.js`，`super(ctx, 'promptAdapt')`），
 * 并由 `lib/http.js` 用 `webServer.register({kind:'prefix'})` 把它暴露成
 * **一条 prefix 路由** `API_PREFIX = '/dsh-prompt-adapt/api'`：
 *
 *     GET  /dsh-prompt-adapt/api/state       → { contract:1, ...getState(), hallUrl }
 *     POST /dsh-prompt-adapt/api/mode        { mode }        → 200 { ok, mode, state }
 *     PUT  /dsh-prompt-adapt/api/custom      { text }        → 200 { ok, length, state }
 *     POST /dsh-prompt-adapt/api/regenerate  {}              → **202** { ok, started }
 *     POST /dsh-prompt-adapt/api/copied      { text, entries, algorithmVersion } → 200
 *     POST /dsh-prompt-adapt/api/rescan      {}              → 202（客户端目前不调用）
 *
 * 三个必须知道的实现细节（都是照着宿主的真实代码对齐的）：
 *
 *   1. `/regenerate` **立刻回 202**，生成在后台跑（`lib/http.js:252-270`）。
 *      所以不能等 POST 返回结果 —— 见 createAdaptStore 里的 watcher。
 *   2. 宿主的 `getState()` **没有 `running` 字段**（`lib/index.js` 的 `validate()`
 *      只要求 6 个方法）。于是"生成完没有"只能靠
 *      `profile.version` / `profile.generatedAt` / `lastRun.at` 的变化来判。
 *   3. `algorithmVersion` 必须是**字符串**：宿主 `markCopied(text, extra)` 里
 *      写的是 `typeof extra.algorithmVersion === 'string' ? … : null`。
 *      传数字会被静默丢成 null。
 *
 * 这一层已经有集成测试：`tools/calibrate.mjs` 第 7 节把宿主的
 * `registerRoutes()` 挂到假 webServer 上，再把 fetch 接到那个 handler 上，
 * 于是客户端的每个请求都真的过一遍宿主的路径分发/方法校验/body 解析。
 *
 * ⚠️ 未确认：DSH 生成式 remote（`ctx.remote.<ns>.<method>()`）在这里的确切
 * 声明方式我没有查证，因此**没有**采用，也没有在代码里猜任何 remote API 名。
 * ============================================================================
 * 「有 N 处修订」为什么这么算
 * ============================================================================
 * 实测同一输入重复生成会产生 26.3% 的假变化（宿主 profile.js 顶部记录了
 * 这个基线）。所以比较必须**保守：宁可漏报，不要刷一堆假修订**。
 *
 * 关键判断：**中文同义改写用字符相似度是判不出来的**。
 *    「用户偏好简短回答」 vs 「用户喜欢简洁的表达」
 *    字符 bigram Jaccard ≈ 0.07 —— 几乎完全不重叠，但含义相同。
 * 任何"文本相似度 ≥ 阈值就算没变"的做法在中文里都会大面积漏判成"变了"。
 *
 * 因此本实现的主判据**不是文本，而是证据**（沿用宿主 diffProfiles 的设计意图）：
 *
 *   同 id、claim 变了：
 *     ├─ category 变了                          → **算修订**
 *     ├─ 两边都有 evidence 且集合不同            → **算修订**（有新材料支撑）
 *     ├─ 两边都有 evidence 且集合逐字相同        → **不算修订**（只是换了措辞）
 *     └─ 证据不可比（缺一边/都没有）             → 退到文本兜底，阈值极低
 *
 * 第三行是压制假变化的关键一刀：**证据一致时不给文本任何翻案机会**。
 * 只有这样，"不要在没有确认的情况下动别人的文件" → "改动他人文件之前必须
 * 先征求同意" 这种同义改写（字符相似度仅 0.15~0.20）才不会被误报成修订。
 *
 * 另有两道保守闸门：
 *   1. 全局闸门：两版画像的归一化 token 集合 Jaccard ≥ 0.90 → 直接判 0 处。
 *   2. 基线搭不上：如果基线只有纯文本（没有结构化 entries），
 *      **不猜**、不编数字，count=0 并明确告诉用户"比较不可靠，请再复制一次"。
 *
 * 用户复制时会把**结构化快照**（entries + 算法版本）同时写进
 * localStorage 与宿主 `copiedSnapshot`，所以复制一次之后精确比较即生效。
 *
 * ============================================================================
 * 主题与文案
 * ============================================================================
 * 颜色**全部**走 `--dsw-*` token（取自 @deepseek-ai/dsh-client-ui-theme），
 * 本文件不出现任何 hex/rgb/hsl 字面量。
 * 文案集中在 `COPY`，按 zh/en 两套；界面渲染时通过 ctx.locale 取。
 */

window.__ModuleLoader__.load({
	id: "dsh-prompt-adapt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;

		// ====================================================================
		// 常量
		// ====================================================================

		/** 文案命名空间。 */
		const NS = "prompt-adapt";

		/** 宿主 HTTP 契约的基路径（prefix 路由）。 */
		const API_PATH = "/dsh-prompt-adapt/api";

		/** localStorage 里放"上次复制快照"的键（按算法版本分隔）。 */
		const LOCAL_SNAPSHOT_KEY = "dsh-prompt-adapt:copied:v1";

		/** 宿主 `renderProfileText` 用的四个分类标题，用于把纯文本快照解析回条目。 */
		const CATEGORY_TITLES = {
			A: "稳定特质",
			B: "行不通的做法",
			C: "有效的做法",
			D: "证据不足（不下结论）",
		};

		/** 分类展示顺序。D 单独折叠——它对模型没有约束力（见宿主 renderProfileText）。 */
		const CATEGORY_ORDER = ["A", "B", "C"];
		const CATEGORY_EXTRA = "D";

		/**
		 * 比较算法版本。改了 normalize/阈值就必须改这个值：
		 * 旧基线是用旧算法记的，跨版本比较没有意义，宁可报"暂不比较"。
		 *
		 * ⚠️ 用**字符串**：宿主 `markCopied(text, extra)` 只接受
		 * `typeof extra.algorithmVersion === 'string'`，数字会被它丢成 null。
		 * 比较时两边都 `String()` 归一，所以旧客户端传数字也不会误判。
		 */
		const ALGORITHM_VERSION = "1";

		/**
		 * 比较参数。全部集中在这里，便于用 tools/calibrate.mjs 拿真实样本标定。
		 * 方向性：**任何一个参数调松都会让"修订数"变多**，所以默认值一律偏保守。
		 */
		const COMPARE_DEFAULTS = {
			/** 全局闸门：整体 token 集合 Jaccard ≥ 此值 → 判 0 处修订。 */
			globalSimilarityFloor: 0.9,
			/**
			 * **仅在证据不可比时**（两边都没有 evidence）使用的兜底阈值：
			 * claim 相似度 ≥ 此值 → 视为"只是换了措辞"。压得很低 = 宁漏报。
			 * 注意：证据可比时这个阈值根本不参与判定。
			 */
			noEvidenceRewordFloor: 0.3,
			/** id 抖动归并：把"删掉的条目"和"新增的条目"配对时，claim 相似度 ≥ 此值算同一条。 */
			idChurnMatchFloor: 0.8,
			/** 纯文本兜底模式下，贪心配对的相似度门槛（仅用于统计匹配数，不用于报修订数）。 */
			textOnlyMatchFloor: 0.5,
			/** 视为"证据集合没变"的阈值：低于它才算证据变了。 */
			evidenceSameFloor: 0.999,
			/** 归一化时先剥掉的"证据量"噪声（"（基于 12 条发言）"这类）。 */
			evidenceNoise: [
				/[（(]\s*基于[^）)]*[）)]/g,
				/[（(]\s*based on[^）)]*[）)]/gi,
				/基于\s*\d+\s*条发言/g,
				/\d+\s*条发言/g,
			],
			/** 归一化时剥掉的标点（中英）。 */
			punctuation: /[\s\u3000!-/:-@[-`{-~\u3001-\u303f\uff01-\uff5e\u2018\u2019\u201c\u201d\u2014\u2026·]+/g,
			/** 虚词/模糊限定词。删掉它们能吸收一部分措辞抖动。只收真正的填充词。 */
			hedges: [
				"通常", "一般来讲", "一般来说", "一般", "可能", "大概", "似乎", "往往",
				"比较", "较为", "相对", "有点", "稍微", "倾向于", "偏好于", "其实",
				"实际上", "基本上", "总的来说", "总体而言", "明显", "非常", "十分",
				"较为明显", "更容易", "更喜欢",
				"usually", "generally", "often", "sometimes", "probably", "maybe",
				"perhaps", "somewhat", "relatively", "actually", "basically", "really",
				"quite", "rather", "fairly", "pretty", "might", "could", "may",
			],
		};

		/** 分类 → 界面上用哪个 token 做重音（全部是 token 名，不是颜色值）。 */
		const CATEGORY_TONE = {
			A: "toneA",
			B: "toneB",
			C: "toneC",
			D: "toneD",
		};

		// ====================================================================
		// 文案（唯一语言集中点）
		// ====================================================================

		const zh = {
			nav: "AI 适配",
			title: "让 AI 更好地适配你",
			intro:
				"选一种方式告诉 AI 你希望它怎么和你协作。两种模式互斥，任何时刻只有一个生效。",

			modeLegend: "生效方式",
			modeAuto: "自动画像",
			modeAutoDesc: "由 AI 从你的历史会话里归纳，你只读。",
			modeCustom: "自定义",
			modeCustomDesc: "你自己写系统提示词。",
			effectiveNow: "当前生效：{name}",
			effectiveAuto: "自动画像",
			effectiveCustom: "自定义",
			switchWarnTitle: "切换到「自动画像」会以模式 1 为准",
			switchWarnBody:
				"模式 2 的文本会保留、不会丢，但不再注入。确定切换吗？",
			switchWarnConfirm: "仍然切换",
			switchWarnCancel: "取消",
			inactiveTag: "未生效",
			activeTag: "生效中",

			autoHeading: "模式 1 · 自动画像",
			autoUpdated: "上次更新：{time}",
			autoNever: "还没有生成过画像",
			autoBasedOn: "画像基于 {n} 条发言",
			autoEvidence: "基于 {n} 条发言",
			autoQuotes: "引文 {n} 处",
			autoConfidence: "置信度 {level}",
			autoVersion: "v{v}",
			autoExtraLabel: "补充说明（附加在画像之后，只读）",
			autoEmpty: "画像还没生成。攒够发言后会自动生成，也可以点「重新生成」。",
			autoEmptyHint:
				"还没有画像文本。可能是首次生成尚未完成，或上一次生成失败了——「上次生成」那张卡里有具体原因。" +
				"生成成功后画像会自动出现在这里；也可以直接切到模式 2 自己写。",
			copyEmpty: "现在没有可复制的内容：模式 1 还没有画像文本，原因见「上次生成」那张卡。",
			autoNotes: "归纳备注",
			autoRaw: "模型原始输出（排障用）",

			// —— 条目处置：置顶 / 封印 / 删除（每条的三个红色按钮）——
			// 语义由宿主落实（`lib/index.js` 的 markEntry/clearMark），这里只有文案。
			// ⚠️ zh / en 两套字典的 key 必须**一一对应**（tools/calibrate.mjs 有断言）。
			pinEntry: "置顶",
			pinEntryHint: "置顶 = 界面置顶 + 一定进注入（豁免预算）。最多 {max} 条。",
			pinEntryLimit: "置顶已满 {max} 条：先取消一个再置顶。",
			unpinEntry: "取消置顶",
			sealEntry: "封印",
			sealEntryHint: "封印 = 拉进垃圾桶：不再注入，之后的更新也不会再产出它。",
			unsealEntry: "恢复",
			deleteEntry: "删除",
			deleteEntryHint:
				"删除只去掉这一版；下次总结若材料里还有依据，它可能再次出现（会记一次删除）。",
			pinnedHeading: "置顶（{n} 条）",
			pinnedHint: "你标记为重要的条目：这里置顶显示，并且一定进注入（不受预算限制）。",
			pinnedGone: "当前画像里已没有这条（模型认为材料里没有依据了）",
			deleteCountBefore: "曾删 {n} 次",
			omittedHeading: "未注入（{n} 条）",
			omittedHint:
				"完整画像里被**注入预算裁掉**、这次没进系统提示的条目。证据不足的 D 类在上面「证据不足」自己那个折叠里。",
			sealedHeading: "垃圾桶（{n} 条）",
			sealedHint: "被你封印的条目：不参与注入，之后的更新也不会再产出它们。封错了可以恢复。",
			deletedHeading: "已删除（{n} 条）",
			deletedHint:
				"你删过的条目。删除**不禁止**模型重新归纳，所以它们可能再次出现 —— 想彻底挡住请用「封印」。",
			deletedCount: "已删 {n} 次",
			deletedBack: "已再次出现在画像里",
			entryPinnedTag: "已置顶",
			entrySealedTag: "已封印",

			// —— 实际注入的系统提示（模式 1 卡片顶部，最显眼的位置）——
			// 宿主 `GET /state` 的 `injectedText` **原样**渲染，界面不重新拼。
			// 这就是"看到的 = 注入的"的落实方式：两边同一次函数调用。
			injectHeading: "实际注入的系统提示",
			injectHint:
				"以上是实际注入的系统提示（按预算裁剪，共 {m} 条）；下方是完整画像（{n} 条）。",
			injectCount: "共 {m} 条",
			// 各分类注入了几条 —— 数字**来自宿主的 `injection.injectedByCategory`**，
			// 界面不自己算（界面自己算就会出现"看到的 ≠ 注入的"）。
			// A 类有保底份额，用户要能在这里自己验证它没被 B/C 挤成 0。
			injectBreakdown: "A {a} 条 · B {b} 条 · C {c} 条",
			injectEmpty: "当前没有注入任何内容（还没有画像文本）。",
			ledgerHint:
				"注入账本 v{v}：当前 {n} 条从未进过系统提示（账本按条目 id 累计，跨版本）。",
			ledgerSeen: "已注入 {n} 版",
			ledgerNever: "从未注入",
			genWarnings: "本次生成警告（{n}）",
			workingNotesHeading: "工作笔记（{n}）",
			workingNotesHint:
				"项目 / 工具 / 路径 / 账号 / 仓库类事实。不占画像槽位，也不会被自动注入。",
			fullProfileLabel: "完整画像（注入时按预算取舍，这里始终是全量，共 {n} 条）",

			copy: "复制",
			copied: "已复制",
			copyFailed: "复制失败：请手动选中后复制",
			regenerate: "重新生成",
			regenerating: "生成中…",
			regeneratingHint:
				"生成已在后台开始，完成后这里会自动更新（需要几秒到几分钟）。",
			regenerateHint: "手动触发一次画像更新。",
			confidenceHigh: "高",
			confidenceMedium: "中",
			confidenceLow: "低",

			revHeadingDirty: "有 {n} 处修订",
			revHeadingClean: "与你上次复制时一致",
			revHeadingUnknown: "尚未记录比较基线",
			revHeadingStale: "基线由旧版本算法记录，暂不比较",
			revHeadingLowConfidence: "基线信息不足，暂不比较",
			revHintUnknown: "复制一次模式 1 的画像，之后这里会提示画像有没有实质变化。",
			revHintLowConfidence:
				"上次复制时只记了文本、没记结构化条目，而中文改写用文本比对判不出来。已按「宁可漏报」处理：这里不报修订数。再复制一次即可启用精确比较。",
			revHintStale: "比较算法已升级。再复制一次即可重新建立基线。",
			revHintClean: "自上次复制以来，画像没有出现有依据的变化。",
			revHintDirty:
				"只统计有新材料支撑的增/删/改写；单纯换了措辞不算（实测这类抖动占比很高）。",
			revDetail: "查看这 {n} 处",
			revKindAdded: "新增",
			revKindRemoved: "删除",
			revKindModified: "改写",
			revBaselineAt: "基线时间：{time}",
			revBaselineVersion: "基线画像版本：v{v}",
			revSpurious: "上次生成的措辞抖动率：{rate}",

			customHeading: "模式 2 · 自定义",
			customPlaceholder:
				"在这里写你希望 AI 遵守的系统提示词。\n\n可以先从模式 1 复制画像，粘贴进来再改。",
			customSave: "保存",
			customSaved: "已保存",
			customSaving: "保存中…",
			customDirty: "有未保存的修改",
			customClean: "已与宿主同步",
			customFill: "从模式 1 填入",
			customFillEmpty: "模式 1 还没有画像文本可填。",
			customFillConfirmTitle: "填入会覆盖当前文本框内容",
			customFillConfirmBody: "当前内容还没被覆盖，确认后才会替换。",
			customFillConfirm: "确认填入",
			customFillCancel: "取消",
			customChars: "{n} 字",

			hallHeading: "模式 3 · 提示词大厅",
			hallDesc: "查看别人写的提示词，作为参考。",
			hallLink: "查看网友提示词 ↗",
			hallUnset: "外链地址尚未配置（需要你确认用哪个站点）。",
			hallNote: "本插件不抓取、不缓存、不鉴权、不在这里显示对方内容；点击只是新标签打开。",

			statusLoading: "正在读取宿主状态…",
			statusDisconnected: "未连接宿主",
			statusDisconnectedBody:
				"读取 {url} 失败：{error}。界面可以看，但读写都不可用。宿主侧（lib/index.js）需要按 UI-IMPLEMENTATION.md 第三节的契约实现这些路由。",
			statusRetry: "重试",
			statusPreview: "预览数据（仅界面演示，未连接宿主）",
			statusPreviewOn: "载入预览数据",
			statusPreviewOff: "退出预览",
			statusContract: "契约版本 {v}",
			signalHeading: "四个计数信号",
			signalHint: "这四个数字是宿主从会话日志里数出来的事实，不是模型判断。",
			signalSessions: "参与会话",
			signalHuman: "真人发言",
			signalDelegate: "AI 把活推回给你",
			signalLongTool: "命令失控（超时）",
			signalRepeatFail: "同一工具反复失败",
			signalFreeform: "给了选项你却自己另说",
			signalUnpaired: "（另有 {n} 条工具结果配不上调用，未计入）",
			lastRunHeading: "上次生成",
			lastRunOk: "成功",
			lastRunFail: "失败",
			lastRunReason: "原因：{reason}",
			errorPrefix: "出错了：",
			unsetCategory: "其他",
			close: "关闭",
			openSettings: "打开设置",
		};

		const en = {
			nav: "AI adaptation",
			title: "Help the AI adapt to you",
			intro:
				"Pick how the AI should learn to work with you. The two modes are mutually exclusive — exactly one is in effect at any time.",

			modeLegend: "Effective mode",
			modeAuto: "Automatic profile",
			modeAutoDesc: "Summarized by the AI from your past sessions. Read-only.",
			modeCustom: "Custom",
			modeCustomDesc: "You write the system prompt yourself.",
			effectiveNow: "In effect: {name}",
			effectiveAuto: "Automatic profile",
			effectiveCustom: "Custom",
			switchWarnTitle: "Switching to “Automatic profile” makes mode 1 authoritative",
			switchWarnBody:
				"Your mode 2 text is kept — nothing is lost — but it will no longer be injected. Switch anyway?",
			switchWarnConfirm: "Switch anyway",
			switchWarnCancel: "Cancel",
			inactiveTag: "Not in effect",
			activeTag: "In effect",

			autoHeading: "Mode 1 · Automatic profile",
			autoUpdated: "Last updated: {time}",
			autoNever: "No profile has been generated yet",
			autoBasedOn: "Profile is based on {n} messages",
			autoEvidence: "Based on {n} messages",
			autoQuotes: "{n} quotes",
			autoConfidence: "confidence {level}",
			autoVersion: "v{v}",
			autoExtraLabel: "Supplementary note (appended, read-only)",
			autoEmpty: "No profile yet. It generates on its own once enough messages exist, or press “Regenerate”.",
			autoEmptyHint:
				"No profile text yet. Either the first generation has not finished, or the last one failed — the “Last run” card has the reason. " +
				"The profile appears here automatically once generation succeeds; you can also switch to mode 2 and write your own.",
			copyEmpty: "Nothing to copy: mode 1 has no profile text yet — see the “Last run” card for the reason.",
			autoNotes: "Generator notes",
			autoRaw: "Raw model output (troubleshooting)",

			// —— Per-entry actions: pin / seal / delete ——
			// The semantics live on the host (`lib/index.js` markEntry/clearMark).
			// ⚠️ Keys must mirror the `zh` dictionary one-for-one
			// (tools/calibrate.mjs asserts the two key sets are identical).
			pinEntry: "Pin",
			pinEntryHint: "Pinning keeps it at the top here and always injects it (budget-exempt). At most {max}.",
			pinEntryLimit: "Pin limit reached ({max}): unpin one first.",
			unpinEntry: "Unpin",
			sealEntry: "Seal",
			sealEntryHint:
				"Sealing moves it to the trash: never injected again, and later updates must not produce it either.",
			unsealEntry: "Restore",
			deleteEntry: "Delete",
			deleteEntryHint:
				"Deleting only removes it from this version; a later summary may bring it back if the evidence is still there (that counts as one deletion).",
			pinnedHeading: "Pinned ({n})",
			pinnedHint:
				"Entries you marked as important: listed first here and always injected (budget-exempt).",
			pinnedGone: "No longer in the profile (the model found no evidence for it)",
			deleteCountBefore: "deleted {n}× before",
			omittedHeading: "Not injected ({n})",
			omittedHint:
				"Entries in the complete profile that the **injection budget trimmed** out of the system prompt. Category-D entries with weak evidence live in their own “weak evidence” fold above.",
			sealedHeading: "Trash ({n})",
			sealedHint:
				"Entries you sealed: never injected, and later updates must not produce them. Restore if you sealed one by mistake.",
			deletedHeading: "Deleted ({n})",
			deletedHint:
				"Entries you deleted. Deleting does **not** forbid the model from concluding them again, so they may come back — use “Seal” to block them for good.",
			deletedCount: "deleted {n}×",
			deletedBack: "Back in the profile",
			entryPinnedTag: "Pinned",
			entrySealedTag: "Sealed",

			// —— The text that is actually injected into the system prompt ——
			// Rendered verbatim from the host's `GET /state` field `injectedText`;
			// the UI never reassembles it, so "what you see" is "what is injected".
			injectHeading: "System prompt actually injected",
			injectHint:
				"The block above is the system prompt actually injected (trimmed to budget, {m} entries); below is the complete profile ({n} entries).",
			injectCount: "{m} entries",
			// Per-category counts, taken **verbatim from the host's
			// `injection.injectedByCategory`** — the UI must not compute them
			// (computing here would reintroduce "what you see ≠ what is injected").
			injectBreakdown: "A {a} · B {b} · C {c}",
			injectEmpty: "Nothing is injected right now (no profile text yet).",
			ledgerHint:
				"Injection ledger v{v}: {n} entries have never entered the system prompt (counted by id across versions).",
			ledgerSeen: "Injected in {n} version(s)",
			ledgerNever: "Never injected",
			genWarnings: "Generation warnings ({n})",
			workingNotesHeading: "Working notes ({n})",
			workingNotesHint:
				"Project / tool / path / account / repository facts. They do not use profile slots and are never injected automatically.",
			fullProfileLabel:
				"Complete profile (injection trims to budget; this list is always complete — {n} entries)",
			copy: "Copy",
			copied: "Copied",
			copyFailed: "Copy failed — please select and copy manually",
			regenerate: "Regenerate",
			regenerating: "Generating…",
			regeneratingHint:
				"Generation started in the background; this view updates on its own when it finishes (seconds to minutes).",
			regenerateHint: "Trigger one profile update by hand.",
			confidenceHigh: "high",
			confidenceMedium: "medium",
			confidenceLow: "low",

			revHeadingDirty: "{n} revision(s)",
			revHeadingClean: "Matches what you last copied",
			revHeadingUnknown: "No comparison baseline yet",
			revHeadingStale: "Baseline predates the current algorithm — not compared",
			revHeadingLowConfidence: "Baseline too coarse — not compared",
			revHintUnknown: "Copy the mode 1 profile once and this will start reporting real changes.",
			revHintLowConfidence:
				"The last copy stored text only, and Chinese paraphrases cannot be told apart by text comparison. Staying conservative: no revision count is shown. Copy once more to enable precise comparison.",
			revHintStale: "The comparison algorithm changed. Copy once more to rebuild the baseline.",
			revHintClean: "Since your last copy, nothing in the profile changed with new evidence behind it.",
			revHintDirty:
				"Only additions, removals, and rewrites backed by new evidence count — pure rewording does not (that churn is frequent in practice).",
			revDetail: "Show the {n}",
			revKindAdded: "added",
			revKindRemoved: "removed",
			revKindModified: "rewritten",
			revBaselineAt: "Baseline: {time}",
			revBaselineVersion: "Baseline profile version: v{v}",
			revSpurious: "Wording-churn rate of the last run: {rate}",

			customHeading: "Mode 2 · Custom",
			customPlaceholder:
				"Write the system prompt you want the AI to follow.\n\nYou can copy the mode 1 profile first, paste it here, and edit.",
			customSave: "Save",
			customSaved: "Saved",
			customSaving: "Saving…",
			customDirty: "Unsaved changes",
			customClean: "In sync with the host",
			customFill: "Fill from mode 1",
			customFillEmpty: "Mode 1 has no profile text to fill in yet.",
			customFillConfirmTitle: "Filling will overwrite the text box",
			customFillConfirmBody: "Nothing has been replaced yet — confirm to continue.",
			customFillConfirm: "Confirm fill",
			customFillCancel: "Cancel",
			customChars: "{n} chars",

			hallHeading: "Mode 3 · Prompt hall",
			hallDesc: "Browse prompts other people wrote, for reference.",
			hallLink: "See community prompts ↗",
			hallUnset: "No external URL configured yet (you need to pick a site).",
			hallNote:
				"This plugin does not fetch, cache, authenticate, or render the other site's content; the click just opens a new tab.",

			statusLoading: "Reading host state…",
			statusDisconnected: "Host not connected",
			statusDisconnectedBody:
				"GET {url} failed: {error}. The UI is viewable but reads and writes are unavailable. The host half (lib/index.js) must implement the routes in UI-IMPLEMENTATION.md §3.",
			statusRetry: "Retry",
			statusPreview: "Preview data (UI demo only, host not connected)",
			statusPreviewOn: "Load preview data",
			statusPreviewOff: "Exit preview",
			statusContract: "contract v{v}",
			signalHeading: "The four counter signals",
			signalHint: "These numbers are counted from session logs by the host — not model judgement.",
			signalSessions: "Sessions",
			signalHuman: "Human messages",
			signalDelegate: "AI handed work back",
			signalLongTool: "Runaway commands (over threshold)",
			signalRepeatFail: "Same tool failing repeatedly",
			signalFreeform: "Options offered, you said something else",
			signalUnpaired: "({n} tool results had no matching call and are excluded)",
			lastRunHeading: "Last run",
			lastRunOk: "succeeded",
			lastRunFail: "failed",
			lastRunReason: "Reason: {reason}",
			errorPrefix: "Error: ",
			unsetCategory: "Other",
			close: "Close",
			openSettings: "Open settings",
		};

		// ====================================================================
		// 样式：全部走 --dsw-* token，无任何颜色字面量
		// ====================================================================

		const CSS_TEXT = `
.pa_root{max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);font-family:var(--dsw-font-family)}
.pa_h2{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}
.pa_intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.pa_card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill);padding:14px;display:flex;flex-direction:column;gap:10px}
.pa_card[data-inactive=true]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.pa_cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.pa_cardTitle{margin:0;font:var(--dsw-font-s-strong-14);font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pa_cardHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pa_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pa_spacer{flex:1 1 auto}
.pa_seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.pa_segBtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:7px 14px;cursor:pointer}
.pa_segBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pa_segBtn[data-active=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.pa_segBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.pa_effective{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.pa_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.pa_badge{display:inline-flex;align-items:center;gap:4px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);padding:2px 7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.pa_badge[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-secondary)}
.pa_badge[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-secondary)}
.pa_badge[data-tone=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.pa_badge[data-tone=business]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-tertiary)}
.pa_meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pa_btn{appearance:none;font:inherit;font-size:13px;line-height:20px;padding:6px 12px;border-radius:var(--dsw-radius-md);cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary)}
.pa_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pa_btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.pa_btn[data-variant=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.pa_btn[data-variant=primary]:hover{background:var(--dsw-alias-button-primary-hover)}
.pa_btn[disabled]{opacity:.55;cursor:not-allowed}
.pa_group{display:flex;flex-direction:column;gap:6px}
.pa_groupTitle{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.pa_groupBar{width:3px;height:14px;border-radius:var(--dsw-radius-xs);display:inline-block}
.pa_groupBar[data-tone=toneA]{background:var(--dsw-alias-state-business-primary)}
.pa_groupBar[data-tone=toneB]{background:var(--dsw-alias-state-warn-primary)}
.pa_groupBar[data-tone=toneC]{background:var(--dsw-alias-state-success-primary)}
.pa_groupBar[data-tone=toneD]{background:var(--dsw-alias-label-tertiary)}
.pa_list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pa_entry{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.pa_claim{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
/* 每条条目旁的处置按钮（置顶 / 封印 / 删除）与折叠区里的（恢复 / 取消置顶）。 */
.pa_entryActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pa_entryActions .pa_spacer{flex:1 1 auto}
/* 危险动作（封印 / 删除）走"危险/错误"语义的 token：白天黑夜两套主题都跟着变。 */
.pa_btn[data-variant=danger]{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.pa_btn[data-variant=danger]:hover{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-label-primary-foreground)}
.pa_btn[data-variant=danger]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-error-primary));outline-offset:2px}
/* 已处置条目的标记徽标（复用 pa_badge 的取值，只是更小一号）。 */
.pa_markTag{font-size:10px;line-height:14px;padding:1px 6px}
.pa_evidenceRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.pa_textarea{width:100%;box-sizing:border-box;min-height:180px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-base-16);font-family:var(--dsw-font-family);padding:10px;line-height:1.55}
.pa_textarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-color:var(--dsw-alias-state-business-primary)}
.pa_textarea::placeholder{color:var(--dsw-alias-markdown-placeholder)}
.pa_notice{border-radius:var(--dsw-radius-md);padding:9px 11px;font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:6px}
.pa_notice[data-tone=warn]{border-color:var(--dsw-alias-state-warn-secondary);color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-bg-layer-2)}
.pa_notice[data-tone=error]{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.pa_noticeTitle{margin:0;font-weight:600;color:inherit}
/* 实际注入的系统提示：模式 1 卡片里最显眼的一块（颜色一律走 --dsw-*） */
.pa_inject{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.pa_injectHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pa_injectLabel{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pa_injectText{margin:0;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:var(--dsw-font-markdown-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-sm);padding:8px}
.pa_link{color:var(--dsw-alias-link);text-decoration:none;font-size:13px}
.pa_link:hover{text-decoration:underline}
.pa_link:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.pa_details{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 10px}
.pa_details>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);list-style:none}
.pa_details>summary::-webkit-details-marker{display:none}
.pa_details>summary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.pa_pre{margin:6px 0 0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:var(--dsw-font-markdown-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-sm);padding:8px}
.pa_signals{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.pa_signal{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.pa_signalValue{font:var(--dsw-font-m-18);font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pa_signalLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.pa_sep{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}
.pa_hidden{display:none}
`;

		const CSS_TAG_ID = "dsh-prompt-adapt/client.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-prompt-adapt";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
		}

		// ====================================================================
		// 纯函数核心：归一化 / 相似度 / 修订比较
		//
		// 这一节刻意写成无副作用、不碰 DOM、不碰 React 的纯函数，
		// 并被 tools/calibrate.mjs 通过 exports.__internals 直接调用 ——
		// 标定阈值时用的是**真实画像样本**，不是这里的假设。
		// ====================================================================

		/**
		 * 归一化一条 claim：剥证据量噪声 → 去标点 → 去虚词 → 折叠空白。
		 * @param {string} text
		 * @param {object} [options]
		 * @returns {string}
		 */
		function normalizeClaim(text, options) {
			const opts = options || COMPARE_DEFAULTS;
			let value = String(text == null ? "" : text);
			if (typeof value.normalize === "function") value = value.normalize("NFKC");
			value = value.toLowerCase();
			for (const pattern of opts.evidenceNoise) value = value.replace(pattern, " ");
			value = value.replace(opts.punctuation, " ");
			for (const hedge of opts.hedges) {
				if (!hedge) continue;
				value = value.split(hedge).join(" ");
			}
			return value.replace(/\s+/g, " ").trim();
		}

		/**
		 * 归一化文本 → token 集合。
		 *
		 * 中日韩字符没有词边界，用**字符 bigram**；拉丁/数字按词切。
		 * 注意：这个表示对**逐字照抄**很敏感（照抄→相似度≈1），
		 * 对**同义改写**几乎不敏感（≈0.07）。正因如此它不能当主判据，
		 * 只能用于"id 抖动归并"和"无证据时的兜底"，见 comparePortraits 的注释。
		 *
		 * @param {string} text 已归一化或未归一化的文本
		 * @param {object} [options]
		 * @returns {Set<string>}
		 */
		function tokensOf(text, options) {
			const normalized = normalizeClaim(text, options);
			const set = new Set();
			const cjkRuns = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g) || [];
			for (const run of cjkRuns) {
				if (run.length === 1) {
					set.add(run);
					continue;
				}
				for (let i = 0; i + 1 < run.length; i += 1) set.add(run.slice(i, i + 2));
			}
			const words = normalized.match(/[a-z0-9][a-z0-9+#._-]*/g) || [];
			for (const word of words) {
				if (word.length > 1) set.add(word);
			}
			return set;
		}

		/**
		 * 集合 Jaccard 相似度。两边都空视为相同（都是空 claim）。
		 * @param {Set<string>} a
		 * @param {Set<string>} b
		 * @returns {number} 0..1
		 */
		function jaccard(a, b) {
			if (a.size === 0 && b.size === 0) return 1;
			if (a.size === 0 || b.size === 0) return 0;
			const small = a.size <= b.size ? a : b;
			const large = a.size <= b.size ? b : a;
			let intersection = 0;
			for (const token of small) if (large.has(token)) intersection += 1;
			return intersection / (a.size + b.size - intersection);
		}

		/**
		 * 两条 claim 的文本相似度（0..1）。用于兜底判据，**不用于主判据**。
		 * @param {string} left
		 * @param {string} right
		 * @param {object} [options]
		 * @returns {number}
		 */
		function claimSimilarity(left, right, options) {
			return jaccard(tokensOf(left, options), tokensOf(right, options));
		}

		/**
		 * 一组条目的整体 token 集合（顺序无关、去重）。
		 * @param {Array<{claim?:string}>} entries
		 * @param {object} [options]
		 * @returns {Set<string>}
		 */
		function collectionTokens(entries, options) {
			const set = new Set();
			for (const entry of entries || []) {
				for (const token of tokensOf(entry && entry.claim, options)) set.add(token);
			}
			return set;
		}

		/**
		 * 两个证据集合是否"没变"。
		 *
		 * 证据元素是模型给的原文片段或发言编号，逐字照抄时完全一致；
		 * 只要多一条、少一条、或换了一条引用，Jaccard 就会明显掉下来。
		 * 这是本实现的主判据来源。
		 *
		 * @param {string[]|undefined} before
		 * @param {string[]|undefined} after
		 * @param {object} [options]
		 * @returns {boolean}
		 */
		function evidenceUnchanged(before, after, options) {
			const opts = options || COMPARE_DEFAULTS;
			const a = Array.isArray(before) ? before : [];
			const b = Array.isArray(after) ? after : [];
			if (a.length === 0 && b.length === 0) return true;
			if (a.length === 0 || b.length === 0) return false;
			const setA = new Set(a.map(value => String(value).trim()));
			const setB = new Set(b.map(value => String(value).trim()));
			return jaccard(setA, setB) >= opts.evidenceSameFloor;
		}

		/**
		 * 两边**都**有可比证据吗？
		 *
		 * 这个区分很关键：`evidenceUnchanged([], [])` 返回 true，但那是
		 * "**不知道**证据有没有变"，不是"证据没变"。前者要退到文本兜底，
		 * 后者必须直接判定"只是换了措辞"。
		 *
		 * @param {string[]|undefined} before
		 * @param {string[]|undefined} after
		 * @returns {boolean}
		 */
		function evidenceComparable(before, after) {
			return (
				Array.isArray(before) &&
				before.length > 0 &&
				Array.isArray(after) &&
				after.length > 0
			);
		}

		/**
		 * 从宿主的 `renderProfileText()` 输出里把条目解析回来。
		 *
		 * 用途：兼容"基线只有纯文本快照"的情形（宿主已有字段只有
		 * `copiedSnapshot.text`）。格式是固定的：
		 *     【稳定特质】
		 *     - 条目一
		 *     - 条目二
		 *
		 * @param {string} text
		 * @returns {Array<{category:string, claim:string, evidence:null}>}
		 */
		function parseRenderedProfileText(text) {
			const raw = String(text == null ? "" : text);
			if (!raw.trim()) return [];
			const titleToCategory = new Map();
			for (const key of Object.keys(CATEGORY_TITLES)) {
				titleToCategory.set(CATEGORY_TITLES[key], key);
			}
			const entries = [];
			let current = null;
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				const heading = trimmed.match(/^【(.+?)】$/);
				if (heading) {
					const title = heading[1].trim();
					let category = titleToCategory.get(title);
					if (!category) {
						// 「证据不足（不下结论）」这类带括注的标题
						for (const [known, key] of titleToCategory) {
							if (title.startsWith(known)) {
								category = key;
								break;
							}
						}
					}
					current = category || null;
					continue;
				}
				const bullet = trimmed.match(/^[-*·]\s+(.*)$/);
				if (!bullet) continue;
				const claim = bullet[1].trim();
				if (!claim) continue;
				entries.push({ id: null, category: current || "", claim, evidence: null });
			}
			return entries;
		}

		/**
		 * 把画像条目按宿主 `renderProfileText()` 的格式序列化，作为
		 * `effectiveText` 拿不到时的兜底（也能被 parseRenderedProfileText 解析回来）。
		 * @param {Array<{category:string, claim:string}>} entries
		 * @returns {string}
		 */
		function serializePortrait(entries) {
			const list = (entries || []).filter(entry => entry && entry.claim);
			if (list.length === 0) return "";
			const lines = ["以下是这个用户已经确认的协作画像，请在本次会话中遵守：", ""];
			for (const category of ["A", "B", "C", "D"]) {
				const group = list.filter(entry => entry.category === category);
				if (group.length === 0) continue;
				lines.push("【" + (CATEGORY_TITLES[category] || category) + "】");
				for (const entry of group) lines.push("- " + entry.claim);
				lines.push("");
			}
			return lines.join("\n").trimEnd();
		}

		/**
		 * 把"删掉的条目"和"新增的条目"配对：如果一条删除和一条新增的 claim
		 * 几乎逐字相同，那只是 id 抖了，**不是一次内容修订**。
		 *
		 * @param {Array} removed
		 * @param {Array} added
		 * @param {object} opts
		 * @returns {{removed:Array, added:Array, renames:number}}
		 */
		function reconcileIdChurn(removed, added, opts) {
			const remainingRemoved = removed.slice();
			const remainingAdded = [];
			let renames = 0;
			for (const candidate of added) {
				let bestIndex = -1;
				let bestScore = 0;
				for (let i = 0; i < remainingRemoved.length; i += 1) {
					const score = claimSimilarity(remainingRemoved[i].claim, candidate.claim, opts);
					if (score > bestScore) {
						bestScore = score;
						bestIndex = i;
					}
				}
				if (bestIndex >= 0 && bestScore >= opts.idChurnMatchFloor) {
					remainingRemoved.splice(bestIndex, 1);
					renames += 1;
					continue;
				}
				remainingAdded.push(candidate);
			}
			return { removed: remainingRemoved, added: remainingAdded, renames };
		}

		/**
		 * 核心：比较"上次复制时的快照"与"当前画像"，数出**有依据的**修订处数。
		 *
		 * 返回的 count 一律偏小 —— 这是设计目标，不是缺陷。见文件头注释。
		 *
		 * @param {object} input
		 * @param {Array|null} input.baseline 基线条目（含 id/claim/evidence）
		 * @param {Array|null} input.current 当前条目
		 * @param {number|null|undefined} input.baselineAlgorithmVersion 基线记录的算法版本
		 * @param {boolean} [input.baselineIsTextOnly] 基线只有文本（没有结构化条目）
		 * @param {object} [input.options]
		 * @returns {object} 修订报告
		 */
		function comparePortraits(input) {
			const opts = Object.assign({}, COMPARE_DEFAULTS, input.options || {});
			const report = {
				algorithmVersion: ALGORITHM_VERSION,
				status: "unknown",
				count: 0,
				added: [],
				removed: [],
				modified: [],
				renames: 0,
				globalSimilarity: null,
				baselineSize: 0,
				currentSize: 0,
				lowConfidence: false,
			};

			const baseline = Array.isArray(input.baseline) ? input.baseline : null;
			const current = Array.isArray(input.current) ? input.current : [];

			if (!baseline || baseline.length === 0) {
				report.status = "no-baseline";
				return report;
			}
			report.baselineSize = baseline.length;
			report.currentSize = current.length;

			if (
				input.baselineAlgorithmVersion != null &&
				String(input.baselineAlgorithmVersion) !== String(ALGORITHM_VERSION)
			) {
				report.status = "stale-baseline";
				return report;
			}

			// 当前画像为空：可能是还没生成过。不报修订，避免"删除 N 条"的噪音。
			if (current.length === 0) {
				report.status = "empty-current";
				return report;
			}

			// —— 闸门 1：整体闸门 ——
			const globalSimilarity = jaccard(
				collectionTokens(baseline, opts),
				collectionTokens(current, opts),
			);
			report.globalSimilarity = globalSimilarity;
			if (globalSimilarity >= opts.globalSimilarityFloor) {
				report.status = "unchanged";
				return report;
			}

			// —— 闸门 2：基线只有纯文本 ——
			// 中文同义改写用文本相似度判不出来（实测 ≈0.07），
			// 硬报出来的数字基本都是假的。所以这里**不猜**。
			if (input.baselineIsTextOnly) {
				report.status = "low-confidence";
				report.lowConfidence = true;
				return report;
			}

			const baselineById = new Map();
			for (const entry of baseline) {
				if (entry && entry.id) baselineById.set(String(entry.id), entry);
			}
			const currentById = new Map();
			for (const entry of current) {
				if (entry && entry.id) currentById.set(String(entry.id), entry);
			}

			const added = [];
			const removed = [];
			const modified = [];
			const canMatchById = baselineById.size > 0 && currentById.size > 0;

			if (canMatchById) {
				for (const entry of current) {
					const key = entry && entry.id ? String(entry.id) : "";
					const before = key ? baselineById.get(key) : undefined;
					if (!before) {
						added.push(entry);
						continue;
					}
					const claimChanged = String(before.claim || "") !== String(entry.claim || "");
					if (!claimChanged) continue; // 逐字未变 → 不是修订
					const categoryChanged =
						String(before.category || "") !== String(entry.category || "");
					if (categoryChanged) {
						modified.push({ before, after: entry, reason: "category" });
						continue;
					}
					// 主判据：两边都有可比证据时，**只**看证据集合。
					// 证据逐字一致 → 判定"只是换了措辞"，直接用文本翻案的机会都不给。
					// 这正是压制那 26.3% 假变化的那一刀。
					if (evidenceComparable(before.evidence, entry.evidence)) {
						if (!evidenceUnchanged(before.evidence, entry.evidence, opts)) {
							modified.push({ before, after: entry, reason: "evidence" });
						}
						continue;
					}
					// 证据不可比（两边都没有/缺一边）：这时才退到文本相似度，
					// 且阈值压得极低 —— 只有几乎完全不同的文本才翻案（宁可漏报）。
					const similarity = claimSimilarity(before.claim, entry.claim, opts);
					if (similarity < opts.noEvidenceRewordFloor) {
						modified.push({ before, after: entry, reason: "text", similarity });
					}
				}
				for (const entry of baseline) {
					const key = entry && entry.id ? String(entry.id) : "";
					if (!key || !currentById.has(key)) removed.push(entry);
				}
			} else {
				// 没有 id 可用：贪心按相似度配对。只在这里用文本相似度当身份判据，
				// 且门槛较高（配不上就当增/删），因为配错的代价是把"改写"算成"增+删"。
				const pairs = [];
				for (let i = 0; i < baseline.length; i += 1) {
					for (let j = 0; j < current.length; j += 1) {
						const score = claimSimilarity(baseline[i].claim, current[j].claim, opts);
						if (score >= opts.textOnlyMatchFloor) pairs.push({ i, j, score });
					}
				}
				pairs.sort((a, b) => b.score - a.score);
				const usedBaseline = new Set();
				const usedCurrent = new Set();
				for (const pair of pairs) {
					if (usedBaseline.has(pair.i) || usedCurrent.has(pair.j)) continue;
					usedBaseline.add(pair.i);
					usedCurrent.add(pair.j);
				}
				for (let j = 0; j < current.length; j += 1) {
					if (!usedCurrent.has(j)) added.push(current[j]);
				}
				for (let i = 0; i < baseline.length; i += 1) {
					if (!usedBaseline.has(i)) removed.push(baseline[i]);
				}
			}

			const reconciled = reconcileIdChurn(removed, added, opts);
			report.added = reconciled.added;
			report.removed = reconciled.removed;
			report.modified = modified;
			report.renames = reconciled.renames;
			report.count = report.added.length + report.removed.length + report.modified.length;
			report.status = report.count === 0 ? "unchanged" : "changed";
			return report;
		}

		// ====================================================================
		// 宿主通信
		// ====================================================================

		/**
		 * 解析 API 基地址。
		 *
		 * 默认是同源相对路径，Web 形态下正确。桌面端（Electron 壳）页面来自
		 * `dsh-app://app/`，同源相对路径打不到宿主的 webServer —— 那种部署下
		 * 宿主半应通过 `webserver/index-inject` 注入
		 * `globalThis.__DSH_PROMPT_ADAPT__ = { apiBase: 'http://127.0.0.1:<port>/dsh-prompt-adapt/api' }`。
		 * 这里每次调用都重新读，所以注入晚到也能生效。
		 *
		 * @returns {string}
		 */
		function resolveApiBase() {
			const injected = globalThis.__DSH_PROMPT_ADAPT__;
			if (injected && typeof injected.apiBase === "string" && injected.apiBase) {
				return injected.apiBase.replace(/\/+$/, "");
			}
			return API_PATH;
		}

		/**
		 * 这些主机名是 RFC 2606 / RFC 6761 保留给"永远不解析"的占位域。
		 * 宿主当前就把提示词大厅的地址写成
		 * `PROMPT_HALL_URL = 'https://example.invalid/prompt-hall'` ——
		 * 那是**占位符**，点了必然打不开。所以按"未配置"处理，
		 * 不给用户一个死链。（要改真实地址就改这里或宿主常量。）
		 */
		const PLACEHOLDER_HOSTS = ["invalid", "test", "example"];

		/**
		 * 判断一个地址是不是占位符。
		 * @param {string} url
		 * @returns {boolean}
		 */
		function isPlaceholderUrl(url) {
			let host = "";
			try {
				host = new URL(url).hostname.toLowerCase();
			} catch (error) {
				return true; // 连 URL 都解析不了 → 当未配置
			}
			if (!host) return true;
			for (const candidate of PLACEHOLDER_HOSTS) {
				if (host === candidate || host.endsWith("." + candidate)) return true;
			}
			return false;
		}

		/**
		 * 解析提示词大厅的外链。
		 *
		 * 三层来源，先到先用：注入的全局 → 宿主 state → 常量。
		 * 宿主字段名同时接受 `hallUrl` 与 `promptHallUrl`
		 * （后者对应宿主的 `service.getPromptHallUrl()`，见契约第三节）。
		 * 都没有、或是占位符时返回空串，界面显示"尚未配置"而不是编一个地址。
		 *
		 * @param {object|null} state
		 * @returns {string}
		 */
		function resolveHallUrl(state) {
			const injected = globalThis.__DSH_PROMPT_ADAPT__;
			const candidates = [];
			if (injected && typeof injected.hallUrl === "string") candidates.push(injected.hallUrl);
			if (state && typeof state.hallUrl === "string") candidates.push(state.hallUrl);
			if (state && typeof state.promptHallUrl === "string") candidates.push(state.promptHallUrl);
			for (const candidate of candidates) {
				const value = candidate.trim();
				if (!value) continue;
				if (isPlaceholderUrl(value)) continue;
				return value;
			}
			return "";
		}

		/**
		 * 一次 JSON 请求。
		 * @param {string} path 相对 API 基路径
		 * @param {object} [init] fetch init
		 * @returns {Promise<object>}
		 */
		async function requestJson(path, init) {
			const url = resolveApiBase() + path;
			const options = Object.assign({ headers: {} }, init || {});
			if (options.body !== undefined && options.body !== null) {
				options.headers = Object.assign(
					{ "Content-Type": "application/json" },
					options.headers,
				);
				options.body = JSON.stringify(options.body);
			}
			const response = await fetch(url, options);
			const text = await response.text();
			let payload = null;
			if (text) {
				try {
					payload = JSON.parse(text);
				} catch (error) {
					throw new Error("HTTP " + response.status + " 非 JSON 响应：" + text.slice(0, 120));
				}
			}
			if (!response.ok) {
				const message =
					(payload && (payload.error || payload.message)) || "HTTP " + response.status;
				throw new Error(String(message));
			}
			return payload || {};
		}

		// ====================================================================
		// 预览数据（仅在读取宿主失败后由用户显式点击才载入）
		//
		// 刻意设计成能演示比较策略：4 处"文本上看得出不一样"的地方里，
		// 只有 2 处会被算成修订 —— 另外 2 处是"同 id 同证据、只换措辞"。
		// ====================================================================

		function buildPreviewState() {
			const baselineEntries = [
				{
					id: "a1",
					category: "A",
					claim: "用户偏好简短、直达结论的回答，不喜欢铺垫。",
					evidence: ["[12] 直接说结论就行", "[48] 别写那么多"],
					confidence: "high",
					evidenceQuoteCount: 2,
					lastEvidenceMessages: 96,
				},
				{
					id: "b1",
					category: "B",
					claim: "不要在没有确认的情况下动别人的文件。",
					evidence: ["[77] 谁让你改这个的"],
					confidence: "high",
					evidenceQuoteCount: 1,
					lastEvidenceMessages: 96,
				},
				{
					id: "c1",
					category: "C",
					claim: "先给出最小可验证的一步，再展开。",
					evidence: ["[101] 这样挺好"],
					confidence: "medium",
					evidenceQuoteCount: 1,
					lastEvidenceMessages: 96,
				},
			];
			const currentEntries = [
				// 逐字未变 → 0 处
				{
					id: "a1",
					category: "A",
					claim: "用户偏好简短、直达结论的回答，不喜欢铺垫。",
					evidence: ["[12] 直接说结论就行", "[48] 别写那么多"],
					confidence: "high",
					evidenceQuoteCount: 2,
					lastEvidenceMessages: 96,
				},
				// 同 id、同证据、只换了措辞 → 0 处（这就是要压掉的那 26.3%）
				{
					id: "b1",
					category: "B",
					claim: "改动他人文件之前必须先征求同意。",
					evidence: ["[77] 谁让你改这个的"],
					confidence: "high",
					evidenceQuoteCount: 1,
					lastEvidenceMessages: 96,
				},
				// 同 id、证据集合变了 → 1 处（改写）
				{
					id: "c1",
					category: "C",
					claim: "先给出最小可验证的一步，再展开；改完要自己验一遍。",
					evidence: ["[101] 这样挺好", "[133] 你自己跑过了吗"],
					confidence: "high",
					evidenceQuoteCount: 2,
					lastEvidenceMessages: 148,
				},
				// 新 id → 1 处（新增）
				{
					id: "n1",
					category: "A",
					claim: "用户使用中文交流，技术术语保留英文原文。",
					evidence: ["[140] 这个 tool call 是啥"],
					confidence: "medium",
					evidenceQuoteCount: 1,
					lastEvidenceMessages: 148,
				},
			];
			return {
				ok: true,
				contract: 1,
				preview: true,
				mode: "auto",
				customText: "",
				autoExtraText: "",
				hallUrl: "",
				profile: {
					version: 7,
					generatedAt: Date.now() - 3600 * 1000,
					provider: "preview",
					model: "preview",
					evidenceMessages: 148,
					notes: "预览数据：B 类那条只是换了措辞，按设计不计入修订。",
					raw: "",
					entries: currentEntries,
				},
				copiedSnapshot: {
					text: null,
					at: Date.now() - 7200 * 1000,
					profileVersion: 6,
					entries: baselineEntries,
					algorithmVersion: ALGORITHM_VERSION,
				},
				lastGeneration: { at: Date.now() - 3600 * 1000, humanMessages: 148, sessions: 9 },
				lastSignals: {
					totals: {
						sessions: 9,
						humanMessages: 148,
						delegateRuns: 3,
						longTools: 5,
						repeatFailures: 2,
						freeformAnswers: 4,
						unpairedToolResults: 1,
					},
				},
				lastRun: {
					at: Date.now() - 3600 * 1000,
					ok: true,
					reason: "新增真人发言 20 >= 12",
					error: null,
					spuriousRate: 0.05,
					diff: null,
				},
				running: false,
				effectiveText: "",
			};
		}

		// ====================================================================
		// 客户端 store
		// ====================================================================

		/**
		 * 读取本地基线快照。localStorage 不可用时静默降级。
		 * @returns {object|null}
		 */
		function readLocalSnapshot() {
			try {
				const raw = globalThis.localStorage && globalThis.localStorage.getItem(LOCAL_SNAPSHOT_KEY);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return null;
				return parsed;
			} catch (error) {
				return null;
			}
		}

		/**
		 * 写入本地基线快照。
		 * @param {object} snapshot
		 */
		function writeLocalSnapshot(snapshot) {
			try {
				if (globalThis.localStorage) {
					globalThis.localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
				}
			} catch (error) {
				/* 隐私模式/配额满：只是少了本地基线，不影响其它功能 */
			}
		}

		/**
		 * 轮询间隔（毫秒）。
		 *
		 * 可以被 `globalThis.__DSH_PROMPT_ADAPT__.pollMs` 覆盖：
		 * 一是给自检用（把 3s 压到几十毫秒），二是宿主若有别的节奏偏好也能调。
		 * 每次开始观察时重新读，所以晚注入也生效。
		 * @returns {number}
		 */
		function resolvePollMs() {
			const injected = globalThis.__DSH_PROMPT_ADAPT__;
			const value = injected && Number(injected.pollMs);
			if (Number.isFinite(value) && value >= 10) return value;
			return 3000;
		}

		/**
		 * 一次生成最多观察多少个 tick。
		 * 宿主 `profile.timeoutMs` 默认 300000（5 分钟），3s × 100 = 5 分钟，对齐。
		 */
		const MAX_WATCH_TICKS = 100;

		/**
		 * 建立 store。返回 getSnapshot/subscribe 对（喂给 slots 的 hooks 座位）
		 * 以及界面要用的动作。
		 *
		 * 硬约束：`getSnapshot()` 必须在两次变更之间返回**同一个引用**
		 * （uSES 契约，见 @deepseek-ai/dsh-client-ui-slots 的 HostObservable）。
		 *
		 * @param {object} ctx 客户端 cordis 上下文
		 * @returns {object}
		 */
		function createAdaptStore(ctx) {
			let snapshot = {
				phase: "loading",
				error: null,
				endpoint: "",
				preview: false,
				contract: null,
				localeRevision: 0,
				state: null,
				revision: {
					algorithmVersion: ALGORITHM_VERSION,
					status: "unknown",
					count: 0,
					lowConfidence: false,
				},
				busy: false,
				regenerating: false,
				flash: null,
			};
			const listeners = new Set();
			let pollTimer = null;
			let disposed = false;

			/**
			 * "生成进行中"的观察者。
			 *
			 * 为什么需要它：宿主的 `POST /regenerate` 立刻回 202 并在后台跑
			 * （`lib/http.js:252-270`），而 `getState()` **没有** `running` 字段
			 * （`lib/index.js:129-130` 的 `validate()` 只要求 6 个方法）。
			 * 所以只发一次请求 + 刷一次状态的话，用户点了「重新生成」以后
			 * 界面不会自己变 —— 得手动刷新页面。这里补上有限期的轮询。
			 *
			 * 完成判据：`profile.version` / `profile.generatedAt` / `lastRun.at`
			 * 任一变化。**但至少要看满 2 个 tick** —— 万一宿主在生成**开始时**
			 * 就写了 `lastRun.at`，第 1 个 tick 就会看到"变化"而提前收工。
			 * 上限 `MAX_WATCH_TICKS`，到点无论如何停止（不会无限轮询）。
			 *
			 * 如果宿主以后补上 `running` 字段，这里也会尊重它：
			 * `running === false` 且我们已经看过 `true` → 立刻收工。
			 * @type {{baseRunAt:number, baseVersion:number, baseGeneratedAt:number, ticks:number, sawRunning:boolean}|null}
			 */
			let watcher = null;

			function emit(patch) {
				snapshot = Object.assign({}, snapshot, patch);
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						/* 一个订阅者炸了不能拖垮其余订阅者 */
					}
				}
			}

			/**
			 * 用当前 state + 基线重算修订报告。
			 * @param {object|null} state
			 * @param {boolean} preview
			 * @returns {object}
			 */
			function computeRevision(state, preview) {
				const profile = state && state.profile ? state.profile : null;
				const currentEntries = profile && Array.isArray(profile.entries) ? profile.entries : [];
				const hostSnapshot = (state && state.copiedSnapshot) || null;

				// 优先级：本地结构化基线 → 宿主结构化基线 → 宿主纯文本基线。
				// 本地优先是因为"复制"这个动作就发生在这个浏览器里。
				let baseline = null;
				let baselineAlgorithmVersion = null;
				let baselineIsTextOnly = false;

				const local = readLocalSnapshot();
				if (local && Array.isArray(local.entries) && local.entries.length > 0) {
					baseline = local.entries;
					baselineAlgorithmVersion = local.algorithmVersion;
				} else if (
					hostSnapshot &&
					Array.isArray(hostSnapshot.entries) &&
					hostSnapshot.entries.length > 0
				) {
					baseline = hostSnapshot.entries;
					baselineAlgorithmVersion = hostSnapshot.algorithmVersion;
				} else {
					const text =
						(local && typeof local.text === "string" && local.text) ||
						(hostSnapshot && typeof hostSnapshot.text === "string" && hostSnapshot.text) ||
						"";
					if (text) {
						const parsed = parseRenderedProfileText(text);
						if (parsed.length > 0) {
							baseline = parsed;
							baselineIsTextOnly = true;
							baselineAlgorithmVersion =
								(local && local.algorithmVersion) || hostSnapshot.algorithmVersion || null;
						}
					}
				}

				const report = comparePortraits({
					baseline,
					current: currentEntries,
					baselineAlgorithmVersion,
					baselineIsTextOnly,
				});
				report.preview = !!preview;
				report.baselineAt =
					(local && local.at) || (hostSnapshot && hostSnapshot.at) || null;
				report.baselineProfileVersion =
					(local && local.profileVersion) ||
					(hostSnapshot && hostSnapshot.profileVersion) ||
					null;
				return report;
			}

			/**
			 * 拉取宿主状态并刷新快照。
			 * @returns {Promise<void>}
			 */
			async function refresh() {
				if (disposed) return;
				const url = resolveApiBase() + "/state";
				emit({ phase: snapshot.state ? snapshot.phase : "loading", endpoint: url });
				try {
					const payload = await requestJson("/state");
					if (disposed) return;
					const revision = computeRevision(payload, false);
					const hostRunning = !!(payload && payload.running);

					// 判定"生成是否还在进行"
					let regenerating = snapshot.regenerating;
					if (watcher) {
						watcher.ticks += 1;
						if (hostRunning) watcher.sawRunning = true;
						const runAt = (payload && payload.lastRun && payload.lastRun.at) || 0;
						const version = (payload && payload.profile && payload.profile.version) || 0;
						const generatedAt =
							(payload && payload.profile && payload.profile.generatedAt) || 0;
						const markerChanged =
							runAt !== watcher.baseRunAt ||
							version !== watcher.baseVersion ||
							generatedAt !== watcher.baseGeneratedAt;
						const hostSaysDone = watcher.sawRunning && !hostRunning;
						const finished =
							hostSaysDone ||
							(markerChanged && watcher.ticks >= 2) ||
							watcher.ticks >= MAX_WATCH_TICKS;
						if (finished) {
							watcher = null;
							regenerating = false;
						} else {
							regenerating = true;
						}
					} else if (hostRunning) {
						regenerating = true;
					} else {
						regenerating = false;
					}

					emit({
						phase: "ready",
						error: null,
						preview: false,
						contract: typeof payload.contract === "number" ? payload.contract : null,
						state: payload,
						revision,
						regenerating,
					});
					if (watcher || hostRunning) startPolling();
					else stopPolling();
				} catch (error) {
					if (disposed) return;
					emit({
						phase: "error",
						error: (error && error.message) || String(error),
						endpoint: url,
						busy: false,
					});
					// 读不到状态时不要把观察者也留着：否则会一直空轮询一个坏端点
					watcher = null;
					emit({ regenerating: false });
					stopPolling();
				}
			}

			/** 轮询：只在有观察者、或宿主报告 `running: true` 时跑。 */
			function startPolling() {
				if (pollTimer !== null || disposed) return;
				pollTimer = setInterval(() => {
					refresh().catch(() => {});
				}, resolvePollMs());
			}

			function stopPolling() {
				if (pollTimer === null) return;
				clearInterval(pollTimer);
				pollTimer = null;
			}

			/**
			 * 切换模式。模式 2 有内容时的提醒由界面负责，这里只发请求。
			 * @param {"auto"|"custom"} mode
			 * @returns {Promise<void>}
			 */
			async function setMode(mode) {
				emit({ busy: true });
				try {
					await requestJson("/mode", { method: "POST", body: { mode } });
					await refresh();
					emit({ flash: { kind: "ok", text: "mode:" + mode } });
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 保存模式 2 的文本。
			 * @param {string} text
			 * @returns {Promise<boolean>} 是否真的写进了宿主（失败时界面要保留脏标记）
			 */
			async function saveCustom(text) {
				emit({ busy: true });
				try {
					await requestJson("/custom", { method: "PUT", body: { text: String(text || "") } });
					await refresh();
					emit({ flash: { kind: "ok", text: "saved" } });
					return true;
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
					return false;
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 给一条画像条目打处置标记 / 撤销标记。
			 *
			 * ⚠️ **一律发到宿主、改完重新拉 `/state`**（`refresh()`），绝不只改本地状态：
			 * 只改本地会出现"界面删了但注入还在" —— 而注入才是真正生效的那一半。
			 * 宿主的处理见 `lib/http.js` 的 `/entry/*` 与 `lib/index.js` 的 markEntry。
			 *
			 * @param {"pin"|"unpin"|"seal"|"unseal"|"delete"} action
			 * @param {{id?:string, claim?:string, key?:string}} payload
			 * @returns {Promise<boolean>} 是否真的在宿主上生效
			 */
			async function entryAction(action, payload) {
				emit({ busy: true });
				try {
					await requestJson("/entry/" + action, { method: "POST", body: payload || {} });
					await refresh();
					emit({ flash: { kind: "ok", text: "entry:" + action } });
					return true;
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
					return false;
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 触发一次画像重新生成。
			 *
			 * 宿主立刻回 202 并在后台跑，所以这里发完请求就开始观察
			 * （见 watcher 的注释），而不是等 POST 返回结果。
			 * @returns {Promise<void>}
			 */
			async function regenerate() {
				emit({ busy: true });
				try {
					// 先记下"生成前"的三个水位，用作完成判据
					const before = snapshot.state || {};
					const baseRunAt = (before.lastRun && before.lastRun.at) || 0;
					const baseVersion = (before.profile && before.profile.version) || 0;
					const baseGeneratedAt = (before.profile && before.profile.generatedAt) || 0;

					await requestJson("/regenerate", { method: "POST", body: {} });
					watcher = {
						baseRunAt,
						baseVersion,
						baseGeneratedAt,
						ticks: 0,
						sawRunning: false,
					};
					emit({ regenerating: true });
					await refresh();
				} catch (error) {
					watcher = null;
					emit({
						flash: { kind: "error", text: (error && error.message) || String(error) },
						regenerating: false,
					});
					stopPolling();
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 记录"用户复制了模式 1 的画像"。
			 *
			 * 同时写本地与宿主：
			 *   - 本地：结构化 entries + 算法版本，精确比较靠它；
			 *   - 宿主：沿用已有的 copiedSnapshot 字段，并**建议**宿主一并保存
			 *     entries / algorithmVersion（契约第三节），供其它客户端使用。
			 *
			 * @param {string} text 复制出去的全文
			 * @returns {Promise<void>}
			 */
			async function markCopied(text) {
				const state = snapshot.state || {};
				const profile = state.profile || null;
				const payload = {
					text: String(text || ""),
					at: Date.now(),
					profileVersion: profile && typeof profile.version === "number" ? profile.version : null,
					entries: profile && Array.isArray(profile.entries) ? profile.entries : null,
					algorithmVersion: ALGORITHM_VERSION,
				};
				writeLocalSnapshot(payload);
				const revision = computeRevision(state, snapshot.preview);
				emit({ revision: revision, flash: { kind: "ok", text: "copied" } });
				try {
					await requestJson("/copied", { method: "POST", body: payload });
					await refresh();
				} catch (error) {
					// 宿主没实现 /copied 也不该让"复制"这件事看起来失败：
					// 本地基线已经生效，徽标已经是 0 处。
					emit({ flash: { kind: "ok", text: "copied-local" } });
				}
			}

			/** 载入预览数据（用户显式点击才走这里）。 */
			function loadPreview() {
				const payload = buildPreviewState();
				watcher = null;
				emit({
					phase: "ready",
					error: null,
					preview: true,
					contract: payload.contract,
					state: payload,
					revision: computeRevision(payload, true),
					regenerating: false,
				});
				stopPolling();
			}

			/** 退出预览。 */
			function exitPreview() {
				emit({ preview: false, state: null, phase: "loading" });
				refresh().catch(() => {});
			}

			function dispose() {
				disposed = true;
				watcher = null;
				stopPolling();
				listeners.clear();
			}

			// 语言切换要触发重渲染：把 locale revision 计入快照。
			// （t 本身在调用时读当前语言，这里只负责让组件重跑一次。）
			ctx.effect(
				() => ctx.locale.subscribe(() => emit({ localeRevision: ctx.locale.getSnapshot().revision })),
				"prompt-adapt: locale revision bridge",
			);

			return {
				source: {
					getSnapshot: () => snapshot,
					subscribe: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
				actions: {
					refresh,
					setMode,
					saveCustom,
					regenerate,
					markCopied,
					loadPreview,
					exitPreview,
					/**
					 * 三个处置动作 + 两个撤销动作（界面按钮直接调它们）。
					 * `id`/`claim` = 画像里的那一条；`key` = 标记区里只有记录、
					 * 画像里已经没有的那一条（宿主按 key 找记录）。
					 */
					pinEntry: (id, claim) => entryAction("pin", { id, claim }),
					unpinEntry: key => entryAction("unpin", { key }),
					sealEntry: (id, claim, key) => entryAction("seal", { id, claim, key }),
					unsealEntry: key => entryAction("unseal", { key }),
					deleteEntry: (id, claim, key) => entryAction("delete", { id, claim, key }),
					/**
					 * 界面要写 flash 时用这个（**不是**直接写 `emit(...)`：
					 * `emit` 只在这个闭包里，组件作用域里根本没有这个名字，
					 * 直接写会 ReferenceError）。
					 */
					emit,
					/** 清掉当前 flash。没有它，错误提示会永久挂在页面顶部。 */
					clearFlash: () => {
						if (snapshot.flash) emit({ flash: null });
					},
				},
				dispose,
			};
		}

		// ====================================================================
		// 小工具
		// ====================================================================

		/**
		 * 时间戳 → 本地可读串。
		 * @param {number|string|null} value
		 * @param {string} emptyText
		 * @returns {string}
		 */
		function formatTime(value, emptyText) {
			if (value === null || value === undefined || value === "") return emptyText;
			const date = new Date(typeof value === "number" ? value : Date.parse(value));
			if (Number.isNaN(date.getTime())) return emptyText;
			const pad = number => String(number).padStart(2, "0");
			return (
				date.getFullYear() +
				"-" +
				pad(date.getMonth() + 1) +
				"-" +
				pad(date.getDate()) +
				" " +
				pad(date.getHours()) +
				":" +
				pad(date.getMinutes())
			);
		}

		/**
		 * 复制文本到剪贴板。优先 Clipboard API，失败退回临时 textarea。
		 * @param {string} text
		 * @returns {Promise<boolean>}
		 */
		async function copyToClipboard(text) {
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch (error) {
				/* 退回落旧方案 */
			}
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "readonly");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand && document.execCommand("copy");
				document.body.removeChild(area);
				return !!ok;
			} catch (error) {
				return false;
			}
		}

		// ====================================================================
		// 组件
		// ====================================================================

		/**
		 * 错误 flash 在顶部停留多久（毫秒）。
		 *
		 * store 里**没有任何地方**会把 `flash` 清掉（只有 setMode/saveCustom/
		 * regenerate 在失败时写新的），所以不清就是永久横幅：问题修好了、
		 * 状态刷新成功了，那条红字还在。这里给一个有限期的自动消失。
		 */
		const FLASH_AUTO_DISMISS_MS = 8000;

		/**
		 * 一个证据量徽标行。
		 * @param {object} props
		 * @returns {object}
		 */
		function EvidenceRow(props) {
			const { t, entry } = props;
			const parts = [];
			const basedOn =
				typeof entry.lastEvidenceMessages === "number" ? entry.lastEvidenceMessages : null;
			if (basedOn !== null) parts.push(t("autoEvidence", { n: basedOn }));
			if (typeof entry.evidenceQuoteCount === "number" && entry.evidenceQuoteCount > 0) {
				parts.push(t("autoQuotes", { n: entry.evidenceQuoteCount }));
			}
			if (entry.confidence) {
				const key =
					entry.confidence === "high"
						? "confidenceHigh"
						: entry.confidence === "low"
							? "confidenceLow"
							: "confidenceMedium";
				parts.push(t("autoConfidence", { level: t(key) }));
			}
			return jsx("div", {
				className: "pa_evidenceRow",
				children: parts.map((text, index) => jsx("span", { children: text }, "e" + index)),
			});
		}

		/**
		 * 一条条目旁的处置按钮组（置顶 / 封印 / 删除）。
		 *
		 * ⚠️ 这个组件**不许用 Hook**：`tools/calibrate.mjs` 的 jsx 桩会把函数组件
		 * **就地展开**（直接调用），在那种渲染路径下用 Hook 会踩乱 Hook 游标。
		 * 所有回调与状态都由 `AdaptSection`（真正由迷你 React 渲染的那个）传进来。
		 *
		 * 三个按钮的语义差别就写在 title 里（用户最容易混的就是"删除 vs 封印"）：
		 *   · 置顶 → 界面置顶 + 豁免预算、保证注入（有上限 `maxPinned`）
		 *   · 封印 → 拉进垃圾桶，之后的更新也不许再产出
		 *   · 删除 → 只去掉这一版，下一轮材料有依据时还可能回来
		 *
		 * @param {object} props
		 * @returns {object|null}
		 */
		function EntryActions(props) {
			const { t, entry, mark, busy, pinDisabled, onPin, onUnpin, onSeal, onDelete } = props;
			if (!entry) return null;
			const pinned = !!(mark && mark.status === "pinned");
			// 异常但真的会发生：这条在 entries 里，却带着 sealed 标记（外部手改过
			// state.json、或旧版本留下的画像）。如实打个徽标 —— 用户能看出"它为什么
			// 没进注入"，而不是对着一堆按钮猜。
			const sealed = !!(mark && mark.status === "sealed");
			const maxPinned = props.maxPinned;
			const pinTitle = pinned
				? t("unpinEntry")
				: pinDisabled
					? t("pinEntryLimit", { max: maxPinned })
					: t("pinEntryHint", { max: maxPinned });
			return jsxs("div", {
				className: "pa_entryActions",
				children: [
					pinned
						? jsx("span", {
								className: "pa_badge pa_markTag",
								"data-tone": "business",
								children: t("entryPinnedTag"),
							})
						: null,
					sealed
						? jsx("span", {
								className: "pa_badge pa_markTag",
								"data-tone": "error",
								children: t("entrySealedTag"),
							})
						: null,
					jsx("div", { className: "pa_spacer" }),
					jsx("button", {
						type: "button",
						className: "pa_btn",
						disabled: busy || (pinDisabled && !pinned),
						title: pinTitle,
						onClick: () => {
							if (pinned) onUnpin(mark.key);
							else onPin(entry);
						},
						children: pinned ? t("unpinEntry") : t("pinEntry"),
					}),
					jsx("button", {
						type: "button",
						className: "pa_btn",
						"data-variant": "danger",
						disabled: busy,
						title: t("sealEntryHint"),
						onClick: () => onSeal(entry),
						children: t("sealEntry"),
					}),
					jsx("button", {
						type: "button",
						className: "pa_btn",
						"data-variant": "danger",
						disabled: busy,
						title: t("deleteEntryHint"),
						onClick: () => onDelete(entry),
						children: t("deleteEntry"),
					}),
				],
			});
		}

		/**
		 * 模式 1 的一个分类分组。
		 *
		 * `props.actions` 存在时每条条目多一行处置按钮（置顶 / 封印 / 删除）——
		 * 「完整画像」区用它；折叠区（垃圾桶 / 已删除）传自己的按钮，走 MarkList。
		 *
		 * ⚠️ 与 EntryActions 同理：**不许用 Hook**（calibrate 会就地展开本组件）。
		 *
		 * @param {object} props
		 * @returns {object}
		 */
		function CategoryGroup(props) {
			const { t, category, label, entries } = props;
			if (!entries || entries.length === 0) return null;
			const actions = props.actions || null;
			const counts = props.counts || null;
			return jsxs("div", {
				className: "pa_group",
				children: [
					jsxs("h4", {
						className: "pa_groupTitle",
						children: [
							jsx("span", {
								className: "pa_groupBar",
								"data-tone": CATEGORY_TONE[category] || "toneD",
							}),
							jsx("span", { children: label }),
							jsx("span", {
								className: "pa_meta",
								children: "(" + entries.length + ")",
							}),
						],
					}),
					jsx("ul", {
						className: "pa_list",
						children: entries.map((entry, index) =>
							jsxs(
								"li",
								{
									className: "pa_entry",
									children: [
										jsx("p", { className: "pa_claim", children: entry.claim }),
										counts && entry.id
											? jsx("div", {
													className: "pa_evidenceRow",
													children: jsx("span", {
														className: "pa_badge",
														"data-tone":
															Number(counts[entry.id]) > 0 ? "business" : "warn",
														children:
															Number(counts[entry.id]) > 0
																? t("ledgerSeen", { n: counts[entry.id] })
																: t("ledgerNever"),
													}),
												})
											: null,
										jsx(EvidenceRow, { t, entry }),
										actions
											? jsx(EntryActions, {
													t,
													entry,
													mark: actions.markOf(entry),
													busy: actions.busy,
													pinDisabled: actions.pinDisabled,
													maxPinned: actions.maxPinned,
													onPin: actions.onPin,
													onUnpin: actions.onUnpin,
													onSeal: actions.onSeal,
													onDelete: actions.onDelete,
												})
											: null,
									],
								},
								(entry.id || "entry") + "-" + index,
							),
						),
					}),
				],
			});
		}

		/**
		 * 一组"处置条目"的列表（置顶区与三个折叠区共用）。
		 *
		 * ⚠️ 不许用 Hook（calibrate 会就地展开本组件）。
		 *
		 * @param {object} props
		 * @returns {object|null}
		 */
		function MarkList(props) {
			const { t, items } = props;
			if (!items || items.length === 0) return null;
			return jsx("ul", {
				className: "pa_list",
				children: items.map((item, index) =>
					jsxs(
						"li",
						{
							className: "pa_entry",
							children: [
								jsx("p", { className: "pa_claim", children: item.claim }),
								item.meta && item.meta.length > 0
									? jsx("div", {
											className: "pa_evidenceRow",
											children: item.meta.map((text, metaIndex) =>
												jsx("span", { children: text }, "m" + metaIndex),
											),
										})
									: null,
								item.entryObj ? jsx(EvidenceRow, { t, entry: item.entryObj }) : null,
								item.actions || null,
							],
						},
						item.key || "mark-" + index,
					),
				),
			});
		}

		/**
		 * 一个折叠区（④ 未注入 / ⑤ 垃圾桶 / ⑥ 已删除）。
		 *
		 * 复用既有的折叠组件 `pa_details`（`details/summary`），**不新造折叠组件** ——
		 * 项目里已经有 11 处在用它，样式与键盘行为都验过了。默认收起，不占屏幕。
		 *
		 * @param {object} props
		 * @returns {object|null}
		 */
		function MarkFold(props) {
			const { t, heading, hint, items } = props;
			if (!items || items.length === 0) return null;
			return jsxs("details", {
				className: "pa_details",
				children: [
					jsx("summary", { children: heading }),
					jsx("p", { className: "pa_cardHint", children: hint }),
					jsx(MarkList, { t, items }),
				],
			});
		}

		/**
		 * 折叠区里**一条标记**的按钮组（① 置顶 / ⑤ 垃圾桶 / ⑥ 已删除）。
		 *
		 * 与 `EntryActions` 分开是必要的：这些区里的条目**可能已经不在画像里**
		 * （只剩记录），所以动作按标记的 `key` 走，不依赖画像里的 id。
		 *
		 * ⚠️ 同样不许用 Hook。
		 *
		 * @param {object} props
		 * @returns {object}
		 */
		function MarkActions(props) {
			const { t, mark, busy, pinDisabled, maxPinned, onPin, onUnpin, onSeal, onDelete, onUnseal } = props;
			const buttons = [];
			if (mark.status === "pinned") {
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							disabled: busy,
							onClick: () => onUnpin(mark.key),
							children: t("unpinEntry"),
						},
						"unpin",
					),
				);
			}
			if (mark.status === "sealed") {
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							disabled: busy,
							onClick: () => onUnseal(mark.key),
							children: t("unsealEntry"),
						},
						"unseal",
					),
				);
			}
			if (mark.status === "deleted") {
				// 删除区里"升级成封印"是最常用的一步：它老回来，就把它挡住。
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							disabled: busy || pinDisabled,
							title: pinDisabled
								? t("pinEntryLimit", { max: maxPinned })
								: t("pinEntryHint", { max: maxPinned }),
							onClick: () => onPin(mark.key),
							children: t("pinEntry"),
						},
						"pin",
					),
				);
			}
			if (mark.status !== "sealed") {
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							"data-variant": "danger",
							disabled: busy,
							title: t("sealEntryHint"),
							onClick: () => onSeal(mark.key),
							children: t("sealEntry"),
						},
						"seal",
					),
				);
			}
			if (mark.status === "pinned") {
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							"data-variant": "danger",
							disabled: busy,
							title: t("deleteEntryHint"),
							onClick: () => onDelete(mark.key),
							children: t("deleteEntry"),
						},
						"delete",
					),
				);
			}
			return jsxs("div", {
				className: "pa_entryActions",
				children: [jsx("div", { className: "pa_spacer" }), ...buttons],
			});
		}

		/**
		 * 修订提示条。
		 * @param {object} props
		 * @returns {object}
		 */
		function RevisionNotice(props) {
			const { t, revision } = props;
			if (!revision || revision.status === "unknown") return null;
			const count = revision.count || 0;
			let tone = "ok";
			let heading = t("revHeadingClean");
			let hint = t("revHintClean");
			if (revision.status === "no-baseline" || revision.status === "empty-current") {
				tone = "info";
				heading = t("revHeadingUnknown");
				hint = t("revHintUnknown");
			} else if (revision.status === "stale-baseline") {
				tone = "warn";
				heading = t("revHeadingStale");
				hint = t("revHintStale");
			} else if (revision.status === "low-confidence") {
				tone = "warn";
				heading = t("revHeadingLowConfidence");
				hint = t("revHintLowConfidence");
			} else if (count > 0) {
				tone = "warn";
				heading = t("revHeadingDirty", { n: count });
				hint = t("revHintDirty");
			}
			const detail = [];
			for (const entry of revision.added || []) {
				detail.push({ kind: t("revKindAdded"), claim: entry && entry.claim });
			}
			for (const entry of revision.removed || []) {
				detail.push({ kind: t("revKindRemoved"), claim: entry && entry.claim });
			}
			for (const pair of revision.modified || []) {
				detail.push({ kind: t("revKindModified"), claim: pair.after && pair.after.claim });
			}
			const meta = [];
			if (revision.baselineAt) {
				meta.push(t("revBaselineAt", { time: formatTime(revision.baselineAt, "—") }));
			}
			if (typeof revision.baselineProfileVersion === "number") {
				meta.push(t("revBaselineVersion", { v: revision.baselineProfileVersion }));
			}
			if (props.spuriousRate !== null && props.spuriousRate !== undefined) {
				meta.push(
					t("revSpurious", { rate: Math.round(Number(props.spuriousRate) * 1000) / 10 + "%" }),
				);
			}
			return jsxs("div", {
				className: "pa_notice",
				"data-tone": tone,
				children: [
					jsx("p", { className: "pa_noticeTitle", children: heading }),
					jsx("p", { children: hint }),
					meta.length > 0
						? jsx("p", {
								className: "pa_meta",
								children: meta.map((text, index) => jsx("span", { children: text }, "m" + index)),
							})
						: null,
					detail.length > 0
						? jsxs("details", {
								className: "pa_details",
								children: [
									jsx("summary", { children: t("revDetail", { n: detail.length }) }),
									jsx("ul", {
										className: "pa_list",
										children: detail.map((item, index) =>
											jsxs(
												"li",
												{
													className: "pa_entry",
													children: [
														jsxs("div", {
															className: "pa_evidenceRow",
															children: [
																jsx("span", {
																	className: "pa_badge",
																	"data-tone": "business",
																	children: item.kind,
																}),
															],
														}),
														jsx("p", { className: "pa_claim", children: item.claim }),
													],
												},
												"d" + index,
											),
										),
									}),
								],
							})
						: null,
				],
			});
		}

		/**
		 * 四个计数信号。
		 * @param {object} props
		 * @returns {object}
		 */
		function SignalGrid(props) {
			const { t, signals } = props;
			const totals = signals && signals.totals ? signals.totals : null;
			if (!totals) return null;
			const cells = [
				{ key: "sessions", label: t("signalSessions"), value: totals.sessions },
				{ key: "humanMessages", label: t("signalHuman"), value: totals.humanMessages },
				{ key: "delegateRuns", label: t("signalDelegate"), value: totals.delegateRuns },
				{ key: "longTools", label: t("signalLongTool"), value: totals.longTools },
				{ key: "repeatFailures", label: t("signalRepeatFail"), value: totals.repeatFailures },
				{ key: "freeformAnswers", label: t("signalFreeform"), value: totals.freeformAnswers },
			];
			return jsxs("div", {
				className: "pa_card",
				children: [
					jsx("p", { className: "pa_cardHint", children: t("signalHint") }),
					jsx("div", {
						className: "pa_signals",
						children: cells.map(cell =>
							jsxs(
								"div",
								{
									className: "pa_signal",
									children: [
										jsx("span", {
											className: "pa_signalValue",
											children: typeof cell.value === "number" ? String(cell.value) : "—",
										}),
										jsx("span", { className: "pa_signalLabel", children: cell.label }),
									],
								},
								cell.key,
							),
						),
					}),
					totals.unpairedToolResults > 0
						? jsx("p", {
								className: "pa_meta",
								children: t("signalUnpaired", { n: totals.unpairedToolResults }),
							})
						: null,
				],
			});
		}

		/**
		 * 设置页主体。
		 *
		 * props 由框架组合而成：`close` 来自 settings.section 的 owner props，
		 * `t` / `actions` / `useAdapt` 来自本插件的 inject 面。
		 *
		 * @param {object} props
		 * @returns {object}
		 */
		function AdaptSection(props) {
			const t = props.t;
			const actions = props.actions;
			const snap = props.useAdapt(value => value);
			const serverState = snap.state || {};
			const status = snap.phase;

			const [draft, setDraft] = react.useState("");
			const [draftTouched, setDraftTouched] = react.useState(false);
			const [pendingMode, setPendingMode] = react.useState(null);
			const [fillConfirm, setFillConfirm] = react.useState(false);
			const [copiedFlash, setCopiedFlash] = react.useState(false);
			const [copyError, setCopyError] = react.useState(false);
			const dirtyRef = react.useRef(false);
			const textareaId = react.useId();

			const serverCustomText =
				typeof serverState.customText === "string" ? serverState.customText : "";

			// 宿主值变化时同步草稿——除非用户正在编辑（有未保存修改）。
			react.useEffect(() => {
				if (dirtyRef.current) return;
				setDraft(serverCustomText);
			}, [serverCustomText]);

			react.useEffect(() => {
				if (status === "idle" || (status === "loading" && snap.preview)) return;
				if (status === "ready" || status === "error") actions.refresh();
				// 只在挂载与宿主相位变化时拉一次；轮询由 store 自己管。
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			react.useEffect(() => {
				if (!copiedFlash) return undefined;
				const timer = setTimeout(() => setCopiedFlash(false), 1800);
				return () => clearTimeout(timer);
			}, [copiedFlash]);

			// flash（错误横幅）必须会自己消失。见 FLASH_AUTO_DISMISS_MS 的注释：
			// store 没有任何清它的路径，所以清的责任在界面这边。
			react.useEffect(() => {
				if (!snap.flash) return undefined;
				const timer = setTimeout(() => actions.clearFlash(), FLASH_AUTO_DISMISS_MS);
				return () => clearTimeout(timer);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [snap.flash]);

			const profile = serverState.profile || null;
			// 过滤掉非对象条目：宿主的 profile.entries 是外部数据，
			// 里面混进一个 null 就会在下面 `entry.category` 那里抛 TypeError，
			// 把整个设置页打挂（实测：Cannot read properties of null）。
			const entries =
				profile && Array.isArray(profile.entries)
					? profile.entries.filter(entry => entry && typeof entry === "object")
					: [];
			const mode = serverState.mode === "custom" ? "custom" : "auto";
			const isAuto = mode === "auto";
			const customHasText = serverCustomText.trim().length > 0;
			const hallUrl = resolveHallUrl(serverState);

			// 模式 1 面板上的「复制」与「从模式 1 填入」用的**必须是画像文本本身**。
			//
			// ⚠️ 这里有个坑：宿主的 `effectiveText` 是"当前生效文本"，
			// 模式 2 生效时它等于自定义文本。如果直接用它，「从模式 1 填入」
			// 会把文本框里的内容原样填回文本框。
			// 所以：只有模式 1 生效时 `effectiveText` 才是画像（+补充说明），
			// 否则本地按宿主的 renderProfileText 格式重建画像文本。
			const portraitText =
				isAuto && typeof serverState.effectiveText === "string" && serverState.effectiveText
					? serverState.effectiveText
					: serializePortrait(entries);

			const grouped = {};
			for (const category of CATEGORY_ORDER) grouped[category] = [];
			grouped[CATEGORY_EXTRA] = [];
			for (const entry of entries) {
				const key = CATEGORY_ORDER.indexOf(entry.category) >= 0 ? entry.category : CATEGORY_EXTRA;
				grouped[key].push(entry);
			}

			// —— 实际注入的系统提示（模式 1 卡片最显眼的一块）——
			//
			// ⚠️ 界面**只渲染**宿主的 `injectedText`，绝不自己拼一遍。
			// 宿主那个字段就是 `renderSection()` 注入时用的同一个来源
			// （`store.effectiveForInjection().text` → `renderProfileInjectionText()`），
			// 自己拼就会再次出现"看到的 ≠ 注入的"（注入按预算裁剪，界面显示完整画像）。
			//
			// 条数说明取自宿主的 `injection` 摘要（最多 4 个数字，长文本不在里面）：
			//   · m = 实际进注入的条数 = `injectedEntries`
			//   · n = 完整画像条数 = `profile.entries.length`
			// 摘要缺失或形状不对时（老的宿主、预览数据）退化为"只显示文本、不报条数"。
			const injectedText =
				typeof serverState.injectedText === "string" ? serverState.injectedText : "";
			const injection = serverState.injection;
			const injectedCount =
				injection && typeof injection.injectedEntries === "number"
					? injection.injectedEntries
					: null;
			// 兜底用注释里那行"本次注入 m/n 条"里的 m —— 摘要里的 m 来自另一个
			// 调用点，理论上可能比这段文本晚一步；宁可少报也不要报错。
			const injectedCountFromText = (() => {
				const matched = /本次注入\s*(\d+)\s*\/\s*(\d+)\s*条/.exec(injectedText);
				return matched ? Number(matched[1]) : null;
			})();
			// 两个来源都只作"报数"用；不一致时以文本里那行为准（文本才是注入现场）。
			const injectedShown =
				injectedCountFromText !== null ? injectedCountFromText : injectedCount;
			const totalShown = entries.length;

			// 注入账本（宿主 `injectionLedger`，publicLedger 形状）：按条目 id 记录
			// "进过几版"，跨版本累计。老宿主没有这个字段 → 不加任何徽标，保持原界面。
			const ledger =
				serverState.injectionLedger && typeof serverState.injectionLedger === "object"
					? serverState.injectionLedger
					: null;
			const ledgerCounts =
				ledger && ledger.counts && typeof ledger.counts === "object" ? ledger.counts : null;
			const neverInjectedShown = ledgerCounts
				? entries.filter(entry => !(Number(ledgerCounts[entry.id]) > 0)).length
				: null;
			const ledgerVersion =
				ledger && ledger.version !== null && ledger.version !== undefined
					? ledger.version
					: "—";
			// 工作笔记：项目/工具/路径类事实，独立于画像条目（不占槽位、不注入）。
			const workingNotes = Array.isArray(serverState.workingNotes)
				? serverState.workingNotes.filter(
						note => note && typeof note.text === "string" && note.text.trim(),
					)
				: [];

			// 各分类注入条数：**直接取宿主的 `injection.injectedByCategory`**
			// （形如 `{A:13,B:13,C:0,D:0}`），界面自己**不**做任何计算 ——
			// 界面自己算就会出现"看到的 ≠ 注入的"（模式 1 的注入是宿主按预算
			// 裁剪出来的，界面这边只有完整画像，算不出同一个结果）。
			// 三个数字都必须是 number 才显示；缺一个就整体退化为老的"共 m 条"。
			// D 类按设计永不注入（宿主的 `injectedByCategory.D` 恒为 0），不占位置。
			const injectedByCategory =
				injection && injection.injectedByCategory &&
				typeof injection.injectedByCategory.A === "number" &&
				typeof injection.injectedByCategory.B === "number" &&
				typeof injection.injectedByCategory.C === "number"
					? injection.injectedByCategory
					: null;

			// 分类标题沿用宿主 renderProfileText 用的中文标题（两种界面语言下都一样）：
			// 复制出去的文本必须与注入系统提示的文本一致，也必须能被
			// parseRenderedProfileText 解析回条目，否则"纯文本基线"兜底就失效了。
			const groupLabels = CATEGORY_TITLES;

			// —— 条目处置标记（置顶 / 垃圾桶 / 已删除）——
			//
			// 三种状态由宿主维护在 `state.entryMarks`（**不在 profile 里**：用户的处置
			// 决定要比任何一版画像活得久）。界面这边只做三件事：分区、显示、发请求。
			const marks =
				Array.isArray(serverState.entryMarks)
					? serverState.entryMarks.filter(
							mark => mark && typeof mark === "object" && mark.entry && mark.entry.claim,
						)
					: [];
			const pinnedMarks = marks.filter(mark => mark.status === "pinned");
			const sealedMarks = marks.filter(mark => mark.status === "sealed");
			const deletedMarks = marks.filter(mark => mark.status === "deleted");
			// 真实画像条目 id → 标记：③ 区靠它知道"这条现在是什么状态"（宿主现算的 presentId）。
			const markByPresentId = new Map();
			for (const mark of marks) {
				if (mark.presentId) markByPresentId.set(mark.presentId, mark);
			}
			// 置顶上限由宿主给（`inject.maxPinned`），界面不写死数字。
			const maxPinned = typeof serverState.maxPinned === "number" ? serverState.maxPinned : 10;
			const pinFull = pinnedMarks.length >= maxPinned;
			/** ③ 区那组按钮的状态与回调（都发到宿主，见 store.actions）。 */
			const entryMarkActions = {
				busy: snap.busy,
				pinDisabled: pinFull,
				maxPinned,
				markOf: entry => (entry && entry.id ? markByPresentId.get(entry.id) || null : null),
				onPin: entry => actions.pinEntry(entry.id, entry.claim),
				onUnpin: key => actions.unpinEntry(key),
				onSeal: entry => actions.sealEntry(entry.id, entry.claim),
				onDelete: entry => actions.deleteEntry(entry.id, entry.claim),
			};
			/** 折叠区里按**标记**走的那组动作（条目可能已经不在画像里，只能靠 key）。 */
			const markKeyActions = {
				busy: snap.busy,
				pinDisabled: pinFull,
				maxPinned,
				onPin: key => actions.pinEntry(null, null, key),
				onUnpin: key => actions.unpinEntry(key),
				onSeal: key => actions.sealEntry(null, null, key),
				onUnseal: key => actions.unsealEntry(key),
				onDelete: key => actions.deleteEntry(null, null, key),
			};
			const foldActionsFor = mark =>
				jsx(MarkActions, { t, mark, ...markKeyActions });

			// —— ④ 未注入：完整画像里**被预算裁掉**的条目 ——
			//
			// 差集用**宿主给的** `injection.injectedIds`（就是那次裁剪的结果），
			// 界面**不自己重算**注入取舍 —— 那会退回"看到的 ≠ 注入的"
			// （界面上只有完整画像，算不出宿主按预算裁剪的结果）。
			//
			// ⚠️ 只收 A/B/C 里被裁掉的：证据不足的 D 类（以及分类识别不出的）
			//    **本来就不注入**，它们在 ③ 区自己那个折叠里，收进这里就是同一批条目
			//    在两个折叠里各显示一遍。用户要的是"都能被看到"，不是"看到两遍"。
			// 老宿主 / 预览数据没有 `injectedIds` 时整区不显示（宁可不显示，也不乱报）。
			const injectedIds =
				injection && Array.isArray(injection.injectedIds) ? injection.injectedIds : null;
			const injectedIdSet = injectedIds ? new Set(injectedIds) : null;
			const omittedEntries = injectedIdSet
				? entries.filter(
						entry => CATEGORY_ORDER.indexOf(entry.category) >= 0 && !injectedIdSet.has(entry.id),
					)
				: [];
			/** 折叠区条目的统一形状（`MarkList` / `MarkFold` 只认这个）。 */
			const foldItem = (key, claim, entryObj, meta, actions) => ({
				key,
				claim,
				entryObj,
				meta,
				actions,
			});
			/** ④ 区里那些条目的处置按钮：与 ③ 区同一套动作（就是位置不同）。 */
			const entryActionsFor = entry =>
				jsx(EntryActions, {
					t,
					entry,
					mark: entryMarkActions.markOf(entry),
					busy: snap.busy,
					pinDisabled: pinFull,
					maxPinned,
					onPin: entryMarkActions.onPin,
					onUnpin: entryMarkActions.onUnpin,
					onSeal: entryMarkActions.onSeal,
					onDelete: entryMarkActions.onDelete,
				});
			// —— ① 置顶 / ④ 未注入 / ⑤ 垃圾桶 / ⑥ 已删除 的条目 ——
			// meta 只放**事实**：这条现在还在不在画像里、被删过几次。
			const pinnedItems = pinnedMarks.map(mark =>
				foldItem(
					mark.key,
					mark.entry.claim,
					mark.entry,
					[
						mark.present ? null : t("pinnedGone"),
						mark.deleteCount > 0 ? t("deleteCountBefore", { n: mark.deleteCount }) : null,
					].filter(Boolean),
					foldActionsFor(mark),
				),
			);
			const omittedItems = omittedEntries.map(entry =>
				foldItem(entry.id || entry.claim, entry.claim, entry, [], entryActionsFor(entry)),
			);
			const sealedItems = sealedMarks.map(mark =>
				foldItem(mark.key, mark.entry.claim, mark.entry, [], foldActionsFor(mark)),
			);
			const deletedItems = deletedMarks.map(mark =>
				foldItem(
					mark.key,
					mark.entry.claim,
					mark.entry,
					[
						t("deletedCount", { n: mark.deleteCount > 0 ? mark.deleteCount : 1 }),
						mark.present ? t("deletedBack") : null,
					].filter(Boolean),
					foldActionsFor(mark),
				),
			);

			const onSelectMode = next => {
				if (next === mode) return;
				if (next === "auto" && customHasText) {
					setPendingMode("auto");
					return;
				}
				actions.setMode(next);
			};

			const confirmSwitch = () => {
				setPendingMode(null);
				actions.setMode("auto");
			};

			const onCopy = async () => {
				const text = portraitText;
				// 没有内容不再静默失败：按钮始终可点，点了就说明为什么没得复制。
				if (!text) {
					actions.emit({ flash: { kind: "error", text: t("copyEmpty") } });
					return;
				}
				const ok = await copyToClipboard(text);
				if (!ok) {
					setCopiedFlash(false);
					setCopyError(true);
					return;
				}
				setCopyError(false);
				setCopiedFlash(true);
				await actions.markCopied(text);
			};

			const onFillFromAuto = () => {
				if (!portraitText) {
					actions.emit({ flash: { kind: "error", text: t("copyEmpty") } });
					return;
				}
				if (draft.trim().length > 0) {
					setFillConfirm(true);
					return;
				}
				applyFill();
			};

			const applyFill = () => {
				dirtyRef.current = true;
				setDraftTouched(true);
				setDraft(portraitText);
				setFillConfirm(false);
			};

			const onDraftChange = event => {
				dirtyRef.current = true;
				setDraftTouched(true);
				setDraft(event.target.value);
			};

			const onSaveCustom = async () => {
				dirtyRef.current = false;
				setDraftTouched(false);
				const saved = await actions.saveCustom(draft);
				// 保存失败时恢复脏标记：宿主并没有这段文本，界面不能自称
				// "已与宿主同步"，而且「保存」按钮也不能被永久禁用（否则没法重试）。
				if (!saved) {
					dirtyRef.current = true;
					setDraftTouched(true);
				}
			};

			// —— 断连/预览状态条 ——
			const banners = [];
			if (snap.preview) {
				banners.push(
					jsx(
						"div",
						{
							className: "pa_notice",
							"data-tone": "warn",
							children: jsx("p", { children: t("statusPreview") }),
						},
						"preview",
					),
				);
			}
			if (status === "error" && !snap.preview) {
				banners.push(
					jsxs(
						"div",
						{
							className: "pa_notice",
							"data-tone": "error",
							children: [
								jsx("p", { className: "pa_noticeTitle", children: t("statusDisconnected") }),
								jsx("p", {
									children: t("statusDisconnectedBody", {
										url: snap.endpoint || resolveApiBase() + "/state",
										error: snap.error || "—",
									}),
								}),
								jsxs("div", {
									className: "pa_row",
									children: [
										jsx("button", {
											type: "button",
											className: "pa_btn",
											onClick: () => actions.refresh(),
											children: t("statusRetry"),
										}),
										jsx("button", {
											type: "button",
											className: "pa_btn",
											onClick: () => actions.loadPreview(),
											children: t("statusPreviewOn"),
										}),
									],
								}),
							],
						},
						"error",
					),
				);
			}
			if (snap.flash && snap.flash.kind === "error") {
				banners.push(
					jsxs(
						"div",
						{
							className: "pa_notice",
							"data-tone": "error",
							children: [jsx("p", { children: t("errorPrefix") + snap.flash.text })],
						},
						"flash",
					),
				);
			}
			if (copyError) {
				banners.push(
					jsx(
						"div",
						{
							className: "pa_notice",
							"data-tone": "error",
							children: jsx("p", { children: t("copyFailed") }),
						},
						"copy-error",
					),
				);
			}
			// 生成警告（含换血上限的 capRejected）：宿主写在 lastRun.warnings 里，
			// 之前界面不读，用户看不到"这轮拒绝了几条净新增"。折叠展示，避免长文刷屏。
			const runWarnings =
				serverState.lastRun && Array.isArray(serverState.lastRun.warnings)
					? serverState.lastRun.warnings.filter(
							warning => typeof warning === "string" && warning,
						)
					: [];
			if (runWarnings.length > 0) {
				banners.push(
					jsxs(
						"details",
						{
							className: "pa_notice",
							"data-tone": "warn",
							children: [
								jsx("summary", {
									children: t("genWarnings", { n: runWarnings.length }),
								}),
								jsx("ul", {
									className: "pa_list",
									children: runWarnings.map((warning, index) =>
										jsx("li", { children: warning }, "w" + index),
									),
								}),
							],
						},
						"run-warnings",
					),
				);
			}

			// —— 模式选择器 ——
			const modeCard = jsxs("div", {
				className: "pa_card",
				children: [
					jsxs("div", {
						className: "pa_cardHead",
						children: [
							jsxs("div", {
								className: "pa_seg",
								role: "radiogroup",
								"aria-label": t("modeLegend"),
								children: [
									jsx(
										"button",
										{
											type: "button",
											role: "radio",
											className: "pa_segBtn",
											"data-active": isAuto ? "true" : "false",
											"aria-checked": isAuto,
											onClick: () => onSelectMode("auto"),
											children: t("modeAuto"),
										},
										"auto",
									),
									jsx(
										"button",
										{
											type: "button",
											role: "radio",
											className: "pa_segBtn",
											"data-active": isAuto ? "false" : "true",
											"aria-checked": !isAuto,
											onClick: () => onSelectMode("custom"),
											children: t("modeCustom"),
										},
										"custom",
									),
								],
							}),
							jsx("div", { className: "pa_spacer" }),
							jsxs("div", {
								className: "pa_effective",
								children: [
									jsx("span", { className: "pa_dot" }),
									jsx("span", {
										children: t("effectiveNow", {
											name: isAuto ? t("effectiveAuto") : t("effectiveCustom"),
										}),
									}),
								],
							}),
						],
					}),
					jsx("p", {
						className: "pa_cardHint",
						children: isAuto ? t("modeAutoDesc") : t("modeCustomDesc"),
					}),
					pendingMode === "auto"
						? jsxs("div", {
								className: "pa_notice",
								"data-tone": "warn",
								children: [
									jsx("p", { className: "pa_noticeTitle", children: t("switchWarnTitle") }),
									jsx("p", { children: t("switchWarnBody") }),
									jsxs("div", {
										className: "pa_row",
										children: [
											jsx("button", {
												type: "button",
												className: "pa_btn",
												"data-variant": "primary",
												onClick: confirmSwitch,
												children: t("switchWarnConfirm"),
											}),
											jsx("button", {
												type: "button",
												className: "pa_btn",
												onClick: () => setPendingMode(null),
												children: t("switchWarnCancel"),
											}),
										],
									}),
								],
							})
						: null,
				],
			});

			// —— 模式 1 面板 ——
			const revision = snap.revision || {};
			const autoPanel = jsxs("div", {
				className: "pa_card",
				"data-inactive": isAuto ? "false" : "true",
				children: [
					jsxs("div", {
						className: "pa_cardHead",
						children: [
							jsx("h3", { className: "pa_cardTitle", children: t("autoHeading") }),
							jsxs("span", {
								className: "pa_badge",
								"data-tone": isAuto ? "ok" : "warn",
								children: isAuto ? t("activeTag") : t("inactiveTag"),
							}),
							jsx("div", { className: "pa_spacer" }),
							jsx("button", {
								type: "button",
								className: "pa_btn",
								disabled: snap.busy,
								onClick: onCopy,
								children: copiedFlash ? t("copied") : t("copy"),
							}),
							jsx("button", {
								type: "button",
								className: "pa_btn",
								"data-variant": "primary",
								disabled: snap.busy || snap.regenerating || !!serverState.running,
								onClick: () => actions.regenerate(),
								title: t("regenerateHint"),
								children:
									snap.regenerating || serverState.running
										? t("regenerating")
										: t("regenerate"),
							}),
						],
					}),
					snap.regenerating
						? jsx("div", {
								className: "pa_notice",
								children: jsx("p", { children: t("regeneratingHint") }),
							})
						: null,
					jsxs("p", {
						className: "pa_meta",
						children: [
							jsx("span", {
								children: profile
									? t("autoUpdated", {
											time: formatTime(profile.generatedAt, t("autoNever")),
										})
									: t("autoNever"),
							}),
							profile && typeof profile.version === "number"
								? jsx("span", { children: " · " + t("autoVersion", { v: profile.version }) })
								: null,
							profile && typeof profile.evidenceMessages === "number"
								? jsx("span", {
										children: " · " + t("autoBasedOn", { n: profile.evidenceMessages }),
									})
								: null,
						],
					}),
					jsx(RevisionNotice, { t, revision, spuriousRate: serverState.lastRun && serverState.lastRun.spuriousRate }),
					// —— ① 置顶（pin）：常显，排在最上面 ——
					// 用户："重要（pin）的效果就是直接进 A 区保证显示"。这些条目同时
					// 也照旧出现在下面的「完整画像」里（状态跟着走），这里只是把它们
					// 提到最显眼处，并且它们**一定进注入**（豁免预算，宿主保证）。
					pinnedItems.length > 0
						? jsxs("div", {
								className: "pa_group",
								children: [
									jsx("h4", {
										className: "pa_groupTitle",
										children: t("pinnedHeading", { n: pinnedItems.length }),
									}),
									jsx("p", { className: "pa_cardHint", children: t("pinnedHint") }),
									jsx(MarkList, { t, items: pinnedItems }),
								],
							})
						: null,
					// —— ② 实际注入的系统提示（显眼位置：紧跟卡片头部与更新时间）——
					// 只渲染宿主的 `injectedText`。下面那行说明把"注入的"与
					// "完整画像"的关系一次讲清：上面是按预算裁剪后真正进了
					// 系统提示的那段，下面是全量画像。
					jsxs("div", {
						className: "pa_inject",
						children: [
							jsxs("div", {
								className: "pa_injectHead",
								children: [
									jsx("h4", { className: "pa_injectLabel", children: t("injectHeading") }),
									// 各分类注入条数（宿主 `injectedByCategory`）优先显示：
									// 它比"共 m 条"信息量大 —— 用户要在这里验证 A 类没被挤成 0。
									// 摘要缺这一块（老宿主 / 预览数据）时退回"共 m 条"。
									injectedByCategory
										? jsx("span", {
												className: "pa_badge",
												"data-tone": "business",
												children: t("injectBreakdown", {
													a: injectedByCategory.A,
													b: injectedByCategory.B,
													c: injectedByCategory.C,
												}),
											})
										: injectedShown === null
											? null
											: jsx("span", {
													className: "pa_badge",
													"data-tone": "business",
													children: t("injectCount", { m: injectedShown }),
												}),
								],
							}),
							injectedText
								? jsx("pre", { className: "pa_injectText", children: injectedText })
								: jsx("p", { className: "pa_cardHint", children: t("injectEmpty") }),
							jsx("p", {
								className: "pa_cardHint",
								children: t("injectHint", { m: injectedShown ?? 0, n: totalShown }),
							}),
						],
					}),
					// —— ③ 完整画像（下面这一整段都是它）——
					// 每条条目旁三个按钮：置顶 / 封印 / 删除（`actions` 就是那三个回调）。
					jsx("h4", {
						className: "pa_groupTitle",
						children: t("fullProfileLabel", { n: totalShown }),
					}),
					ledgerCounts && neverInjectedShown !== null
						? jsx("p", {
								className: "pa_cardHint",
								children: t("ledgerHint", { n: neverInjectedShown, v: ledgerVersion }),
							})
						: null,
					entries.length === 0
						? jsx("p", { className: "pa_cardHint", children: t("autoEmptyHint") })
						: jsx("div", {
								className: "pa_group",
								children: CATEGORY_ORDER.map(category =>
									jsx(
										CategoryGroup,
										{
											t,
											category,
											label: groupLabels[category],
											entries: grouped[category],
											actions: entryMarkActions,
											counts: ledgerCounts,
										},
										"g" + category,
									),
								),
							}),
					grouped[CATEGORY_EXTRA].length > 0
						? jsxs("details", {
								className: "pa_details",
								children: [
									jsx("summary", {
										children:
											groupLabels[CATEGORY_EXTRA] +
											" (" +
											grouped[CATEGORY_EXTRA].length +
											")",
									}),
									jsx(CategoryGroup, {
										t,
										category: CATEGORY_EXTRA,
										label: groupLabels[CATEGORY_EXTRA],
										entries: grouped[CATEGORY_EXTRA],
										actions: entryMarkActions,
										counts: ledgerCounts,
									}),
								],
							})
						: null,
					// —— 工作笔记：项目/工具/路径类事实，独立于画像条目（不占槽位、不注入）——
					workingNotes.length > 0
						? jsxs("div", {
								className: "pa_group",
								children: [
									jsx("h4", {
										className: "pa_groupTitle",
										children: t("workingNotesHeading", { n: workingNotes.length }),
									}),
									jsx("p", {
										className: "pa_cardHint",
										children: t("workingNotesHint"),
									}),
									jsx("ul", {
										className: "pa_list",
										children: workingNotes.map((note, index) =>
											jsx(
												"li",
												{
													className: "pa_entry",
													children: jsx("p", {
														className: "pa_claim",
														children: note.text,
													}),
												},
												"note-" + index,
											),
										),
									}),
								],
							})
						: null,
					// —— ④ 未注入（折叠）：按规则没进系统提示的条目 ——
					// 折叠区一律复用 pa_details（不新造折叠组件），默认收起。
					jsx(MarkFold, {
						t,
						heading: t("omittedHeading", { n: omittedItems.length }),
						hint: t("omittedHint"),
						items: omittedItems,
					}),
					// —— ⑤ 垃圾桶（折叠）：被封印的条目，可恢复 ——
					jsx(MarkFold, {
						t,
						heading: t("sealedHeading", { n: sealedItems.length }),
						hint: t("sealedHint"),
						items: sealedItems,
					}),
					// —— ⑥ 已删除（折叠）：删过的条目 + 各删了几次 ——
					jsx(MarkFold, {
						t,
						heading: t("deletedHeading", { n: deletedItems.length }),
						hint: t("deletedHint"),
						items: deletedItems,
					}),
					serverState.autoExtraText
						? jsxs("div", {
								className: "pa_group",
								children: [
									jsx("h4", { className: "pa_groupTitle", children: t("autoExtraLabel") }),
									jsx("p", { className: "pa_claim", children: serverState.autoExtraText }),
								],
							})
						: null,
					profile && profile.notes
						? jsxs("details", {
								className: "pa_details",
								children: [
									jsx("summary", { children: t("autoNotes") }),
									jsx("pre", { className: "pa_pre", children: profile.notes }),
								],
							})
						: null,
					profile && profile.raw
						? jsxs("details", {
								className: "pa_details",
								children: [
									jsx("summary", { children: t("autoRaw") }),
									jsx("pre", { className: "pa_pre", children: profile.raw }),
								],
							})
						: null,
				],
			});

			// —— 模式 2 面板 ——
			const customPanel = jsxs("div", {
				className: "pa_card",
				"data-inactive": isAuto ? "true" : "false",
				children: [
					jsxs("div", {
						className: "pa_cardHead",
						children: [
							jsx("h3", { className: "pa_cardTitle", children: t("customHeading") }),
							jsxs("span", {
								className: "pa_badge",
								"data-tone": isAuto ? "warn" : "ok",
								children: isAuto ? t("inactiveTag") : t("activeTag"),
							}),
							jsx("div", { className: "pa_spacer" }),
							jsx("button", {
								type: "button",
								className: "pa_btn",
								disabled: snap.busy,
								onClick: onFillFromAuto,
								children: t("customFill"),
							}),
							jsx("button", {
								type: "button",
								className: "pa_btn",
								"data-variant": "primary",
								disabled: snap.busy || !draftTouched,
								onClick: onSaveCustom,
								children: snap.busy ? t("customSaving") : t("customSave"),
							}),
						],
					}),
					!portraitText
						? jsx("p", { className: "pa_cardHint", children: t("customFillEmpty") })
						: null,
					fillConfirm
						? jsxs("div", {
								className: "pa_notice",
								"data-tone": "warn",
								children: [
									jsx("p", {
										className: "pa_noticeTitle",
										children: t("customFillConfirmTitle"),
									}),
									jsx("p", { children: t("customFillConfirmBody") }),
									jsxs("div", {
										className: "pa_row",
										children: [
											jsx("button", {
												type: "button",
												className: "pa_btn",
												"data-variant": "primary",
												onClick: applyFill,
												children: t("customFillConfirm"),
											}),
											jsx("button", {
												type: "button",
												className: "pa_btn",
												onClick: () => setFillConfirm(false),
												children: t("customFillCancel"),
											}),
										],
									}),
								],
							})
						: null,
					jsx("label", {
						className: "pa_hidden",
						htmlFor: textareaId,
						children: t("customHeading"),
					}),
					jsx("textarea", {
						id: textareaId,
						className: "pa_textarea",
						value: draft,
						placeholder: t("customPlaceholder"),
						onChange: onDraftChange,
						spellCheck: false,
					}),
					jsxs("div", {
						className: "pa_row",
						children: [
							jsx("span", {
								className: "pa_meta",
								children: t("customChars", { n: draft.length }),
							}),
							jsx("div", { className: "pa_spacer" }),
							jsx("span", {
								className: "pa_badge",
								"data-tone": draftTouched ? "warn" : "ok",
								children: draftTouched ? t("customDirty") : t("customClean"),
							}),
						],
					}),
				],
			});

			// —— 模式 3 面板 ——
			const hallPanel = jsxs("div", {
				className: "pa_card",
				children: [
					jsxs("div", {
						className: "pa_cardHead",
						children: [jsx("h3", { className: "pa_cardTitle", children: t("hallHeading") })],
					}),
					jsx("p", { className: "pa_cardHint", children: t("hallDesc") }),
					hallUrl
						? jsx("a", {
								className: "pa_link",
								href: hallUrl,
								target: "_blank",
								rel: "noopener noreferrer",
								children: t("hallLink"),
							})
						: jsx("p", { className: "pa_meta", children: t("hallUnset") }),
					jsx("p", { className: "pa_meta", children: t("hallNote") }),
				],
			});

			return jsxs("div", {
				className: "pa_root",
				children: [
					jsxs("div", {
						children: [
							jsx("h2", { className: "pa_h2", children: t("title") }),
							jsx("p", { className: "pa_intro", children: t("intro") }),
						],
					}),
					status === "loading" && !snap.state
						? jsx("p", { className: "pa_meta", children: t("statusLoading") })
						: null,
					banners.length > 0 ? jsx("div", { children: banners }) : null,
					modeCard,
					autoPanel,
					customPanel,
					hallPanel,
					jsx(SignalGrid, { t, signals: serverState.lastSignals }),
					serverState.lastRun && serverState.lastRun.at
						? jsxs("div", {
								className: "pa_notice",
								children: [
									jsx("p", {
										className: "pa_noticeTitle",
										children: t("lastRunHeading"),
									}),
									jsx("p", {
										children:
											(serverState.lastRun.ok ? t("lastRunOk") : t("lastRunFail")) +
											" · " +
											formatTime(serverState.lastRun.at, "—"),
									}),
									serverState.lastRun.reason
										? jsx("p", {
												className: "pa_meta",
												children: t("lastRunReason", {
													reason: serverState.lastRun.reason,
												}),
											})
										: null,
									serverState.lastRun.error
										? jsx("p", {
												className: "pa_meta",
												children: String(serverState.lastRun.error),
											})
										: null,
								],
							})
						: null,
					snap.contract !== null
						? jsx("p", {
								className: "pa_meta",
								children: t("statusContract", { v: snap.contract }),
							})
						: null,
				],
			});
		}

		// ====================================================================
		// 插件入口
		// ====================================================================

		/** 需要的客户端服务。与 ui-settings-plugins 的写法一致。 */
		const inject = ["slots", "locale"];

		/**
		 * 浏览器半边入口。
		 * @param {object} ctx 客户端 cordis 上下文
		 */
		function apply(ctx) {
			const tr = ctx.locale.bind(NS);

			ctx.effect(
				() => ctx.locale.register(NS, "zh", zh),
				"prompt-adapt: zh dictionary",
			);
			ctx.effect(
				() => ctx.locale.register(NS, "en", en),
				"prompt-adapt: en dictionary",
			);

			const store = createAdaptStore(ctx);
			ctx.effect(() => () => store.dispose(), "prompt-adapt: client store");

			// slots.inject：等 settings.section 这个槽位被声明后再注册。
			// 用 inject 而不是直接 register，是因为声明归属外壳插件
			// （ui-settings-general），插件加载顺序不保证；
			// 直接 register 到未声明的槽位会 fail-loud 抛错。
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "prompt-adapt",
						order: 40,
						// label 用 thunk：每次读都跟随当前语言，无需重新注册。
						label: () => tr("nav"),
						// inject 面：t / actions 原样透传；hooks.adapt 变成组件的 useAdapt 选择器 Hook。
						inject: () => ({
							t: tr,
							actions: store.actions,
							hooks: { adapt: store.source },
						}),
					},
					AdaptSection,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		/**
		 * 仅供 tools/calibrate.mjs 做单元标定与 bundle 冒烟测试使用。
		 * 不属于 DSH 的插件契约，宿主与其它插件都不应依赖它。
		 */
		exports.__internals = {
			ALGORITHM_VERSION,
			COMPARE_DEFAULTS,
			CATEGORY_TITLES,
			normalizeClaim,
			tokensOf,
			jaccard,
			claimSimilarity,
			evidenceUnchanged,
			evidenceComparable,
			parseRenderedProfileText,
			serializePortrait,
			comparePortraits,
			buildPreviewState,
			resolveApiBase,
			resolveHallUrl,
		};
		return module.exports;
	},
});
