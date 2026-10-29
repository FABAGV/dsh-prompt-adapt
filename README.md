# dsh-prompt-adapt

**一个 DeepSeek Harness（DSH）插件：让 AI 更好地适配你。**

它从你自己的历史会话里归纳出一份「用户画像」，按预算裁剪后**注入系统提示** —— 于是每次开新会话，
AI 不用你重新交代一遍就知道你的偏好、以及哪些做法在你这儿行不通。

另外几件事：

- **私人会话权限**：QQ 群 / QQ 私聊会话默认只能聊天，不拿来学习、拿不到你的画像，权限只能在
  本机控制台或 DSH 设置页里改（见「私人会话权限」）。
- **本机网页控制台**：`http://127.0.0.1:6710`，管理画像、权限、人格、技能和审计记录。
- **人格**：以一段性格描述或一位 QQ 群友为目标生成说话风格，试聊、反馈、按反馈修订。
- **学到的技能**：把你会话里摸索出来的做法整理成 DSH 技能，需要时才加载，不常驻上下文。

---

## 安装

先看结论，四条路线按"省事程度"排序：

| 路线 | 怎么装 | 前置条件 | 实测耗时（本机，走镜像） |
|---|---|---|---|
| **A 一键脚本** | `.\install.ps1 -Profile desktop` | Windows + 仓库目录 | **3.1 s**（冷装，含 282 KB 下载） |
| **B 桌面端插件页** | 粘贴下面那个 release 地址 | 桌面客户端 | 一次点击 + 一次粘贴 |
| **C CLI** | `dsh plugin --profile web add <同一个地址>` | DSH CLI | 一次 pnpm 安装 |
| D npm（**已发布**） | `dsh plugin --profile <p> add dsh-prompt-adapt` | 无 | 一次 pnpm 安装（走 `registry.npmmirror.com` 镜像） |

> **D 路线已经可用**：包发布在 npm 上 —— <https://www.npmjs.com/package/dsh-prompt-adapt>，
> 裸包名不再 404，`registry.npmmirror.com` 会自动镜像，**国内这条最快**。
> ⚠️ 与 C 路线同一个限制：桌面 profile 由应用独占管理，桌面端请走 A 或 B。
> ⚠️ **npm 镜像同步新版本会滞后几分钟到几小时**：刚发版时 `dsh plugin add dsh-prompt-adapt`
> 可能仍装到旧版。想立刻拿到当前版本，用 A/B/C（Release 资产）或在安装后确认
> `node_modules/dsh-prompt-adapt/package.json` 的 `version`。

### A. 一键脚本（推荐）

```powershell
.\install.ps1 -Profile desktop      # 或 web；不传则按 DSH_PROFILE → desktop → web 猜
```

没有本地副本时也能一行跑（`raw.githubusercontent.com` 同样走镜像）：

```powershell
& ([scriptblock]::Create((irm https://gh-proxy.com/https://raw.githubusercontent.com/FABAGV/dsh-prompt-adapt/main/install.ps1))) -Profile desktop
```

脚本做四件事：**走镜像下载 → 用 DSH 自带的 pnpm 装进 profile → 把 `dsh-prompt-adapt` 登记进
`dsh.profile.bundles` → 校验宿主入口与客户端半边都在**。`-Tag main` 装分支最新代码、
`-Uninstall` 卸载（保留 `~/.dsh/prompt-adapt` 里的画像与自定义文本）、`-WhatIf` 只打印会做什么。

两个刻意的设计：

- **以本地文件依赖安装**（`file:.dsh-packages/<包名>.tgz`），不把镜像 URL 写进
  `package.json`/lockfile —— 镜像哪天挂了，不会连 `pnpm install` 都跑不起来；tgz 留在
  profile 目录内，之后离线可重装。
- **直接改 profile 文件**，所以桌面端（`dsh plugin` 会拒绝的那个 profile）也能装。

### B. 桌面客户端（内置插件页）

在插件页里填这个**发布产物地址**（版本化、内容不变）：

```
https://github.com/FABAGV/dsh-prompt-adapt/releases/download/v0.2.0/dsh-prompt-adapt-0.2.0.tgz
```

装完**刷新页面**（插件在宿主启动时 `apply()` 一次；桌面端热加载有时不重跑）。

### C. CLI（`web` / `tui` 等非桌面 profile）

```bash
dsh plugin --profile web add https://github.com/FABAGV/dsh-prompt-adapt/releases/download/v0.2.0/dsh-prompt-adapt-0.2.0.tgz
```

**不要**用 `github:FABAGV/dsh-prompt-adapt`：这种 spec 形式下 pnpm 会先跑 `git ls-remote`，
本机没有 git 就直接失败（与网络无关）；裸包名 `dsh-prompt-adapt` 现在已经可以直接用（见 D 路线）。

> ⚠️ **桌面客户端的 profile 由应用独占管理**：`dsh plugin --profile desktop …` 会被启动器
> 直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。
> 桌面端请用 A 或 B。

> 国内网络实测：`github.com` / `codeload.github.com` 直连只有 **30–50 KB/s**；脚本按
> `gh-proxy.com → ghfast.top → ghproxy.net → 直连` 依次回退，同一个 282 KB 的包
> 直连 8.4 s、镜像 **0.9–2.5 s**。本地已有同版本 tgz 时会跳过下载（再装 0.9 s）。

### 它是不是一个真插件

给自动扫描器与人工审核省点事，机械信号都摆在这里：

| 信号 | 值 |
|---|---|
| Bundle manifest | [`cordis.patch.yml`](./cordis.patch.yml)（`package.json` 里 `dsh.bundle.patch` 指向它） |
| 包名 / 插件 id | `dsh-prompt-adapt` |
| 宿主入口 | [`lib/index.js`](./lib/index.js) —— `export default { name, Config, apply }` |
| 客户端半边 | [`lib/client.js`](./lib/client.js) —— `dsh.client` 声明 `platform: web`，挂进 `settings.section` |
| 依赖 | 无运行时依赖；`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 由 DSH 装载时提供 |
| 数据去向 | **只有本机**。不联网、不遥测、不上传（见[「数据落在哪」](#数据落在哪)） |

---

## 三个模式

| 模式 | 是什么 | 谁写 | 参与注入 |
|---|---|---|---|
| **1 自动画像** | 从历史会话归纳「你是什么样的人」+「哪些做法在你这儿行不通」 | LLM 自动，你只读 | ✅ |
| **2 自定义** | 你自己的系统提示词文本框 | 你手写 | ✅ |
| **3 提示词大厅** | 一个外链 `查看网友提示词 ↗` | 不参与 | ❌ |

**硬规则**：

- **模式 1 和模式 2 不能同时开启** —— 落实方式是 `state.mode` 是**单字段枚举**（`'auto' | 'custom'`）
  而不是两个布尔量，「两个都开」这个状态**在结构上无法表示**。
- 从模式 1 到模式 2 是**你手动复制粘贴**，没有自动写入路径。
- **模式 2 生效时不自动生成画像**：注入的是你手写的文本，画像不进 system prompt，
  自动生成只会白烧 LLM 额度。手动「重新生成」仍然可以（你想先更新画像再切回模式 1），
  但不计入注入账本。
- 模式 3 只是一个链接，宿主侧**不抓取、不缓存、不鉴权**。

## 你能在界面上看到什么

「设置 → AI 适配」里，模式 1 卡片分成六区（后三区默认折叠，不占屏幕）：

| # | 区块 | 默认 | 能做什么 |
|---|---|---|---|
| ① | **置顶** | 常显 | 被 pin 的条目 |
| ② | **实际注入的系统提示** | 常显 | **看到真正进了系统提示的那段文本全文** |
| ③ | **完整画像** | 常显 | 每条三个按钮：**置顶 / 封印 / 删除** |
| ④ | **未注入** | 折叠 | 被预算裁掉的条目，可展开翻找、可 pin 回来 |
| ⑤ | **垃圾桶** | 折叠 | 被封印的条目，可**恢复** |
| ⑥ | **已删除** | 折叠 | 被删的条目，显示**被删了多少次** |

② 区渲染的是宿主吐出的 `injectedText` **原样字节**，界面**不自己重拼** ——
所以「你看到的」与「模型收到的」逐字节相同。这是这个插件刻意守住的一条不变式。

除了六个区，界面还会显示三样东西：

- **本轮生成警告**（正在 ② 上方折叠）：含换血上限"拒绝了哪几条净新增"，不刷屏。
- **每条条目的账本徽标**：「已注入 N 版」/「从未注入」，跨版本累计 —— 直接回答
  "这条到底有没有进过系统提示"。
- **工作笔记**：项目/工具/路径类事实单独一块，不占画像槽位，见下一节。

自定义文本面板下面还有一张「私人会话权限」卡片：改 QQ 群 / QQ 私聊的默认工具权限（改成「完全」之前
会要求确认），以及「打开控制台」按钮（拿一次性登录链接，在新窗口打开；没打开的话卡片里有链接可点）。

### 第一次打开时（还没有画像）

界面不会只写一句"攒够发言后会自动生成"，而是给出**可执行的进度**（0.1.4 起）：

- 第一轮扫描还没跑完时写「正在读取本机会话记录（只读）…」，不把"还没数"说成"没有发言"；
- 扫描完成后写「首版画像需要累计 12 条真人发言（已收集 5 条，还差 7 条）」——
  阈值与计数都来自宿主，界面不自己编；
- 如果 `profile.autoRun=false`，或当前生效的是模式 2，会**直说不会自动生成**，
  并把用户的下一步指向「重新生成」/ 切回模式 1；
- 「上次生成」是**三态**：**成功 / 失败 / 未触发**。未触发 = 没到阈值，是正常状态，
  界面上会明确写"不是出错"——以前它被渲染成"失败"，是这一版修掉的 UX 缺陷。

### 置顶 / 封印 / 删除的区别

| 动作 | 效果 | 之后还会回来吗 |
|---|---|---|
| **置顶（pin）** | 界面置顶 **+ 保证注入**（豁免预算），上限 10 条 | 一直在 |
| **封印** | 拉进垃圾桶，**永不参与注入**；并把你封印过的结论喂给模型，要求「一条都不许再产出」 | **不会**（两道防线：提示词 + 注入侧硬过滤） |
| **删除** | 只是删掉当前这条 | **可能重新出现** —— 材料里仍有依据时模型会再归纳出来 |

**封印与删除的区别是刻意的**：你删掉一条但**不**封印，说明「我不想现在看到它，但我不否认它」；
删除计数会记在⑥区，被删过多次的条目反而值得回看 —— 它反复被模型认为是你的特质，而你反复删掉它。

## 注入预算

注入文本按**估算 token**（中文 1 字 ≈ 1、ASCII 4 字符 ≈ 1）裁剪，默认 **1500**：

- **B（行不通的做法）、C（有效的做法）合计上限 50%** —— 保证它们不会吃光预算
- **A（稳定特质）保底 30%** —— 保证注入里**一定有关于你的正面描述**，不被禁止项挤成 0
- 剩余 20% 是弹性
- **D（证据不足）不注入**，只在标注行报条数
- **超预算的条目只在注入侧省略**，`state.json`、界面完整画像、复制到模式 2 **始终是全量**

⚠️ 这是一个**有意的成本取舍**：注入进系统提示的文本会随画像变化而作废提示缓存。
预算就是给这件事装的刹车。

## 它做了什么

1. **增量读取会话日志**（`~/.dsh/sessions/`，**只读**）。
   日志是「每行一个独立 zstd 帧」的拼接容器，而 Node 的 `zlib.zstdDecompressSync` 遇到多帧
   **只解第一帧** —— 所以按帧边界切开逐帧解，并把「已解压到第几字节」持久化成游标。
   重启后一个帧都不会重解。
2. **四个零 LLM 的计数信号**：让你代跑 / 命令过长 / 工具反复失败 / 给了选项但你自己另说。
3. **按间隔用 LLM 增量生成画像**。上一版画像会一起喂回去，并要求「只增删确有依据的条目，
   未变动条目原样保留」—— 从零重写会产生大量假变化（实测假变化率 26.3%）。
   输出走**差量契约**：只回新增/改写条目与未变条目 id，未变正文由程序从上一版搬回。
4. **把当前生效的画像文本注入系统提示**（`systemPrompt.section()`，`order: 30`）。
5. **持久化**你在 `~/.dsh/prompt-adapt/` 下的模式、自定义文本、画像、处置标记、复制快照。

### 只有主会话算"你的发言"

会话日志里，父代理写给子代理的委派 prompt 也是 `source.kind: 'user'`。插件按
`session` 事件顶层的 `origin: 'subagent'` / `parentSession` **整会话**排除它们：
画像材料、四个信号、触发计数都不再把"AI 对 AI 说的话"当成用户发言。
（界面点开单个会话的明细仍然全量，排障不受影响。）

QQ 转进来的消息同理：dsh-whale-inurqq 投递的消息也是 `source.kind: 'user'`，说话的却是
QQ 里的人。QQ 群 / QQ 私聊会话按权限策略整会话不参与学习（见下文「私人会话权限」）；
工作区被改过名、认不出是 QQ 会话时，消息开头的「[来自 QQ …，发言人 …]」仍会把它们挡在材料之外。

## 私人会话权限

插件把每个会话分成四类，各自有一套规则：

| 类别 | 怎么认出来 | 工具权限 | 用来学习画像和技能 | 注入画像 / 自定义文本 | 能看到的技能 |
|---|---|---|---|---|---|
| 你自己的会话 | 其余所有会话 | 完全 | 是 | 是 | 全部 |
| 你派出的子代理 | `origin: 'subagent'`，父会话是你自己的 | 完全 | 否 | 否 | 全部 |
| QQ 群 | 工作区目录名 `qq-group-<群号>`（dsh-whale-inurqq 建的） | 仅聊天 | 否 | 否 | 只看共享的 |
| QQ 私聊 | 工作区目录名 `qq-private-<QQ号>` | 仅聊天 | 否 | 否 | 只看共享的 |

QQ 会话派出的子代理跟随它的 QQ 会话。父会话在本地日志里找不到、宿主也答不上来时，
按外部会话处理（宁严勿松）。

三个工具权限等级：

- **完全**：不加限制（DSH 自己的权限设置照常生效）。
- **受限**：仅聊天的全部工具，加上 `read` / `write` / `edit` / `glob` / `grep` / `web_fetch`
  等，但路径必须落在这个会话自己的工作区里，DSH 主目录和本插件状态目录永远读不到；
  `web_fetch` 拒绝本机和内网地址。没有 shell，不能派子代理。
- **仅聊天**：`skill`、`todo_write`、`web_search` 和 dsh-whale-inurqq 的 `qq_*` 工具。
  `qq_send` / `qq_history` / `qq_memory` 只能作用于这个会话自己的 QQ 会话；
  `qq_memory` 不能删除或置顶记忆，`qq_tasks` 不能取消任务。

限制在 DSH 的工具管线里执行（`ctx.tools.guard`），工具调用还没开始就被拦下，不靠提示词。
其他插件提供的工具在受限 / 仅聊天等级下默认拦下，确认安全后可以在控制台「额外放行的工具」里加。

**谁能改**：只有本机网页控制台，或者 DSH 自己的设置页（要过 DSH 的登录校验）。模型没有任何工具
能读写这套设置。每次修改和每次被拦下的工具调用都写进审计日志（`audit.jsonl`，同一个会话
一分钟内对同一个工具的重复拒绝只记一次）。设置页里能改 QQ 群 / QQ 私聊的默认工具权限；
按单个 QQ 会话、单个会话的设置（例如只给你自己的 QQ 私聊开「受限」，或把某个会话标成私密、
不参与学习）在控制台里改。插件配置里的 `privacy.enforceTools: false` 会让门控只记不拦。

## 本机控制台

插件在 `http://127.0.0.1:6710`（`console.port`，`0` = 系统分配）起一个网页控制台，
只监听 127.0.0.1，局域网里的其他设备连不上。页面：概览、画像、权限、人格、技能、审计。

登录有两种方式：

1. 在 DSH 的「设置 → AI 适配」里点「打开控制台」：拿到一个一次性登录链接（60 秒内有效、只能用一次）。
2. 打开 `$DSH_HOME/prompt-adapt/console-key`，把里面的密钥粘贴到登录页。概览页可以「更换登录密钥」，
   换完旧密钥和所有已登录的浏览器都会失效。

请求校验：`Host` 必须是本机地址（挡 DNS rebinding）；登录态是 HttpOnly + SameSite=Strict 的
cookie，12 小时不用就过期；写操作要带 CSRF 头并且来源一致；CSP 不允许内联脚本；
一分钟内登录失败 10 次会暂停登录一分钟。

## 人格

在控制台「人格」页里，以一段性格描述，或一位 QQ 群友的说话方式为目标，生成一份风格说明，再慢慢调：

- **模仿群友**：从 `$DSH_HOME/dsh-whale-inurqq/corpus/` 读这个群最近 `persona.corpusDays`（30）天的语料，
  挑出这个人的发言和发言前别人刚说的那句，最多 `persona.maxSampleChars`（30000）字给模型。
  发言少于 5 条不生成。创建前必须勾选「已征得对方同意」，注入的文本里写明"你不是本人、不冒充本人、
  不编造本人的经历和隐私"。
- **试聊**：在控制台里直接和某个版本聊（不进任何 DSH 会话），对回复点「像」或「不像」并写一句哪里不像。
- **按反馈修订**：把攒下的反馈交给模型改出新版本；每个版本都留着，可以随时切回去。
  模型建议的"人格记忆"先作为候选，你采用之后才会注入。
- **用在哪**：绑定到你自己的全部会话、某个 QQ 会话或单个会话。同一个会话命中多个人格时，
  单个会话的绑定优先，其次 QQ 会话，最后是"你自己的全部会话"。子代理不注入人格。

人格作为单独的系统提示段注入（`dsh-prompt-adapt:persona`，`order: 31`），只给启用并绑定了的会话，
写明不覆盖系统规则和权限。

## 学到的技能

插件会把你自己会话里摸索出来的做法整理成 DSH 技能，平时只有技能名和一句描述在上下文里，
模型需要时才用 `skill` 工具加载全文：

- **材料**：只用你自己的、允许学习的会话（QQ 会话、子代理、标成私密的会话都不用），
  而且至少有 `skills.minToolCalls`（8）次工具调用、空闲 10 分钟以上。给模型的是摘要：你的请求、
  工具名和简短参数、失败、最后一条回复；密钥、令牌、邮箱、手机号、用户目录名、IP 在发出前脱敏。
- **判断**：模型给每个候选打四项分（可复用、已验证、具体、安全，1–5 分），四项都不低于
  `skills.autoActivateScore`（4）才直接启用，否则先当候选，等你在控制台里启用。
- **挂到 DSH**：技能来源名是 `prompt-adapt`，技能名统一带 `learned-` 前缀。默认只给你自己的会话；
  点「共享给 QQ 会话」后 QQ 会话也能加载。
- **自动整理**：每 `skills.minIntervalHours`（24）小时最多一次，攒够 `skills.minNewSessions`（3）个
  新会话才跑；控制台里可以手动「现在整理」。你改过的技能不会被自动整理覆盖，改之前的版本留在历史里。

### 注入落账与新生试用位

每一版画像**真正进了 system prompt** 的条目 id 与累计次数会写进
`state.injectionLedger`。于是"这条从来没被交付过"第一次成为可查询的事实。
清空画像时会**同时清空这本账**：账是按条目 id 记的，旧 id 会留在账上并可能被
模型复用的短 id（n1、n2…）继承，导致新结论永远拿不到试用位。

排序分数由模型自报的 confidence / 引文数决定，老条目会长期压住新生条目
（实测当前画像 A 线 242、B/C 线 232、新生最好 231 —— 新生在算术上进不去）。
所以每个池子（A 一个、B/C 合用一个）留 **1 个试用位**给"交付次数为 0 且引文 ≥2"
的最高分新生条目，**只保一版**；下一版它有了交付记录，就回到正常排序里比。

### 换血上限

画像到 **44 条**后，新增条数必须 ≤ 本轮删除（含合并）条数，否则净新增按分数
从低到高被拒绝（`profile.capRejected` 会记下拒绝了哪几条）。只拒**新条目**，
改写沿用旧 id 不受影响；旧画像已经超过 44 条时**不强制瘦身**（那需要档案层，
不能静默删用户数据），只停止继续增长。

### 饱和守卫

画像达到软上限后，如果**连续两轮**生成都是 0 新增 / 0 删除 / 0 改写，自动生成会
暂停并在 `lastRun.reason` 写明原因 —— 再跑一次也不会改变任何东西，只会白烧一次
LLM 调用（本机实测 v44–v47 连续 4 轮 0 变更仍按 12 条/3 会话触发）。设置页在
模式 1 卡片里显示“画像已达增长上限（当前 N 条）”。

用户删除 / 封印 / 取消置顶后，`zeroChangeStreak` 清零，自动生成重新尝试；
手动「重新生成」不受守卫限制。

### 工作笔记（项目事实不占画像槽位）

画像条目只写**用户本人**的稳定特质/偏好/纪律；项目、工具、路径、账号、仓库类事实
由模型写进生成结果的 `projectNotes`，宿主合并到 `state.workingNotes`：

- **不占 44 条画像槽位**，不参与注入预算，也**不会被自动注入**（换一个项目就不成立）；
- 界面在 ③ 下面单列「工作笔记」，按文本去重，最多保留 50 条；
- 旧画像里 3 条"本插件设计需求"（模式 1/2 互斥、画像文本无上限、画像归纳器）
  在升级后第一次启动时一次性移入工作笔记（文本保留、可逆，不是删除）。

## 配置

走 profile 的插件配置界面（或 `cordis.patch.yml` 的 `config` 段）：

```yaml
- id: dsh-prompt-adapt
  name: dsh-prompt-adapt
  config:
    logLevel: info
    signals:
      longToolMs: 60000        # 「命令过长」阈值
      repeatFailMin: 3         # 「工具反复失败」连续次数
      answerWindowMs: 1800000  # 「给了选项但用户自己另说」的时间窗
    profile:
      triggerUserMessages: 12  # 累计新增真人发言达到这个数就更新画像
      triggerNewSessions: 3    # 或新增会话达到这个数（先到者触发）
      maxTokens: 16000         # 单次生成的输出上限（调小会在条目变多后截断 JSON）
      autoRun: true
    scan:
      intervalMs: 120000       # 后台扫描间隔
      maxFramesPerScan: 400    # 每轮的帧预算（既限最多解压多少帧，也限结构扫描走多远）
    inject:
      budgetTokens: 1500       # 注入预算（估算 token）
      maxPinned: 10            # 最多置顶多少条
    privacy:
      enforceTools: true       # 按会话类别限制工具（关掉后只记不拦）
      defaultExternalTier: chat  # QQ 会话默认的工具权限：chat / safe / full
      injectProfileIntoSubagents: false
      requireDshAuth: true     # 设置页接口要求 DSH 自己的登录校验
    console:
      enabled: true
      port: 6710               # 0 = 系统分配
    persona:
      corpusDays: 30           # 模仿群友时读最近多少天的 QQ 语料
      maxSampleChars: 30000
    skills:
      enabled: true
      autoMine: true
      minIntervalHours: 24
      minNewSessions: 3
      autoActivateScore: 4     # 四项自评都不低于它才直接启用；6 = 一律先当候选
```

人格和技能默认跟随画像生成用的 provider / model，可以在 `persona.provider` / `persona.model`、
`skills.provider` / `skills.model` 里单独指定。按会话、按 QQ 会话的权限覆盖项不在插件配置里，
在控制台里改（落在 `privacy.json`）。

完整字段见 [`lib/schema.js`](./lib/schema.js)（每个字段都有中文说明）。

**配置里有意没有的东西**：

- **没有 API key**：画像生成走 `ctx.llm.stream()`，复用宿主已配置的 provider/model 与凭据。
- **没有三个模式的开关**：模式、自定义文本、画像都是**用户数据**，在
  `~/.dsh/prompt-adapt/state.json` 里，由界面通过 HTTP 路由读写。放配置里会导致
  「改一次模式就重载插件」。

## 界面接口（HTTP）

宿主把服务暴露在一条 prefix 路由下（`webServer` 缺失时这层整体降级，插件其余功能不受影响）：

```
GET  /dsh-prompt-adapt/api/state              状态 + profile + injectedText + hallUrl
POST /dsh-prompt-adapt/api/mode               {mode:'auto'|'custom'}
PUT  /dsh-prompt-adapt/api/custom             {text}
POST /dsh-prompt-adapt/api/regenerate         触发画像生成（立刻 202，后台跑）
POST /dsh-prompt-adapt/api/copied             {text, entries?, algorithmVersion?}
POST /dsh-prompt-adapt/api/rescan             强制重扫会话日志
POST /dsh-prompt-adapt/api/entry/pin          {id?, claim}    置顶
POST /dsh-prompt-adapt/api/entry/seal         {id?, claim}    封印
POST /dsh-prompt-adapt/api/entry/delete       {id?, claim}    删除
POST /dsh-prompt-adapt/api/entry/unpin        {key}           取消置顶
POST /dsh-prompt-adapt/api/entry/unseal       {key}           从垃圾桶恢复
GET  /dsh-prompt-adapt/api/privacy            权限策略（默认值、覆盖项、各类别生效规则）
PUT  /dsh-prompt-adapt/api/privacy            {overrides}     改权限（只认 DSH 的登录校验）
POST /dsh-prompt-adapt/api/console/ticket     一次性控制台登录链接（只认 DSH 的登录校验）
```

宿主带 `connection` 服务时（桌面端与 dsh web 都带），每个请求都要过 DSH 自己的登录校验：
桌面端的设置页请求由主进程转发并附上 DSH 的登录 cookie，dsh web 是同源请求。没有这项服务的宿主
退回只认本机地址（`Host` 和对端地址都必须是本机）。`PUT /privacy` 和 `POST /console/ticket`
没有退路，必须过 DSH 的登录校验。

控制台自己的接口在 `http://127.0.0.1:6710/api/*`，只给控制台页面用，需要控制台登录。

⚠️ 前缀匹配要求 `${prefix}/`，所以**不要**直接请求裸的 `/dsh-prompt-adapt/api`
（那会落到宿主的 fallback）。用 `GET /dsh-prompt-adapt/api/` 或任一具体端点。

## 数据落在哪

```
~/.dsh/prompt-adapt/               （$DSH_HOME 优先）
├─ state.json                     用户数据 + 画像 + 处置标记（置顶/封印/删除）
├─ cursor.json                    帧偏移水位
├─ plain/<sha1>.jsonl             已解压会话明文缓存
├─ profile-history/               每次生成的画像快照，只增不删
├─ privacy.json                   私人会话权限的覆盖项（读不懂时留档并按默认值运行）
├─ audit.jsonl                    审计：权限修改、被拦下的工具调用、人格与技能的变化（超过 512 KB 轮转）
├─ personas.json                  人格：版本、反馈、记忆、绑定
├─ skills.json                    学到的技能与整理记录
├─ console-key                    控制台登录密钥
└─ plugin.log                     日志镜像
```

**除了你配置的模型，没有数据离开这台机器。** 插件不发起网络请求；出站调用只有你自己配置的
LLM provider（`ctx.llm.stream()`），发送的是：归纳画像用的你的发言片段；生成或修订人格时，
被模仿的那位群友的 QQ 发言样本（只在你点「生成」「修订」时）；整理技能用的脱敏会话摘要；
控制台里的试聊。不发送原始日志文件。控制台是只监听 127.0.0.1 的入站服务，不发请求。

## 开发与测试

依赖 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`，由 DSH 在装载时提供，
所以本仓库**不带 `node_modules`**。本地跑测试时把它指向你已装好的 DSH profile：

```powershell
# 把 $profileName 换成你机器上实际存在的 profile（web / desktop / …）
$profileName = 'web'
$target = "$env:USERPROFILE\.dsh\profiles\$profileName\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force -Path "$PWD\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$PWD\node_modules\@deepseek-ai" -Target $target
```

跑测试（**对真实会话日志只读**，状态写临时目录，不改你的运行数据）：

```bash
node test/parity.mjs              # 帧扫描 vs 宿主自己的实现，逐帧差分
node test/selftest.mjs            # 核心不变式（差量契约、截断抢救、删除守卫）
node test/loadtest.mjs            # 真实 cordis Context 上跑 apply()
node test/httptest.mjs            # 真 HTTP server + fetch 打全部端点
node test/http-trust.mjs          # 来源栅栏 + 桌面端 token/CORS 预检
node test/saturation-guard.mjs    # 画像饱和守卫与 zeroChangeStreak
node test/state-hardening.mjs     # 落盘原子性、损坏文件留档、类型兜底
node test/inject-budget.mjs       # 预算分配与极端场景
node test/marks-guard.mjs         # 置顶/封印/删除的语义与跨版本效果
node test/profile-delta-guard.mjs # 差量拼装与截断抢救
node test/extract-bugfix.mjs      # 提取层增量与游标
node test/privacy.mjs             # 会话分类、工具门控、覆盖项校验、审计
node test/persona-skills.mjs      # 人格仓库、QQ 语料、技能整理与可见范围、脱敏
node test/profile-safety.mjs      # 画像生成的安全修复（漏写不删光、id 分配、正文清洗、置顶保护）
node test/console-e2e.mjs         # 假 DSH 环境里的完整链路：控制台登录、权限、人格、技能、注入隔离
node tools/calibrate.mjs          # 与宿主真实路由的集成自检
node tools/console-preview.mjs    # 用合成数据起一个控制台看界面（不碰 ~/.dsh，不调真实模型）
```

走 `apply()` 的测试会启动本机控制台；不想占端口时设 `DSH_PROMPT_ADAPT_CONSOLE=off`（CI 就是这样跑的，
`test/console-e2e.mjs` 自己用随机端口）。

`test/parity.mjs` 需要宿主那支 `dsh-session-persistence-jsonl` 的实现当标尺，
按 `$DSH_HOME`（默认 `~/.dsh`）自动探测各 profile 的 `node_modules`；
探测不到时它**判失败而不是跳过**（"取不到标尺"不该被当成"比对通过"）。
实在找不到可用 `DSH_CANONICAL_SESSION_PKG` 显式指定。

> `test/selftest.mjs` 的帧扫描与信号统计对着**真实会话日志**跑；本机没有日志时
> （CI、新机器）它会自动生成一份结构相同的**合成语料**继续跑完全部断言，
> 并在输出第一行明确写「本次用合成语料」——不静默跳过，也不冒充真实数据。

**最后一次实测**（2026-10-29，隔离的临时 HOME，CI 跑的那 26 个文件）：1294 条断言全部通过，其中

```
selftest            144 通过 / 0 失败
console-e2e         118 通过 / 0 失败
persona-skills       93 通过 / 0 失败
privacy              88 通过 / 0 失败
marks-guard          70 通过 / 0 失败
plan-cache           61 通过 / 0 失败
tick-signals         60 通过 / 0 失败
scan-tail            60 通过 / 0 失败
httptest             54 通过 / 0 失败
http-trust           57 通过 / 0 失败
inject-budget        48 通过 / 0 失败
loadtest             45 通过 / 0 失败
profile-safety       34 通过 / 0 失败
saturation-guard     15 通过 / 0 失败
```

`test/parity.mjs`、`tools/calibrate.mjs` 要对着本机真实的 DSH 安装跑，这一轮没有重跑
（上一次的结果：parity 230 个文件 / 71180 帧逐帧一致，calibrate 147 通过）。

设计意图、接口查证记录、以及**已知的未完成/不确定项**见
[IMPLEMENTATION.md](./IMPLEMENTATION.md) 与 [UI-IMPLEMENTATION.md](./UI-IMPLEMENTATION.md)。

## 排障

| 现象 | 先看哪里 / 怎么办 |
|---|---|
| 一直没有画像 | 模式 1 卡片里的**首跑进度**：它写着已收集多少条、还差多少条。首版要累计 `profile.triggerUserMessages`（默认 12）条真人发言；模式 2 生效或 `autoRun=false` 时不会自动生成。 |
| 「上次生成」显示**未触发** | 正常状态：这次检查没到阈值，什么都没做。下面那行 `原因` 里有 `发言 +3/12，会话 +1/3` 这样的实数。 |
| 「上次生成」显示**失败** | 看同一张卡里的 `原因` 与错误行；常见原因是宿主 provider/model 不可用、超时（`profile.timeoutMs`）、或输出被 `maxTokens` 截断。 |
| 设置页显示「未连接宿主」 | 先确认插件装进了**当前 profile**；桌面端装完要**刷新页面**。再确认宿主 HTTP 路由前缀是 `/dsh-prompt-adapt/api`（界面每次请求都带这个前缀）。 |
| 画像更新了，但界面没变 | 生成在后台跑，界面每 3 秒轮询一次；还在跑时按钮显示「生成中…」。超过 5 分钟仍未更新，看 `lastRun.error`。 |
| 删除的条目又回来了 | 这是设计：**删除**不禁止模型重新归纳；要永久挡住请用**封印**。 |
| 「打开控制台」没反应 / 卡片里写控制台没有启动 | 看 `plugin.log` 里 `[console]` 开头的行：常见是端口 6710 被占用，改 `console.port`（`0` = 系统分配）。也可以直接用 `console-key` 文件里的密钥登录。 |
| 忘了控制台密钥 / 担心密钥泄露 | 密钥在 `$DSH_HOME/prompt-adapt/console-key`。登录后在概览页点「更换登录密钥」，旧密钥和所有已登录的浏览器立即失效。 |
| QQ 里的机器人说"不能使用某个工具" | 这是权限门控在起作用：控制台「审计」页能看到是哪个会话、哪个工具、什么等级。确实需要时，在「权限」页给那个 QQ 会话单独调高等级，或把工具加到「额外放行的工具」。 |
| QQ 会话里的话出现在画像里 | 不应该发生：先在控制台「权限 → 单个会话」里确认那个会话被认成了什么类别。被认成"你自己的会话"，多半是工作区目录名不是 `qq-group-*` / `qq-private-*`。 |

## 已知限制

- **`freeformAnswers`（「给了选项但你自己另说」）此前不可信** —— **已修**：判据依赖
  `user/message` 的 `turn` 字段，而实测真实日志里该字段非空的有 **0 条**（`user/message` 的
  `data` 就是 message 本身，键是 `content/source/role/id`），所以位置约束整块是死代码。
  现在 turn 由 `bySession()` 在会话级按事件顺序位置性推导（`turn/start` 可能落在更早的帧里，
  所以不能只在单帧内推），`countFreeformAnswers` 自己还兜了一层。实测本机 14 个会话：
  **4 → 1**，误计的 3 条全是「提问之后跨了 turn 边界才出现的新话题」。
- **索引可能长期不完整** —— **已改**：帧预算过去按文件顺序先到先得，排在后面的文件一轮轮
  读不到（实测 216 个文件里一度 100 个 `offset=0`，按 400 帧/轮要 130+ 轮才追上）。现在游标里
  记轮转位置、每轮从上次收尾处继续，并且只从游标处读尾巴（不再每轮从头扫整个文件）。
- **封印按文本精确匹配**：中文同义改写认不出来（实测相似度分不开同一条换说法与两条不同结论），
  所以改写过的封印条目会漏认 —— 由提示词那道概率性防线兜。
- **多进程共用 `DSH_HOME` 时是「后写覆盖先写」**：整份状态由内存写出，
  两个宿主进程同时跑会让设置页的编辑被静默回滚。权限、人格、技能三个文件同理；
  第二个进程的控制台会因为端口被占用起不来（`plugin.log` 里有警告），可以给它配 `console.port: 0`。
- **QQ 会话靠工作区目录名认**：`qq-group-<群号>` / `qq-private-<QQ号>` 是 dsh-whale-inurqq 建的。
  工作区被挪到别的目录名下的 QQ 会话会被当成你自己的会话：学习侧还有消息前缀兜底，工具门控没有。
- **工具门控只认得 DSH 内置工具和 `qq_*` 工具**：其他插件的工具在受限 / 仅聊天等级下一律拦下，
  要用就在控制台里加到「额外放行的工具」。受限等级只检查带路径参数的那几个工具。
- **同一用户下的其他进程**本来就能直接改 `privacy.json` 和 `state.json`，这一层管不到。
- **人格像不像取决于语料量**：发言少于 5 条不生成；样本按时间取最近的，不保证覆盖这个人的各种说话场景。

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。
