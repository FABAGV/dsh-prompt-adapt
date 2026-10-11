# dsh-prompt-adapt

**一个 DeepSeek Harness（DSH）插件：让 AI 更好地适配你。**

它从你自己的历史会话里归纳出一份「用户画像」，按预算裁剪后**注入系统提示** —— 于是每次开新会话，
AI 不用你重新交代一遍就知道你的偏好、以及哪些做法在你这儿行不通。

---

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-prompt-adapt
```

`<你的profile>` 填你实际在用的 profile 名：**CLI / `npx @deepseek-ai/dsh web` 用 `web`，
官方桌面客户端用 `desktop`**。装完**重启 DSH**（插件在宿主启动时 `apply()` 一次）。

⚠️ **那条命令需要本包已发布到 npm。** 截至撰写时**尚未发布**，所以现在它会报
`ERR_PNPM_FETCH_404: dsh-prompt-adapt is not in the npm registry`。
在那之前请用下面两种方式之一。

**方式一：直接从 GitHub 装**

```bash
dsh plugin --profile <你的profile> add github:FABAGV/dsh-prompt-adapt
```

**方式二：本地链接**（改自己的副本）

```bash
dsh plugin --profile <你的profile> add link:<本目录绝对路径>
```

> ⚠️ **桌面客户端的 profile 由应用独占管理**，`dsh plugin` 会拒绝写入
> （`profile "desktop" is managed exclusively by the Electron application`）。
> 桌面端请用内置的插件管理界面装载。

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
      maxFramesPerScan: 400    # 每轮最多解压多少帧
    inject:
      budgetTokens: 1500       # 注入预算（估算 token）
      maxPinned: 10            # 最多置顶多少条
```

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
```

⚠️ 前缀匹配要求 `${prefix}/`，所以**不要**直接请求裸的 `/dsh-prompt-adapt/api`
（那会落到宿主的 fallback）。用 `GET /dsh-prompt-adapt/api/` 或任一具体端点。

## 数据落在哪

```
~/.dsh/prompt-adapt/               （$DSH_HOME 优先）
├─ state.json                     用户数据 + 画像 + 处置标记（置顶/封印/删除）
├─ cursor.json                    帧偏移水位
├─ plain/<sha1>.jsonl             已解压会话明文缓存
├─ profile-history/               每次生成的画像快照，只增不删
└─ plugin.log                     日志镜像
```

**没有任何数据离开这台机器。** 插件不发起网络请求；唯一的出站调用是你自己配置的
LLM provider（`ctx.llm.stream()`），且只发送**用于归纳画像的会话片段**，不发送原始日志文件。

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
node test/state-hardening.mjs     # 落盘原子性、损坏文件留档、类型兜底
node test/inject-budget.mjs       # 预算分配与极端场景
node test/marks-guard.mjs         # 置顶/封印/删除的语义与跨版本效果
node test/profile-delta-guard.mjs # 差量拼装与截断抢救
node test/extract-bugfix.mjs      # 提取层增量与游标
node tools/calibrate.mjs          # 与宿主真实路由的集成自检
```

`test/parity.mjs` 需要宿主那支 `dsh-session-persistence-jsonl` 的实现当标尺，
按 `$DSH_HOME`（默认 `~/.dsh`）自动探测各 profile 的 `node_modules`；
探测不到时它**判失败而不是跳过**（"取不到标尺"不该被当成"比对通过"）。
实在找不到可用 `DSH_CANONICAL_SESSION_PKG` 显式指定。

**全部测试是绿的**（最后一次实测）：

```
parity              PASS —— 230 个文件 / 71180 帧与宿主实现逐帧一致（不一致 0）
selftest            142 通过 / 0 失败
httptest            53 通过 / 0 失败
loadtest            44 通过 / 0 失败
state-hardening     33 通过 / 0 失败
extract-bugfix      12 通过 / 0 失败
profile-delta-guard 22 通过 / 0 失败
inject-budget       54 通过 / 0 失败
marks-guard         70 通过 / 0 失败
client-marks-render 40 通过 / 0 失败
calibrate           147 通过 / 0 失败
```

设计意图、接口查证记录、以及**已知的未完成/不确定项**见
[IMPLEMENTATION.md](./IMPLEMENTATION.md) 与 [UI-IMPLEMENTATION.md](./UI-IMPLEMENTATION.md)。

## 已知限制

- **`freeformAnswers`（「给了选项但你自己另说」）目前不可信**：判据依赖 `user/message`
  事件的 `turn` 字段，而实测真实日志里该字段非空的有 **0 条**，位置约束整块是死代码。
  这个数字偏高约一个数量级。（已在 `IMPLEMENTATION.md` 记录，待修。）
- **索引可能长期不完整**：帧预算每轮 400 帧、按文件顺序先到先得，冷启动后要很多轮才追上，
  而外观上与「没有新数据」一样。实测本机 216 个文件里一度有 100 个 `offset=0`。
- **封印按文本精确匹配**：中文同义改写认不出来（实测相似度分不开同一条换说法与两条不同结论），
  所以改写过的封印条目会漏认 —— 由提示词那道概率性防线兜。
- **多进程共用 `DSH_HOME` 时是「后写覆盖先写」**：整份状态由内存写出，
  两个宿主进程同时跑会让设置页的编辑被静默回滚。

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。
