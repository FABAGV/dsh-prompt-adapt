# 界面实现说明

`dsh-prompt-adapt` 的**客户端半边**（设置里的一页）。宿主半边由另一个代理同时编写，目录共用。

**交付物**

| 文件 | 说明 |
|---|---|
| `lib/client.js` | 客户端半边本体。2276 行，**手写 DSH bundle**，无构建步骤 |
| `tools/calibrate.mjs` | 自检（145 项断言，含与宿主 `lib/http.js` 的集成）+ 用真实画像样本标定修订阈值 |
| `package.json` | 我**增量**加了 `exports` 与 `dsh.client`，原有字段一字未改 |
| `UI-IMPLEMENTATION.md` | 本文件 |

自检结论：`node tools/calibrate.mjs` → **通过 145 项，失败 0 项**（退出码 0）。

其中第 7 节是**与宿主真实路由代码的集成测试**：把宿主 `lib/http.js` 的 `registerRoutes()` 挂到假 webServer 上，再把 `fetch` 接到那个 handler 上，于是客户端的每个请求都真的过一遍宿主的路径分发 / 方法校验 / body 解析 / 状态码 / 响应序列化。**客户端与宿主侧的接口是对着跑过的，不是靠约定。**

> **时效说明**：写作过程中宿主侧在并行推进。我第一遍读 `lib/index.js` 时它只有服务、没有传输；后来它补齐了 `lib/http.js`（prefix 路由）与 `lib/hall.js`。本文档已按**最终实际状态**更新，并保留了"我是在哪一步发现双方不一致、又怎么对齐的"记录。

---

## 一、接口查证结论（含 inspect 调用与返回）

### 1.1 先说结论：4 个 client Inspect Provider **全部超时**，我没有拿到它们的实际返回

我按任务要求先查了 Inspect，但**一个都没查到**。如实记录：

```
cordis_inspect_list
→ {"providers":[
     {"platform":"host",  "id":"Service","methods":["listService"]},
     {"platform":"host",  "id":"Event",  "methods":["listEvents"]},
     {"platform":"host",  "id":"Config", "methods":["listConfigs"]},
     {"platform":"host",  "id":"Tool",   "methods":["listTools"]},
     {"platform":"client","id":"Service","methods":["listService"]},
     {"platform":"client","id":"Event",  "methods":["listEvents"]},
     {"platform":"client","id":"Builtin","methods":["listBuiltins"]},
     {"platform":"client","id":"Slots",  "methods":["listSubTree"]},
     {"platform":"client","id":"Theme",  "methods":["listTokens"]}
   ]}
```

5 个 client provider 存在（说明曾有页面把 manifest 同步上来过），但每一次查询都是同一个结果：

```
cordis_inspect_query {platform:"client", provider:"Slots",   method:"listSubTree"}   ×8 次
cordis_inspect_query {platform:"client", provider:"Service", method:"listService"}   ×2 次
cordis_inspect_query {platform:"client", provider:"Builtin", method:"listBuiltins"}  ×2 次
cordis_inspect_query {platform:"client", provider:"Theme",   method:"listTokens"}    ×1 次

→ Error: Slots.listSubTree: Client inspect query Slots.listSubTree timed out after 10000ms.
  Open or reconnect the Harness page, then retry.
（四个 provider 的错误文本同构，只有 provider/method 名不同）
```

**原因排查**：GUI 服务器本身是活的 —— `http://127.0.0.1:19387/` 未鉴权访问返回 **401**，`Get-NetTCPConnection -LocalPort 19387 -State Listen` 显示 **pid 40732** 在监听。工具说明写着「A Client query waits for the first valid page response within the configured timeout」，所以是**当时没有页面在应答 inspect 路由**，不是插件或端口的问题。我没有浏览器可以自己打开页面，因此这一项**确实没查到**。

**我改用了什么**：随包发布的 `.d.ts` 与 `lib/client.js`。这些是 DSH 自己构建产物里的**权威契约**（比运行时 inspect 更硬：inspect 只能反映"当前这一刻"），而且都能给出实际调用与实际返回。下面每一条都注明来源文件与行号。

### 1.2 唯一一个**真的跑通**的 Inspect：宿主侧 `webServer` 契约

这一条是我定义客户端↔宿主传输方式的依据，用 host provider 查的（本地执行，不需要页面）：

```
cordis_inspect_query {platform:"host", provider:"Service", method:"listService",
                      input:{service:"webServer"}}
→ data.service.methods[0] = {
    "signature": "register(route: WebRoute): () => void",
    "description": "Register a named route. Duplicate (kind, path) throws — route patterns are
                    a composition-level contract, so a collision is a misconfiguration.",
    "returns": "the disposer removing the route."
  }
  referencedTypes:
    WebRoute     = { kind: WebRouteKind; path: string;
                     handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
    WebRouteKind = 'exact' | 'prefix'
  另有：tapIndex(transform:(html:string)=>string): () => void
        registerFallback / registerUpgrade / applyIndexTaps / collectIndexInjections / renderIndex
```

**因此客户端的传输方式定为 HTTP + `webServer.register({kind:'prefix'})`。** 这是本文件里唯一一条"我实际查到"的通信契约。

### 1.3 `Slots`：`ctx.slots` 是什么，`settings.section` 是谁声明的

*来源：`C:\Users\<用户名>\.dsh\profiles\node_modules\@deepseek-ai\`*

**(a) 客户端 `ctx.slots` 的真实类型 —— `dsh-client-ui-renderer/lib/types/client/registry.d.ts`**

```ts
declare module '@deepseek-ai/cordis' { interface Context { slots: SlotRegistry } }   // :27
class SlotRegistry extends Service {
  readonly register: SlotCore['register'];                    // :85   注册一个贡献
  inject(key: keyof SlotMap & string,
         callback: () => SlotInjectionEffect): () => void;    // :111  等槽位被声明后再注册
  entries(key): readonly StoredEntry[];                       // :164
  entriesOfSlot(key): readonly StoredEntry[];                 // :174
  spec(key): SlotSpec<SlotMap[K]> | undefined;                // :198
  subscribe(key, fn): () => void;                             // :205  微任务批量的变更订阅
  getVersion(key): number;                                    // :211  uSES 配对的版本号
  snapshot(root?): LiveCompositionNode[];                     // :180  只读拓扑导出
}
```
文件注释里还写明了关键语义：`register` **必须**保持原型方法（service 代理把 `this.ctx` 绑到**调用方**的 ctx，所以 effect 与卸载级联落在调用方 fiber 上）；`entries()` 返回**缓存引用**、在两次变更之间稳定，可以安全当 uSES 的 getSnapshot 源。这两点决定了我的 store 必须保证 `getSnapshot()` 引用稳定。

**(b) `settings.section` 与 `settings.general.item` 的类型 —— `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`**

```ts
'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps };      // :73-77
'settings.general.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }; // :120-124

interface SettingsSectionOwnerProps { close: () => void }        // :154-157
interface SettingsGeneralItemOwnerProps { children?: never }     // :128-131
```
同一文件的注释原文（决定了我选哪个，见 §二）：
- 关于 `settings.general.item`：*"One preference row inside the General section — the additive seat for a single setting that needs no page of its own (a whole page is `settings.section`)… The section column only stacks rows, so a row draws its own internals, including its label: **nothing projects a `label` here and the owner passes no props at all**"*
- 关于 `settings.section`：*"One settings page per list entry. Registrant options carry the nav identity: `id` (section key, drives `only` filtering), `order` (nav position), `label` (registrant-localized display text — the registrant re-registers with fresh text on locale change…)"*

**(c) `settings.section` 的**声明者**是外壳 —— `dsh-client-ui-settings-general/lib/client.js:1136`**

```
Select-String dsh-client-ui-settings-general/lib/client.js -Pattern '"settings\.section":\s*\{' -Context 4,6
→ :1136  "settings.section": { kind: "list", scope: "root" },     ← 在某个 register() 的 children 表里
   :1140  "settings.onboarding": { kind: "list", scope: "root" },
```
这条很重要：**声明归外壳（ui-settings-general）**，我的插件只往里注册。因为插件加载顺序不保证，我**不能**直接 `register`（注册到未声明的槽位会 fail-loud 抛错），必须走 `slots.inject` 等声明。

**(d) 真实的注册写法 —— `dsh-client-ui-settings-plugins/lib/client.js:201-212`**

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "plugins",
  order: 15,
  label: () => t("nav"),
  locale: NS,
  inject: sectionInjected,
  children: { "settings.plugins.tab": { kind: "list", scope: "root" } }
}, PluginsSettingsSection));
```
注意 `label: () => t("nav")` 是 **thunk**：契约文档说 thunk 每次读都重新求值，所以语言切换不需要重新注册。我照抄了这个形态。

**(e) 导出的 `inject` 是**服务名**，不是包名 —— `dsh-client-ui-settings-plugins/lib/client.js:162`**

```js
const inject = ["slots", "locale"];    // 服务 key
exports.inject = inject;
```
而 `package.json` 里的 `dsh.client.inject` 是**包名**，两者不是一回事：
```json
// dsh-client-ui-settings-plugins/package.json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-locale",
                               "@deepseek-ai/dsh-client-ui-settings"],
                     "platform": "web" } }
```

### 1.4 bundle 格式：客户端插件就是一个注册 factory 的脚本

*来源：`dsh-client-ui-settings-plugins/lib/client.js:1-19`*

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-settings-plugins",     // ← 模块身份 = 包名
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");
    // … CSS 注入：document.querySelector('style[data-plugin-css="<id>"]') 为 null 时建 <style> 挂 head
    // … 组件定义
    exports.apply = apply;  exports.inject = inject;  return module.exports;
  }
});
```
**这就是我手写 `lib/client.js` 的模板**。它是纯 JS，所以不需要 tsdown、不需要 TypeScript 就能被 `/plugins/dsh-prompt-adapt/client.js` 直接提供 —— 代价是我不能用 JSX（改用 `react/jsx-runtime` 的 `jsx/jsxs`）。

模块系统怎么发现、怎么发、共享哪些模块（*来源：`dsh-client-modules/README.zh.md`*）：
- 宿主半扫描已启用的 Loader 条目，把每个 `dsh.client` 声明变成 `/plugins` 下的 bundle；`<id>/client` 与裸 id 解析到同一组导出。
- 外壳初始化一张冻结的模块表 `PLATFORM_MODULES`：**React、Cordis 与静态 UI 库**。只从这张基座解析 external，额外请求要写进 `dsh.client.external`。
- 「缺失 bundle 会明确导致激活失败，并给出一条构建说明及包／路径列表」→ 所以 `lib/client.js` 必须存在于安装包里（`package.json` 的 `files` 已含 `lib`）。
- HMR：*"已打开的 Web 页面通过 HMR 传输跟随 Host 的完整模块图"*，但只有 `pnpm run dev:web` 在跑时客户端 bundle 才会重建并自动重载。**我不会承诺"改完立刻生效"。**

**因此我的客户端半边只 `require("react")` 与 `require("react/jsx-runtime")`（都在基座里），`dsh.client.external` 留空；`ctx.slots` / `ctx.locale` 一律从插件 ctx 取，不 import 任何 `@deepseek-ai/*` 包。**

### 1.5 `Theme`：token 名单（inspect 超时，改为从随包 CSS 里提取）

client `Theme.listTokens` 超时了。我改为从 `dsh-client-ui-theme/lib/client.js` 里把 token 名全量提取出来：

```
$raw = Get-Content dsh-client-ui-theme/lib/client.js -Raw
[regex]::Matches($raw,'--dsw-[a-z0-9-]+') | % Value | Sort-Object -Unique
→ 得到 400+ 个 token，四类：--dsw-alias-* / --dsw-static-* / --dsw-font-* / --dsw-radius-* 等
```
**本插件实际用到 37 个**（`lib/client.js` 里 `--dsw-` 去重计数 = 37）：

| 类别 | 用到的 token |
|---|---|
| 文字 | `--dsw-alias-label-primary` `-primary-foreground` `-secondary` `-tertiary` `--dsw-alias-link` `--dsw-alias-markdown-placeholder` |
| 底 | `--dsw-alias-bg-layer-1` `-layer-2` `--dsw-alias-settings-card-fill` `--dsw-alias-button-elevated-fill` `--dsw-alias-markdown-code-block` |
| 描边 | `--dsw-alias-border-l1` `-l2` |
| 交互 | `--dsw-alias-interactive-bg-hover` `--dsw-alias-button-primary-fill` `-primary-hover` |
| 状态 | `--dsw-alias-state-business-primary/-tertiary` `--dsw-alias-state-warn-primary/-secondary/-label` `--dsw-alias-state-success-primary/-secondary` `--dsw-alias-state-error-primary/-secondary` |
| 焦点 | `--dsw-focus-ring-width` `--dsw-focus-ring-color` |
| 字体 | `--dsw-font-family` `--dsw-font-s-14` `--dsw-font-s-strong-14` `--dsw-font-m-18` `--dsw-font-base-16` `--dsw-font-markdown-code` |
| 圆角 | `--dsw-radius-xs/-sm/-md/-lg` |

机器校验（自检第 1 节）：`lib/client.js` 里匹配 `#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(` 的命中数 = **0**。

### 1.6 `Builtin`：动态客户端半边的纯 JS 符号面（inspect 超时，改读 README）

client `Builtin.listBuiltins` 超时了。从 `dsh-cordis-client-runner/README.zh.md` 读到的是：

> 「浏览器半用纯 JavaScript 编写——**无 JSX、无 TypeScript、不能 import 模块**——并作为一个 **async 函数运行**。它拿到一组固定的名字——**`React`、`console`、`styles` 与 `host`**——而 `fetch`、`setTimeout` 这类浏览器全局**不可用**。返回的插件只能使用生命周期动词，以及它自己在 `inject` 里声明的服务。从已装载半调用 `host.call(method, args)` 会到达它自己的 host 半。」

也就是说 DSH 有**两种**客户端半边，机制完全不同：

| | 静态半边（我采用的） | 动态半边 |
|---|---|---|
| 声明 | `package.json` 的 `dsh.client` + `exports["./client"]` | host runner 下发定义，页面批准后装载 |
| 形式 | `window.__ModuleLoader__.load({id, factory})` 的 bundle | async 函数体（纯 JS，闭包求值） |
| 依赖 | `require()` 平台基座 | 只有 `React/console/styles/host` 四个名字 |
| 网络 | 浏览器原生 `fetch` 可用 | **`fetch` 不可用**，只能 `host.call` |
| 装载前提 | Loader 里有条目 → 扫描 `dsh.client` | 需 host runner + 用户批准一次运行 |

我选静态半边：它是"挂进设置页"的正路（`dsh-client-ui-settings-*` 全系都这么做），不依赖审批流程，而且 `fetch` 可用 —— 这正好是我要和宿主通信所需要的。**动态半边的 `styles` / `host.call` 我没实测，本实现不走那条路。**

### 1.7 `Service`（客户端有哪些服务）—— inspect 超时，改从随包类型读

client `Service.listService` 超时。我不猜服务名，只用**两个有确凿依据**的服务，并用 `inject` 硬声明：

| 服务 | 提供者 | 依据 |
|---|---|---|
| `slots` | `@deepseek-ai/dsh-client-ui-renderer` | `lib/types/client/registry.d.ts:27` `interface Context { slots: SlotRegistry }` |
| `locale` | `@deepseek-ai/dsh-client-locale` | `lib/types/client/index.d.ts:57-60` `interface Context { locale: LocaleRuntime }` |

`ctx.locale` 的面（同文件）：
```ts
class LocaleRuntime {
  register<N>(ns: N, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>): () => void   // :199 类型化、必须双语齐全
  register(ns: string, locale: string, dict: LocaleDict): () => void                // :209 单语言、无类型（我用这个）
  bind(ns): Translate                                                              // :219/:226
  getSnapshot(): LocaleSnapshot          // { active, locales, revision }            // :136
  subscribe(fn): () => void                                                         // :144
  setLocale(id) / addLanguage(input)
}
```
`Translate<K> = (key: K, params?: Record<string, unknown>) => string`（`dsh-client-ui-slots/lib/types/index.d.ts:45`），`{name}` 模板参数。`bind` 的注释还写明「reads the active locale at call time」，所以我只在 `apply` 里 bind 一次，靠把 `locale.revision` 计进 store 快照来触发重渲染。

**我用的是无类型的单语言形式** `register(ns, 'zh', dict)` / `register(ns, 'en', dict)`，因为命名空间并入 `LocaleNamespaceMap` 是 TypeScript 声明合并，手写 JS bundle 做不到。

### 1.8 任务书里一处需要纠正的事实：`dsh-whale-widget` **不是**客户端半边插件

任务书让我照 `dsh-whale-widget` 学「怎么声明 `dsh.client`、怎么拿到 slot、怎么用主题 token」。我读了它，结论是**它这三件事一件都没做**：

```
Get-Content dsh-whale-widget/package.json -Raw
→ "main": "lib/index.js"
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }      ← 没有 dsh.client
```
它的 UI 是"宿主插件往页面里塞一个脚本"：
```
dsh-whale-widget/lib/index.js:3941   ctx.webServer.tapIndex((html) =>
                                       html.replace('</body>', '<script defer src="/dsh-whale/widget.js"></script></body>'))
dsh-whale-widget/lib/index.js:628    root.inject(['webServer','credentials','connection'], (ctx) => { … })
dsh-whale-widget/lib/index.js:755    function registerRoute(route) { … return ctx.webServer.register(wrapped) }
```
它**能跑**，而且它的 `registerRoute` 与我从 host Inspect 查到的 `webServer.register({kind,path,handler})` 完全吻合 —— 这反过来印证了 §1.2 的契约。但它不是"客户端插件怎么写"的样例：没有 `dsh.client`、没有 `ctx.slots`、没有主题 token。所以**我没有照它做**。它另一处有价值的实测结论我采纳了：**对象级 `inject` 会把整个 `apply()` 推迟到服务就绪之后，任何一个服务缺失都会让插件完全不 apply** —— 这正是宿主半边（`lib/index.js` 顶部注释）也引用的那条。

---

## 二、挂载点选择与理由

**选定：`settings.section`**（`id: "prompt-adapt"`, `order: 40`）。

理由，逐条对着契约原文：

1. **`settings.general.item` 在设计上就装不下这个东西。** 它的 owner props 是 `{ children?: never }`，契约注释直接写明 *"the owner passes no props at all"*、*"the section column only stacks rows"* —— 它是一个**单行偏好项**的座位，契约里举的例子全是 Language / Appearance / 字号。而我的界面有：互斥模式选择器 + 只读画像（4 个分类、每条带证据量）+ 多行文本框 + 修订提示 + 重新生成 + 外链，共 6 个卡片。塞进一行是不可能的。
   同一段注释还给出了明确的分流判据：*"the additive seat for a single setting that needs no page of its own (**a whole page is `settings.section`**)"* —— 我这个就是"needs a page of its own"。

2. **`settings.section` 提供的正是我需要的三样东西**：`id`（导航键，也驱动 `only` 过滤）、`order`（导航位置）、`label`（注册方本地化的显示文字），并且会渲染成一个**独立设置页**（内容列）。它还给我一个 `close()`（`SettingsSectionOwnerProps`），我现在用不到，但接收了。

3. **必须用 `slots.inject` 而不是直接 `register`。** 声明归属外壳 `ui-settings-general`（§1.3c 的 `client.js:1136` 证据）。`SlotRegistry.register` 的文档写明「registering into an undeclared slot throws」——硬失败。而 `slots.inject` 的文档写明「runs synchronously when the declaration already exists; otherwise it runs inside the declaring register() call」，且「The controller belongs to the caller's fiber」——所以等待、注册、卸载清理都由我的 fiber 托管。这正是随包插件的写法（§1.3d）。

4. **不会撞车。** list 槽位是**按 `id` 分格**的（`entriesOfSlot` 的文档：list — one cell per `id`），我的 `id: "prompt-adapt"` 唯一，所以 `order` 只影响显示次序，不存在"同格抢占"。`order: 40` 是为了排在已发布的分区之后（`settings.section` 现有注册者里 `plugins` 用 15）。这一条**是我随手取的，可以改**（见 §六）。

5. **注册时不声明 `locale:` 选项。** 随包插件用 `locale: NS` 让框架合成 `t` 座位，但那要求命名空间在 TypeScript 的 `LocaleNamespaceMap` 里做声明合并 —— 手写 JS 做不到，而且它会和我 inject 面里的 `t` 撞名。我改为**自己 bind 并通过 inject 面传 `t`**，同时把 `locale.revision` 计进 store 快照来触发语言切换重渲染。行为等价，且不依赖类型合并。

---

## 三、与宿主侧的接口契约

### 3.0 现状：宿主**服务 + HTTP 传输都已实现**，并且双方已经对着跑通

宿主半边（另一个代理）实现了一个 cordis 服务（`lib/index.js`）：
```js
class PromptAdaptService extends Service { constructor(ctx, host) { super(ctx, 'promptAdapt') } }
```
它有我需要的全部方法：`getState / setMode / setCustomText / setAutoExtraText / markCopied / regenerateNow / rescanNow / getPromptHallUrl / getSignals / getSessionSignals / clearProfile / onchange / validate`。

服务只在宿主进程内，浏览器够不到 —— 这一点宿主侧也知道，于是它补了 `lib/http.js`，用**一条 prefix 路由**（理由写在该文件顶部：五条 exact 要占五个路径，而一条 prefix 只占一个、且不可能撞车）把它暴露出来：

```js
export const API_PREFIX = '/dsh-prompt-adapt/api'     // lib/http.js:42
const disposer = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
```

**验证方式不是读代码，是跑集成测试**（`tools/calibrate.mjs` 第 7 节）：我把 `registerRoutes({root, service, log})` 挂到假 webServer 上，再把客户端的 `fetch` 接到那个 handler；宿主侧那段代码是真的，只有 service 是最小假实现。跑出来 21 条断言全绿，包括 `POST /mode` 真的改到了宿主状态、`PUT /custom` 真的写进了宿主、`POST /copied` 的结构化 `entries` 真的被宿主收下、非法 mode 被宿主回 400、未知路径回 404。

### 3.1 端点表（宿主已实现的**实际**行为）

| 方法 | 路径 | 请求体 | 响应 | 备注 |
|---|---|---|---|---|
| `GET` | `/state` | — | `200 {contract:1, ...getState(), hallUrl}` | `hallUrl` 未配置时是 **`null`**，不是空串 |
| `POST` | `/mode` | `{"mode":"auto"\|"custom"}` | `200 {ok,mode,state}` | 非法值**在写入之前**就回 400 |
| `PUT` | `/custom` | `{"text":"…"}` | `200 {ok,length,state}` | 文本上限 200000 字符，body 上限 1MB |
| `POST` | `/regenerate` | `{}` | **`202`** `{ok,started,message}` | **立刻返回**，生成在后台跑 |
| `POST` | `/copied` | `{text,entries,algorithmVersion}` | `200 {ok,copiedSnapshot}` | `at`/`profileVersion` 由**宿主**决定，不采信客户端 |
| `POST` | `/rescan` | `{}` | `202 {ok,started}` | 客户端**目前不调用**（见 §6.1 第 10 条） |
| `GET` | `/`（前缀根） | — | `200 {plugin,contract,prefix,endpoints[]}` | 自检入口 |

### 3.2 三个我照着宿主实现**改过客户端**的地方

这三处是我先写了契约、宿主实现后双方不一致、我这边对齐的。记下来因为它们都是真坑：

1. **`/regenerate` 回 202 而不是 200。** 客户端的 `requestJson` 只认 `2xx`，所以 202 天然被当成功 —— 但**不能等 POST 返回结果**：宿主立刻返回，生成在后台。我最初写的是"POST 完刷新一次状态"，那样用户点了按钮以后界面**永远不会自己变**（宿主 `getState()` 里没有 `running` 字段可轮询）。
   → 补了一个**有限期观察者**（`createAdaptStore` 里的 `watcher`）：记下触发前的 `profile.version` / `profile.generatedAt` / `lastRun.at`，每 3s 轮询一次，任一变就收工；**但至少看满 2 个 tick**（万一宿主在生成**开始时**就写 `lastRun.at`，第 1 个 tick 会误判成"已完成"）；上限 100 tick（= 5 分钟，与宿主 `profile.timeoutMs` 默认 300s 对齐）。按钮显示"生成中…"并禁用，另外给一行"生成已在后台开始，完成后这里会自动更新"。
   轮询间隔可以被 `globalThis.__DSH_PROMPT_ADAPT__.pollMs` 覆盖（自检用它把 3s 压到 20ms）。
   集成测试里断言了：202 被当成功 → 进入"生成中" → 版本变化后自动退出 → **退出后不再轮询** → **卸载后轮询被清掉**。

2. **`algorithmVersion` 必须是字符串。** 宿主 `markCopied(text, extra)` 里写的是
   `algorithmVersion: typeof extra?.algorithmVersion === 'string' ? extra.algorithmVersion : null`。
   我原本用数字 `1`，会被宿主**静默丢成 `null`**，跨浏览器那条路就断了。
   → 客户端改成字符串 `"1"`，比较时两边都 `String()` 归一（所以旧客户端传数字也不会误判成"基线过期"）。集成测试里专门断言了宿主存下来的是 `'1'`。

3. **`hallUrl` 未配置时是 `null`。** 宿主把 `PROMPT_HALL_URL` 从最初的 `.invalid` 占位符改成了空串 `''`（`lib/hall.js:25`，注释写明「真实地址用户尚未提供，所以这里保持占位」），未配置时 `GET /state` 返回 `null`。
   → 客户端的 `resolveHallUrl` 只接受非空**字符串**，`null` / `''` / `.invalid` / `.test` / `.example` 一律视为未配置 → 显示"外链地址尚未配置"而不是死链。集成测试里断言了 `resolveHallUrl(state) === ''`。

### 3.3 `GET /state` 响应字段表（客户端读什么、缺了会怎样）

`state` 就是宿主 `service.getState()` 的返回，外面包一层 `{contract, hallUrl}`。

| 字段 | 类型 | 用途 | 缺失时的行为 |
|---|---|---|---|
| `contract` | `number` | 契约版本，仅显示 | 不显示版本行 |
| `mode` | `"auto"\|"custom"` | **互斥的唯一真相**。选择器高亮、"当前生效：X"、两个面板的「生效中/未生效」徽标全由它驱动 | 一律按 `"auto"` 处理（与宿主 `emptyState()` 默认一致），绝不出现"两个都高亮" |
| `customText` | `string` | 模式 2 文本框的**服务端值** | 视为 `""` |
| `profile` | `object\|null` | 模式 1 的画像 | `null` → 显示"画像还没生成" |
| `profile.version` | `number` | 显示 `v7`；进复制快照；**也是观察者的完成判据之一** | 不显示 |
| `profile.generatedAt` | `number`(ms) | **"上次更新时间"**；观察者判据之一 | 显示"还没有生成过画像" |
| `profile.evidenceMessages` | `number` | **"画像基于 N 条发言"** | 不显示该段 |
| `profile.entries[]` | `array` | 画像条目（下面单列） | 按空处理 |
| `profile.notes` | `string` | 折叠的"归纳备注" | 不渲染 |
| `profile.raw` | `string` | 折叠的"模型原始输出（排障用）" | 不渲染 |
| `autoExtraText` | `string` | 模式 1 里只读展示的"补充说明" | 不渲染该块 |
| `copiedSnapshot` | `object\|null` | 修订比较的**宿主侧**基线 | 退到 localStorage 基线 |
| `lastGeneration` | `object` | 透传，未渲染 | — |
| `lastSignals.totals` | `object` | 四个计数信号卡片 | 整块不渲染 |
| `lastRun` | `object` | "上次生成"卡片 + 措辞抖动率；观察者判据之一 | 整块不渲染 |
| `effectiveText` | `string` | **模式 1 生效时**它就是画像全文（+补充说明），复制按钮优先用它 | 退到客户端本地重建（与宿主 `renderProfileText` 同格式） |
| `hallUrl` | `string\|null` | 模式 3 的外链 | `null` → 显示"尚未配置" |
| `running` | `boolean` | **宿主目前不提供**。若将来提供，客户端会尊重它（`true` 时轮询，`true→false` 时立刻收工） | 视为不存在，改用上面的观察者判据 |
| `staleCopy` | `boolean` | 宿主的粗粒度"复制后变过"标志 | **故意不使用**，见 §5.4 |

**`profile.entries[]` 字段表**

| 字段 | 类型 | 界面用途 |
|---|---|---|
| `id` | `string` | **修订比较的身份键**（宿主提示词要求跨版本沿用 id）。也用作 React key |
| `category` | `"A"\|"B"\|"C"\|"D"` | 归入哪个分组。非 A/B/C 一律归入 D 组 |
| `claim` | `string` | 条目正文 |
| `evidence` | `string[]` | **修订比较的主判据**（见 §五） |
| `confidence` | `"high"\|"medium"\|"low"` | 显示"置信度 高/中/低" |
| `evidenceQuoteCount` | `number` | 显示"引文 M 处" |
| `lastEvidenceMessages` | `number` | **显示"基于 N 条发言"**（需求里的"证据量"） |
| `firstSeenAt` / `lastSeenAt` / `timesSeen` | `number` | 暂未渲染（留给以后做"这条跟了多久"） |

**`lastSignals.totals` 字段表**（就是任务里说的"四个计数信号"，宿主 `signals.js` 已实现）

| 字段 | 中文含义 | 界面标签 |
|---|---|---|
| `delegateRuns` | 「让你代跑」：AI 消息含"需要你/请你/你自己"且该轮 toolCalls==0 | AI 把活推回给你 |
| `longTools` | 「命令失控」：单次工具调用墙钟超阈值（默认 60s） | 命令失控（超时） |
| `repeatFailures` | 「工具反复失败」：同一工具连续失败 ≥3 次 | 同一工具反复失败 |
| `freeformAnswers` | 「给了选项但用户自己另说」 | 给了选项你却自己另说 |
| （另有 `sessions` / `humanMessages` / `unpairedToolResults`） | 参与会话 / 真人发言 / 配不上调用的工具结果 | 同左（共渲染 6 个格子） |

**`POST /copied` 请求体 = 复制基线快照**（宿主**已实现**接收 `entries` + `algorithmVersion`）

```jsonc
{
  "text": "复制出去的画像全文",
  "entries": [ /* profile.entries 的完整数组，可能为 null */ ],
  "algorithmVersion": "1",     // 字符串！
  "at": 1760000000000,         // 客户端也发，但宿主不采信（自己的时钟为准）
  "profileVersion": 7          // 同上
}
```
宿主 `markCopied(text, extra)` 会把 `entries` 与 `algorithmVersion` 一起落进 `state.copiedSnapshot`，所以**跨浏览器/多客户端的精确比较也已经可用**。

### 3.4 桌面端（Electron）的跨源问题 —— 已实现并通过实机验证（v0.1.4）

Web 形态下页面与宿主同源，相对路径 `/dsh-prompt-adapt/api/...` 直接可用。
桌面端页面的 origin 是 `dsh-app://app/`，相对路径打不到宿主 webServer。

现在的实现分三层：

1. **宿主侧**：`apply()` 里生成一条**每次启动不同**的随机 token，通过
   `webserver/index-inject` 的 `kind:'global'` 行注入
   `globalThis.__DSH_PROMPT_ADAPT__ = { token, contract }`。webServer 就绪后再
   把真实端口补成 `apiBase`（`http://127.0.0.1:<port>/dsh-prompt-adapt/api`）。
   行必须在 apply 里同步注册 —— 桌面宿主启动时收集一次注入表，晚于那次收集
   就永远进不了表（与 dsh-whale-widget 的 #152/#153/#154 是同一时序约束）。
2. **客户端**：`resolveApiBase()` 依次读注入的 `apiBase` →
   `__DSH_TRANSPORT__.streamBaseUrl` → 同源相对路径；每个请求带
   `X-DSH-Prompt-Adapt-Token`。`requestJson()` 加了 8 秒硬超时，断连时显示
   “未连接宿主 + 重试”，不再无限 loading。
3. **HTTP 侧**：带正确 token 的请求走**凭据通道**直接放行（不再套同源判据）；
   `OPTIONS` 预检在信任栅栏之前回 204，并返回
   `Access-Control-Allow-Origin: *` / `Allow-Headers: content-type, x-dsh-prompt-adapt-token`。
   没有 token 的跨源请求仍然是 403。

**实机验证**：DSH 桌面端 0.2.1-rc.2，重启宿主后“设置 → AI 适配”能显示
104 条画像 / 注入 23 条 / 未注入 81 条，饱和提示正常。

⚠️ token 每次 apply 重新生成；插件热重载后需要刷新页面（新 token 在新注入表里）。
没有 token 的旧页面会得到 403，这是有意的 fail-closed。

---

## 四、三个模式的界面行为

整页自上而下：标题/说明 → 状态横幅（断连或预览时才有）→ **模式选择器卡片** → 模式 1 卡片 → 模式 2 卡片 → 模式 3 卡片 → 四个计数信号卡 → "上次生成"卡 → 契约版本行。

### 4.1 模式开关（互斥）—— 关键约束怎么落实

- **选择器**：一个 `role="radiogroup"` 的分段控件，两个 `role="radio"` 按钮（自动画像 / 自定义），`aria-checked` 跟随。
- **唯一真相是宿主的 `mode`**：选择器高亮、"当前生效：自动画像/自定义"（带一个绿点）、两个面板上的「生效中」/「未生效」徽标，全部由 `state.mode` 派生。客户端**不维护第二份模式状态**，所以"两个同时开启"在界面上无法表示 —— 和宿主用单字段枚举而不是两个布尔的思路一致。
- **切换提醒**：从「自定义」切到「自动画像」时，若 `customText` 非空，**不立刻发请求**，而是就地展开一个警示块：
  > **切换到「自动画像」会以模式 1 为准**
  > 模式 2 的文本会保留、不会丢，但不再注入。确定切换吗？
  > `[仍然切换]` `[取消]`
  自检里断言了「确认前没有发切换请求」。数据不会丢是宿主的保证（`setMode` 的注释：「切模式**不动**另一边的数据」），所以提醒里可以放心这么说。
- 反向（自动 → 自定义）不加确认：切到自定义只是"改用你的文本"，没有覆盖任何东西。

### 4.2 模式 1 · 自动画像（只读）

- 卡片头：`模式 1 · 自动画像` + 生效徽标 + 右侧 `复制` `重新生成`。
- meta 行：`上次更新：2026-10-12 03:11 · v7 · 画像基于 148 条发言`。没有画像时显示"还没有生成过画像"。
- **修订提示条**（§五详述）：`有 N 处修订` / `与你上次复制时一致` / `尚未记录比较基线` / `基线由旧版本算法记录，暂不比较` / `基线信息不足，暂不比较`。有修订时下面挂一个折叠的"查看这 N 处"，逐条标 `新增`/`删除`/`改写` 并列出条目正文。
- **分组**：A 稳定特质 / B 行不通的做法 / C 有效的做法 三块，各带一个彩色竖条（分别是 business / warn / success 三种状态 token）和条目计数。
- **每条条目**：正文 + 一行证据量 `基于 96 条发言 · 引文 2 处 · 置信度 高`。
- **D 证据不足**：**折叠**在 `<details>` 里（标题带条数）。见 §六第 1 条 —— 需求说三类，宿主产出四类，我选择把 D 收起来但**不隐藏**（因为它确实会进注入文本）。
- 折叠区：`归纳备注`、`模型原始输出（排障用）`；`autoExtraText` 非空时以只读块展示。
- **`复制`**：复制**画像文本**（不是"当前生效文本"）。
  - 优先用宿主的 `effectiveText`（**仅当模式 1 生效时**，此时它就是 `renderProfileText(profile) + autoExtraText`，与注入系统提示的字节一致）；
  - 否则本地按宿主 `renderProfileText` 的同格式重建（文件名头 + `【分类】` + `- claim`），保证"复制出去的文本"与"注入的文本"同构、且能被解析回条目。
  - 成功后按钮变 `已复制` 1.8 秒，并立刻上报 `/copied`（§3.4）→ 修订徽标当场归零。
  - 剪贴板优先 `navigator.clipboard.writeText`，失败退回临时 textarea + `execCommand('copy')`；两条都失败则显示"复制失败：请手动选中后复制"，**并且不记录基线**（不假装成功）。
- **`重新生成`**：POST `/regenerate`（宿主回 **202**，生成在后台跑）。触发后客户端进入"生成中"：按钮文案变 `生成中…` 并禁用，下面给一行"生成已在后台开始，完成后这里会自动更新（需要几秒到几分钟）"，同时启动**有限期观察者**（每 3s 拉一次 `/state`，`profile.version` / `profile.generatedAt` / `lastRun.at` 任一变化就收工，最多 100 次 ≈ 5 分钟）。`ctx.effect` 托管定时器，插件卸载即清（自检里有断言盯着这一条）。

### 4.3 模式 2 · 自定义

- 卡片头：`模式 2 · 自定义` + 生效徽标 + 右侧 `从模式 1 填入` `保存`。
- **多行文本框**：`min-height: 180px`、可垂直拉伸、`spellcheck=false`、有 label（视觉隐藏）、placeholder 说明"可以先从模式 1 复制画像，粘贴进来再改"。
- 文本框下方左侧 `N 字`，右侧状态徽标：`有未保存的修改`（warn）或 `已与宿主同步`（ok）。
- **保存是显式的**，不逐键自动写盘。只有脏了才可点。保存成功后重新拉状态。
- **`从模式 1 填入`**：
  - 文本框为空 → **一次点击直接填**（零摩擦，这就是需求说的"要点一下才填，不自动覆盖"）；
  - 文本框非空 → 先弹确认 `填入会覆盖当前文本框内容` / `当前内容还没被覆盖，确认后才会替换。` + `[确认填入]` `[取消]`。**绝不静默覆盖**。
  - 填入的是**画像文本**，不是宿主的 `effectiveText`。这一点是个真坑：模式 2 生效时 `effectiveText` 等于自定义文本本身，用它会把文本框内容填回自己。自检里有一条专门的回归断言（`模式 2 生效时填进来的是画像文本，不是自定义文本本身`）。
- **模式 1 生效时文本框仍然可编辑**，只是卡片加 `未生效` 徽标并把底色降一级。理由：需求描述的流程是"从模式 1 复制 → 切过去 → 粘贴 → 改"；如果禁用，用户就必须先切换才能准备内容。**这是我主动做的取舍**（§六）。
- 模式 1 没有画像文本时，`从模式 1 填入` 禁用并给一行说明。

### 4.4 模式 3 · 提示词大厅

**就是一个外链**，字面意义上的：

```js
jsx("a", { className:"pa_link", href: hallUrl, target:"_blank", rel:"noopener noreferrer",
           children: t("hallLink") })   // 「查看网友提示词 ↗」
```
- **不抓取**：客户端所有请求都在 `/dsh-prompt-adapt/api/*`。自检里有一条断言：所有请求 URL 里都不含外链域名。
- **不缓存、不鉴权、不显示内容**：没有 iframe、没有 fetch、没有预览、没有 favicon、没有 title 抓取。
- 卡片里有一行明示纪律的说明："本插件不抓取、不缓存、不鉴权、不在这里显示对方内容；点击只是新标签打开。"
- `target="_blank"` 一律带 `rel="noopener noreferrer"`（自检断言）。
- **占位地址按"未配置"处理**：宿主最初把 `PROMPT_HALL_URL` 写成 `'https://example.invalid/prompt-hall'`（`.invalid` 是 RFC 2606 保留给"永不解析"的顶级域），后来改成了空串 `''`（`lib/hall.js:25`），未配置时 `GET /state` 返回 `hallUrl: null`。客户端识别 `.invalid` / `.test` / `.example` 为占位符、并且只接受非空字符串，所以三种情形（占位域 / 空串 / `null`）都渲染成"外链地址尚未配置（需要你确认用哪个站点）"而不是给一个死链。字段名同时接受 `hallUrl` 与 `promptHallUrl`。

---

## 五、变更提示的比较策略

目标：**"有 N 处修订"，但绝不因为模型换了措辞就刷屏。宁可漏报。**

### 5.1 核心判断：中文同义改写用文本相似度**判不出来**

这是我实测出来的，不是推测。自检里就打印这个数字：

```
同义改写的字符 bigram 相似度 = 0.200
  「用户偏好简短、直达结论的回答，不喜欢铺垫。」
  「用户喜欢简洁、直接给结论的表达，不爱铺垫。」
逐字照抄的字符 bigram 相似度 = 1.000
```

用真实样本跑标定工具（`tools/calibrate.mjs --baseline a.json --current b.json`）也是同一个结论：

```
—— 如果只按文本相似度判（阈值扫描）——
  阈值   被当成"变了的条目数"   占比
  0.2      1 / 2                 50.0%
  0.3      1 / 2                 50.0%
  ...
  0.9      1 / 2                 50.0%
  逐条相似度（同 id）：
    a1               0.185      ← 同义改写，任何阈值都会误报
    b1               1.000      ← 逐字未变
```
**阈值取多少都不对**：取低，同义改写全部误报（这就是那 26.3%）；取高，连真改动也一起吞掉。所以文本相似度**不能当主判据**。

### 5.2 因此主判据是**证据**，不是文本

沿用宿主 `diffProfiles()` 的设计意图（`lib/profile.js:294-297` 的注释：「可疑变化 = `claim` 变了但 `category` 与 `evidence` 引用集合都没变 —— 模型只是换了措辞」）。因为条目有**跨版本稳定的 `id`**（宿主提示词硬性要求「沿用上一版的 id…一个字都不许改」），配对根本不需要模糊匹配。

同 `id` 的条目，`claim` 变了时：

| 条件 | 判定 | 理由 |
|---|---|---|
| `category` 变了 | **算 1 处修订** | 分类是语义，变了就是变了 |
| 两边都有 `evidence`，且集合不同 | **算 1 处修订** | 有新材料支撑 |
| 两边都有 `evidence`，且集合逐字相同 | **不算修订** | 只是换了措辞 |
| 证据不可比（缺一边/都没有） | 退到文本兜底，阈值 0.3（极低） | 只有几乎完全不同的文本才翻案 |

第三行是**压制假变化的那一刀**：证据一致时，**不给文本任何翻案机会**。`evidence` 元素是模型给的原文片段或发言编号，逐字照抄时完全一致，所以 `jaccard(evidence集合) ≥ 0.999` 就判"没变"。

### 5.3 另外三道保守闸门

1. **全局闸门**：两版画像的归一化 token 集合 Jaccard ≥ **0.90** → 直接判 0 处。整页只是措辞抖动时，连逐条比较都不做。
2. **纯文本基线 → 不猜**：如果基线只有文本（没有结构化 `entries`），中文改写判不出来，所以**不编数字**：`count = 0` + 状态 `low-confidence`，界面明说「上次复制时只记了文本、没记结构化条目…已按"宁可漏报"处理：这里不报修订数。再复制一次即可启用精确比较。」——**宁可说"我不知道"，也不给一个假数字。**
   宿主**已经**会把 `entries` 一起存进 `copiedSnapshot`（§3.2 第 2 点），所以这条路只在"读到的是升级前记下的旧基线"或"客户端与宿主都拿不到结构化条目"时才会走到。
3. **算法版本闸门**：快照里带 `algorithmVersion`。版本不一致 → 状态 `stale-baseline`，count 0（不跨算法比较）。

### 5.4 其他会制造假修订的坑，逐个堵掉

| 坑 | 处理 |
|---|---|
| 证据量写进条目正文（"…（基于 37 条发言）"） | 归一化时先剥掉 `（基于 N 条发言）` / `(based on N…)` / `N 条发言` 这类噪声，再比 |
| 标点/空格/全半角/大小写差异 | NFKC + 转小写 + 剥中英标点 + 折叠空白 |
| 虚词与模糊限定词 | 剥掉一个明确列表（通常/一般/可能/比较/倾向/usually/generally/quite…），只收真正的填充词 |
| **只看证据量变化**（`lastEvidenceMessages` 变了） | 完全不参与判定。证据量是元数据，不是内容 |
| 模型把 id 重命名（内容没动） | `reconcileIdChurn`：把"删掉的"和"新增的"按 claim 相似度 ≥ 0.8 配对，算成 `renames` 而**不是**"1 删 + 1 增 = 2 处" |
| 当前画像为空（还没生成过） | 状态 `empty-current`，count 0（不刷"删了 N 条"） |
| 宿主 `getState()` 里的 `staleCopy` | **故意不使用**。它就是文本不等比较（`copiedSnapshot.text !== effectiveText`），正是会造成 26.3% 假修订的那个信号。用了等于把噪声请回来 |

### 5.5 自检里针对这一节的全部断言（都通过）

```
✓ 修订数 = 2（1 处改写 + 1 处新增；换措辞的那条不算）
✓ 被压掉的是 b1（同证据、只换措辞）
✓ 改写那条的判据是 evidence 而不是 text
✓ 同 id 同证据只换措辞 → 0 处
✓ 只换了 id、内容一样 → 0 处
✓ id 抖动 + 1 处真改写 → 只报 1 处（不把改名算成增+删）
✓ 纯文本基线 → status = low-confidence 且不报数字
✓ 旧算法基线 → status = stale-baseline 且 count = 0
✓ 没有基线 → status = no-baseline 且 count = 0
✓ 当前画像为空 → count = 0（不刷"删了 N 条"）
✓ 复制之后修订归零
✓ 同义改写的文本相似度确实很低（< 0.30）—— 证明文本判据会误报
```

### 5.6 基线存哪：两个地方都写，本地优先

用户点「复制」时，客户端**同时**写 `localStorage`（`dsh-prompt-adapt:copied:v1`）和上报宿主 `/copied`。读取优先级：

```
localStorage 的结构化 entries  →  宿主 copiedSnapshot.entries  →  宿主 copiedSnapshot.text（→ 降级为不比较）
```

宿主现在已经会保存 `entries`，所以两条路都能走精确比较；本地优先的好处是"同一个浏览器里刚复制完就立刻生效"，不依赖一次网络往返。`localStorage` 不可用（隐私模式/配额）时静默降级到宿主基线，不报错。

---

## 六、未完成 / 不确定 / 需要用户拍板的部分

### 6.1 需要你拍板的（按重要性排）

1. **三个分类还是四个？** 需求写「分三类展示：A 稳定特质 / B 行不通的做法 / C 有效的做法」，但宿主产出**四类** —— 多一个 `D 证据不足（不下结论）`（`lib/profile.js:38-45`），而且 D 类的条目**也会进注入文本**（`renderProfileText` 里 D 也照样输出）。
   我现在的做法：A/B/C 常驻三块，D 折叠在 `<details>` 里（带条数），**不隐藏**。
   需要你定：D 是该完全不显示，还是像现在这样收起来，还是干脆和 A/B/C 平级？

2. **分类标题的语言**。为了让"复制出去的文本"与"注入系统提示的文本"字节同构、并且能被解析回条目（这是纯文本基线兜底的前提），我在**两种界面语言下都用宿主的中文标题**（稳定特质 / 行不通的做法 / 有效的做法 / 证据不足（不下结论））。后果：**英文界面下画像区仍然是中文小标题**。
   替代方案是界面本地化标题、复制时再翻译回中文 —— 那会让"界面看到的"和"复制到的"不一致。需要你选。

3. **模式 3 的真实地址**（**仍然需要你给**）。宿主已经把它改成空串占位（`lib/hall.js:25` `export const PROMPT_HALL_URL = ''`，注释写明「真实地址用户尚未提供」），未配置时 `GET /state` 返回 `hallUrl: null`，我的界面据此显示"外链地址尚未配置（需要你确认用哪个站点）"。
   **你需要给一个真实站点**：改 `lib/hall.js` 的常量，或注入 `globalThis.__DSH_PROMPT_ADAPT__.hallUrl`（客户端三个来源都认）。

4. **`autoExtraText` 目前是个死字段**。宿主支持它（`setAutoExtraText`）且它参与生效文本，但需求说模式 1 只读，所以我只**只读展示**它 —— 现在系统里没有任何入口能设置它。
   需要你定：给个小编辑框（那模式 1 就不再是纯粹"只读"了），还是让宿主删掉这个字段？

5. **"N 处修订"的粒度**：我现在按**条目数**算（1 条 = 1 处）。一条 claim 里改了半句也算 1 处；两条被模型合并成一条会显示 2 处（1 删 + 1 改）。你要的"处"是这个意思吗？还是想按"字/句"算？

6. **`lastEvidenceMessages` 的语义确认**。"基于 N 条发言"我用的是这个字段。但宿主是**故意**让逐字未变的条目**继承**上一版的值、不刷新为本次材料规模（`lib/profile.js:228-241` 的注释：「否则"基于多少条发言"会随着每轮重新生成而虚增，失去意义」）。所以界面上的 N 是"**最近一次变化时**的材料规模"，不是"当前累计材料量"。界面文案我写的是"基于 N 条发言"——如果你要的是"当前累计"，那应该换成 `profile.evidenceMessages`（本次材料规模）或 `lastSignals.totals.humanMessages`（累计真人发言）。

7. **基线的归属**（**宿主已按建议实现**，此项已解决）。宿主的 `markCopied(text, extra)` 现在会保存 `entries` 与 `algorithmVersion`，所以"在 A 浏览器复制过，B 浏览器也认"已经成立。客户端仍保留 localStorage 作为第一优先（同一浏览器内零往返），两者不冲突。

8. **`order: 40`** 是我随手取的（为了排在已发布分区之后），你要放别的位置直接改常量。

9. **两个模式面板都常驻**（不做 tab 切换）。好处是"复制 → 粘贴 → 改"这条流不用来回切面板；代价是页面很长（6 张卡片）。如果你更想要紧凑的 tab 布局（像"内置插件"那一页），我可以改。

10. **`POST /rescan` 我没接**。宿主实现了这个端点（`lib/http.js:295-302`，让设置页能强制重扫会话日志），但需求里没有这个按钮，所以客户端不调用它。如果你希望"四个计数信号"旁边有个"立即重扫"，说一声 —— 接上去只要几行（照 `/regenerate` 的 202 + 观察者模式抄）。

11. **`package.json` 的 `files` 白名单只有 `lib` / `cordis.patch.yml` / `README.md`** —— 我这边看是有意的（宿主自己的 `IMPLEMENTATION.md`、`test/` 也不在里面）。后果是：如果将来要发布这个包，`UI-IMPLEMENTATION.md` 与 `tools/calibrate.mjs` 不会被打进去。如果希望标定工具随包分发，把 `tools` 加进 `files` 即可；我没擅自改这一行。

12. **宿主 `IMPLEMENTATION.md` §8.1 把"客户端半边与宿主的联调"列为未验证项**（原文：「两边**没有**在同一进程里一起跑过」）。**这一项现在已经补上了**：我的 `tools/calibrate.mjs` 第 7 节就是把宿主的 `registerRoutes()` 挂到假 webServer、把 `fetch` 接到那个 handler 上跑的，21 条断言全绿。不过要说明边界：跑的是宿主的**路由层**（`lib/http.js`），service 仍是最小假实现；真实的 `StateStore` 落盘与 `llm.stream()` 调用没有进这个测试（那是宿主自己的 `test/httptest.mjs` 覆盖的）。

### 6.2 我做的交互取舍（如果你不同意，说一声就改）

| 取舍 | 我选了什么 | 另一面 |
|---|---|---|
| 模式 2 文本框在模式 1 生效时 | **仍可编辑**（降级底色 + "未生效"徽标） | 严格来说"未生效的东西不该可编辑"，但那样用户必须来回切面板才能准备内容 |
| 模式 2 保存 | **显式「保存」按钮** | 逐键防抖自动存更省心，但会频繁写盘、且失败时用户不知道；现在有"有未保存的修改"徽标提示 |
| 「从模式 1 填入」遇到非空文本框 | **二次确认** | 多一次点击；换来的是绝不误覆盖用户写了半天的东西 |
| 断连时 | 给「载入预览数据」但**明确标注是演示数据** | 不给预览的话界面完全看不到；给而不标注就是骗人。我选了标注 |
| 证据量显示 | 同时显示 `基于 N 条发言` + `引文 M 处` + 置信度 | 一行里信息偏密；但宿主刻意存了两个证据量字段，只用一个是浪费 |
| 修订明细 | 折叠（`<details>`），不默认展开 | 默认展开会把页面撑得很难看 |

### 6.3 未确认的接口（我**没有**猜任何一个 API 名）

| 事项 | 状态 |
|---|---|
| client `Slots.listSubTree` / `Service.listService` / `Theme.listTokens` / `Builtin.listBuiltins` 的**实际返回** | **未拿到**。14 次调用全部 10s 超时（§1.1）。改用随包 `.d.ts` / `lib/client.js` 作权威依据 |
| `ctx.remote.<ns>.<method>()` 生成式 remote 的声明方式 | **未确认，因此没有采用、也没有在代码里猜任何 remote 方法名**。宿主侧仍需自己实现传输（§3.1） |
| `dsh.client.external` 的确切解析语义 | 只从 `dsh-client-modules/README.zh.md` 得知「只添加基座之外的精确请求」。我没实测 —— 本插件 `external` 留空，只用 React 基座，所以不受影响 |
| 动态客户端半边的 `styles` / `host.call` 具体形状 | 只从 `dsh-cordis-client-runner/README.zh.md` 得知（§1.6）。本实现不走这条路，**未实测** |
| `settings.section` 的 `label` thunk 是否真的在语言切换时重读 | 依据契约注释「a thunk re-evaluated per read… follows the active locale without re-registration」**推断**，未在浏览器实测 |
| `ctx.effect(cb, label)` 的二参形式 | 依据随包 `lib/client.js` 的真实用法（`ctx.effect(() => ctx.locale.register(...), "…: section dictionaries")`）确认存在，**未实测**标签参数的语义 |
| `localStorage` 在桌面端（Electron 渲染进程）是否可用 | **未实测**。不可用时静默降级到宿主基线，不报错 |

### 6.4 验证覆盖的真实边界（别把自检当成"验收通过"）

**已经真跑过的**（145 项断言，`node tools/calibrate.mjs`，退出码 0）：
- `lib/client.js` 能被当 ES 模块载入、`window.__ModuleLoader__.load` 被调用、factory 执行、CSS 真的注入、导出面齐全；
- 全部纯函数与比较逻辑的行为；
- 用假 ctx 调 `apply()`，捕获它向 `settings.section` 注册的选项与组件；
- 用**迷你 React**（`useState/useRef/useEffect/useId` 的最小实现，支持 setState 重渲染 + 订阅 store 重渲染 + deps 门控的 effect）真的把组件渲染一遍，并对元素树做结构断言；
- 真实交互链路：点「从模式 1 填入」→ 文本框被填；非空时先确认；点「复制」→ 上报 `/copied` → 徽标归零；切模式 → 先提醒、确认后才发请求；点「重新生成」→ 202 → 进入"生成中" → 版本变化后自动退出且停止轮询；断连 → 横幅 + 重试 + 预览；
- **与宿主 `lib/http.js` 真实路由代码的集成**（第 7 节，21 条断言）：客户端的每个请求都过一遍宿主的路径分发 / 方法校验 / body 解析 / 状态码，包括 `POST /mode` 真的改到宿主状态、`PUT /custom` 真的写进宿主、`POST /copied` 的 `entries` 与字符串 `algorithmVersion` 真的被宿主收下、非法 mode 回 400、未知路径回 404、用宿主真实响应渲染出分类与信号、卸载后轮询被清掉。

**没有验证的**（如实列出）：
- **没有真实浏览器**。环境里 `react-dom` 不存在（`react` 是指向 DSH 安装目录的 junction，`react-dom` 缺失），所以**没有跑过 `renderToStaticMarkup` 或真实 DOM 渲染**。迷你 React 不是 React：**布局、CSS 实际效果、真实事件系统、焦点管理、`aria` 的浏览器行为全都没验证**。
- **HMR 没验证**。按 `dsh-client-modules` 的说明，客户端 bundle 只有在 `pnpm run dev:web` 同时运行时才会重建并自动重载。**我不承诺"改完立刻生效"。**
- **没有把插件装进 profile**。按纪律没有执行 `dsh plugin add`。所以"Loader 能发现 `dsh.client`、bundle 能被 `/plugins/dsh-prompt-adapt/client.js` 提供、设置页导航里真的出现「AI 适配」这一项"**都没实测**。
- **没有真实画像数据**。比较逻辑用的是我构造的样本（形状照宿主 `normalizeProfile` 的产出来写），**没有拿你自己的真实画像跑过**。`tools/calibrate.mjs --baseline … --current …` 就是留给这件事的：拿两份真实画像 JSON 跑一下，如果阈值需要调，参数全集中在 `lib/client.js` 的 `COMPARE_DEFAULTS`。
- **桌面端跨源没验证**（§3.4）。
- 主题 token 只验证了"没有硬编码颜色 + 用的都是真实 token 名"，**没有验证暗色模式下的实际观感**。

---

## 七、我运行过的命令

### 7.1 加载方式（**我没有执行它**）

按纪律没有执行 `dsh plugin add`。要加载时由你决定：

```powershell
# 方式一：本地 link 安装（推荐，改完源码直接生效，不用重装）
dsh plugin --profile desktop add link:R:\dsh-prompt-adapt
# 或 web profile
dsh plugin --profile web add link:R:\dsh-prompt-adapt
```
仓库里已有宿主侧写好的 `cordis.patch.yml`（`- insert: [{id: dsh-prompt-adapt, name: dsh-prompt-adapt}]`）与 `package.json` 的 `dsh.bundle.patch`，所以这个命令会把插件插进 profile 配置树。

**宿主侧的 HTTP 路由已经就绪**（`lib/http.js`，`API_PREFIX = '/dsh-prompt-adapt/api'`，6 个端点），客户端与它已经跑过集成测试，所以装上就应该能看到真实数据。唯一还没配的是**模式 3 的外链**（`lib/hall.js` 的 `PROMPT_HALL_URL = ''`），未配置时界面显示"尚未配置"，其它功能不受影响。

**加载后需要刷新页面**（不是 HMR），因为这是新的 Loader 条目。`lib/client.js` 是已构建产物、不需要 `pnpm run build`（我是手写的，格式与随包 bundle 一致）。

### 7.2 实际运行过的命令（按时间顺序）

**查接口 / 读样例**
```powershell
# 目标目录状态（第一次是空的，后来宿主代理写入了文件）
Get-ChildItem -Force "R:\dsh-prompt-adapt\"
Get-ChildItem -Recurse -Force "R:\dsh-prompt-adapt" -File

# DSH 客户端插件包清单
Get-ChildItem "C:\Users\<用户名>\.dsh\profiles\node_modules\@deepseek-ai\" -Directory

# 读 package.json（dsh.client 声明形态）
Get-Content ...\dsh-client-ui-settings\package.json -Raw
Get-Content ...\dsh-client-ui-settings-general\package.json -Raw
Get-Content ...\dsh-client-ui-theme\package.json -Raw
Get-Content ...\dsh-client-ui-settings-plugins\package.json -Raw
Get-Content ...\dsh-whale-widget\package.json -Raw
Get-Content ...\dsh-whale-widget\cordis.patch.yml -Raw
Get-Content ...\dsh-client-modules\package.json -Raw
Get-Content ...\dsh-cordis-client-runner\package.json -Raw

# 谁注册/声明 settings.section
Select-String -Path ...\dsh-client-ui-settings-plugins\lib\client.js -Pattern 'settings\.section|slots\.inject|slots\.register'
Select-String -Path ...\dsh-client-ui-settings-general\lib\client.js -Pattern 'children:\s*\{\s*"settings\.section"|"settings\.section":\s*\{' -Context 4,6
Select-String -Path ...\dsh-client-ui-theme\lib\client.js -Pattern 'settings\.(general\.item|section)|ctx\.slots' -Context 3,12
Select-String -Path ...\dsh-client-ui-theme\lib\client.js -Pattern '^\s*const inject = |exports\.inject' -Context 0,3

# 客户端服务与槽位契约（权威 .d.ts）
Get-Content ...\dsh-client-ui-settings\lib\types\client\contract\slots.d.ts -Raw   # 用 read 工具读
Get-Content ...\dsh-client-ui-renderer\lib\types\client\registry.d.ts -Raw         # 用 read 工具读
Get-Content ...\dsh-client-locale\lib\types\client\index.d.ts -Raw                 # 用 read 工具读
Get-Content ...\dsh-client-ui-slots\lib\types\index.d.ts -Raw                      # 用 read 工具读

# 主题 token 全量提取
$raw = Get-Content ...\dsh-client-ui-theme\lib\client.js -Raw -Encoding UTF8
[regex]::Matches($raw,'--dsw-[a-z0-9-]+') | % Value | Sort-Object -Unique

# 模块系统与动态半边（README）
Get-Content ...\dsh-client-modules\README.zh.md -Raw -Encoding UTF8
Get-Content ...\dsh-cordis-client-runner\README.zh.md -Raw -Encoding UTF8

# whale-widget 到底是不是客户端插件（结论：不是）
Select-String -Path ...\dsh-whale-widget\lib\index.js -Pattern "registerRoute|tapIndex|root\.inject|ctx\.webServer"
Get-Content ...\dsh-whale-widget\lib\index.js -TotalCount 60
Get-Content ...\dsh-whale-widget\lib\index.js -Tail 40

# 宿主机 GUI 是否活着（判断 inspect 为什么超时）
Invoke-WebRequest -Uri "http://127.0.0.1:19387/" -TimeoutSec 6 -UseBasicParsing   # → 401
Get-NetTCPConnection -LocalPort 19387 -State Listen                              # → pid 40732
```

**读宿主半边（后来才出现）**
```powershell
Get-ChildItem -Recurse -Force "R:\dsh-prompt-adapt" -File | Select Rel,Length,LastWriteTime
# 用 read 工具逐份读：lib/state.js, lib/signals.js, lib/profile.js, lib/schema.js, lib/index.js
Select-String -Path "R:\dsh-prompt-adapt\lib\index.js" -Pattern "webServer|remote|register\(|/state|route"
Select-String -Path "R:\dsh-prompt-adapt\lib\index.js" -Pattern "commit|listeners|\.effect\(|runProfileGeneration"
Select-String -Path "R:\dsh-prompt-adapt\test\*.mjs" -Pattern "^import .*from\s+'([^']+)'"
```

**我的自检与标定**
```powershell
node --version                                    # v24.19.0
node "R:\dsh-prompt-adapt\tools\calibrate.mjs"    # → 通过 145 项，失败 0 项（退出码 0）

# 标定模式（用真实形状的样本对）
node "R:\dsh-prompt-adapt\tools\calibrate.mjs" --baseline "$env:TEMP\pa-calib\a.json" --current "$env:TEMP\pa-calib\b.json"
# → 现行判定 0 处修订；而"只按文本相似度"在 0.2~0.9 每个阈值都误报 50%
```
自检里同时做了机器校验（不是靠肉眼）：
```powershell
# client.js 里的硬编码颜色数（应为 0）
[regex]::Matches($raw,'#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(') | Measure-Object   # → 0
# 用到的 --dsw-* token 去重数                                              # → 37
# client.js 行数 / calibrate.mjs 行数                                      # → 2276+ / 1100+
```

**调试过程中用过的隔离探针（放在 %TEMP%，不在交付物里）**
```powershell
# 单独验证"假 webServer + 真 lib/http.js + Readable 当 req"这条链路
node "$env:TEMP\pa-calib\probe-http.mjs"
# → 200 /state、200 /mode（且真的调到了 setMode）、202 /regenerate、200 前缀根 —— 四个都通
```
这一步是必要的：第一次跑集成测试时进程挂住不退。原因有两个，都不是宿主的 bug：
① 我用 `Select-Object -Last N` 接管道，导致 PowerShell 要等进程退出才输出，所以"看不到任何输出"并不代表卡在开头；
② 报错最终定位到**我自己**的 fetch 桩里覆盖了 `req.destroy` —— 而 `Readable` 在**自然结束**时也会调用 `destroy()`（autoDestroy），于是正常请求被误判成失败。改成"挂一个 5 秒兜底超时"后正常。
另外发现一个真实问题：观察者轮询还在跑时 `setInterval` 会让 Node **进程退不出去** —— 这反过来证明"卸载必须清掉轮询"是必要的，于是我加了一条断言（`卸载后轮询被清掉`）来盯住它。

**改完 package.json 后的校验（我怕碰坏宿主的东西）**
```powershell
Get-Content "R:\dsh-prompt-adapt\package.json" -Raw | node -e "…JSON.parse + 打印关键字段…"
# → JSON OK；main=lib/index.js；exports['./client']={default:'./lib/client.js'}；
#   dsh.client={"platform":"web","inject":[...]}；dsh.bundle 保留
# 并确认宿主测试全部用相对路径 import（../lib/*.js），加 exports 不会破坏它们
```

**始终没有执行的**：`dsh plugin add` / `dsh plugin install`（按纪律，会改变用户运行环境）。
