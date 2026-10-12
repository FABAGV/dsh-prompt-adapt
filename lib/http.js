/**
 * 宿主侧的 HTTP 路由 —— 把 `promptAdapt` 服务暴露给浏览器里的设置页。
 *
 * ## 为什么必须有这一层
 *
 * `class PromptAdaptService extends Service` 只把服务挂在**宿主进程内**的
 * `ctx.promptAdapt` 上。浏览器里的设置页跟宿主不是同一个 JS realm，
 * 够不到这个对象 —— 所以没有这层 HTTP 路由时，设置页只能显示"未连接宿主"。
 *
 * ## 为什么是**一条** prefix 路由而不是五条 exact
 *
 * `webServer.register()` 的 doc 原文：
 *
 *   > Register a named route. **Duplicate (kind, path) throws** — route patterns
 *   > are a composition-level contract, so a collision is a misconfiguration.
 *
 * 五条 exact 路由要占五个路径；而一条 prefix 只占一个，且**不可能与别人撞车**
 * （前缀是插件专属的 `/dsh-prompt-adapt/api`）。
 * 代价是必须在 handler 里自己分发 —— 这反而让"方法不允许""路径未知"
 * 这类错误可以给出统一的 JSON 响应，而不是落到宿主的 404。
 *
 * 前缀匹配语义（`@deepseek-ai/dsh-host-webserver/lib/index.js:322-329`）：
 *
 *   - 先查 exact 表，未命中再在 prefix 表里找
 *   - **要求 `pathname === prefix` 或 `pathname.startsWith(prefix + '/')`**
 *   - **最长前缀胜出**
 *
 * ⚠️ 因为第二条，`/dsh-prompt-adapt/api`（不带尾斜杠）**不会**命中本路由，
 * 会落到宿主的 fallback（通常是 SPA 的 404）。所以下面用 `PREFIX` 常量统一
 * 拼子路径，**不要**手写这个裸路径去请求。
 *
 * ## 降级
 *
 * `webServer` 一律用 `ctx.get('webServer')` **可选**读，拿不到就返回 `null` 并记一条
 * warn，插件其余功能（扫描、画像、注入）完全照常 —— 只是设置页读不到数据。
 *
 * ⚠️ 但**调用时机在 `lib/index.js` 那边**：`webServer` 是宿主启动时才就绪的服务，
 * 而本插件没有对象级 inject（理由见 `lib/index.js` 顶部与注册点，
 * 以及 `dsh-whale-widget/lib/index.js:604-609`），所以 apply() 跑得比它早。
 * 本模块的"拿不到就 null"只在**真正缺少该服务**时才该发生；
 * 正常宿主上是靠调用点 `root.inject(['webServer'], ...)` 局部等待就绪后调进来的。
 * 也就是说：**这个方法被调用时 `webServer` 还不存在 = 路由丢了**，
 * 所以下面那条 warn 是最后的兜底，不该在正常启动路径上出现。
 *
 * ## 信任栅栏（为什么 handler 一进来先判来源）
 *
 * 本前缀**不在**宿主 `/api` 的 FetchHandler 里 —— 那条 browser-trust 栅栏是
 * `@deepseek-ai/dsh-client-connection` 的 `isTrustedApiRequest()`，只作用于宿主
 * 自己注册的 `/api`，**不会**作用到这条自建 prefix 上。
 * 未加本节栅栏时实测：无任何凭据的 `GET /dsh-prompt-adapt/api/state` 回 **200**
 * （响应里带完整画像与注入文本），`POST .../api/mode` 回 **400** ——
 * 后者说明请求**已经进了业务逻辑**，只是参数不合法。
 *
 * 风险不是"数据出本机"（它确实不出），而是**免鉴权的写入通道**：
 * `POST /mode`、`PUT /custom`、`POST /entry/*` 都是"简单请求"（POST/PUT +
 * `text/plain` 不触发 CORS 预检），用户浏览器里打开的**任意网站**都能发出去；
 * 而写进去的内容**会被注入系统提示** —— 等于一条 prompt injection 入口，
 * `/regenerate` 还能替用户烧 LLM 额度。
 *
 * 判据照宿主那一套，但**自己实现**（不 import `dsh-client-connection`：它没导出
 * 可用的判据函数，且会给插件加一个宿主版本耦合）。逐条：
 *
 * 1. **`sec-fetch-site: cross-site` 一律 403**。这个头由浏览器自己写，页面脚本改不了
 *    （Fetch Metadata 属于 forbidden header），是最硬的一条判据。
 * 2. **带 `Origin` 就必须与 `Host` 同源**：两侧都过 WHATWG `new URL()` 归一化后比
 *    `host`（大小写、默认端口都由 URL 处理），不等或解析失败 → 403。
 *    跨源简单请求浏览器**必带** `Origin`，所以这一条正好覆盖"恶意站点直接发简单请求"
 *    这个主路径。
 * 3. **带 `sec-fetch-site` 但值不是 `same-origin`/`none` → 403**（`same-site` 这种
 *    "同站不同源"也拒）；**写方法**（POST/PUT/PATCH/DELETE）**带 `sec-fetch-site`
 *    却缺 `Origin`** → 403 —— 浏览器对写请求一定带 `Origin`，缺失说明这不是浏览器的
 *    真实请求。
 *
 *    ⚠️ 这条**只认 `sec-fetch-site`，不认任意 `sec-fetch-*`**，理由有实测：
 *    Node 的 `fetch()`（undici）**每个**请求都带 `sec-fetch-mode: cors`，却既不带
 *    `sec-fetch-site` 也不带 `Origin`（起一个 http server 打印 `req.headers` 即可复现）。
 *    它属于第 4 条要放行的非浏览器客户端；若把"任一 `sec-fetch-*`"当成浏览器指纹，
 *    `test/httptest.mjs` 与 `test/marks-guard.mjs`（都用 Node fetch 打真实路由）
 *    的**所有写请求**会被 403 —— 实测过，就是这条把回归闸门打红的。
 *    真实浏览器对写请求**同时**带 `sec-fetch-site` 与 `Origin`，所以只认
 *    `sec-fetch-site` 一条都不漏。
 * 4. **非浏览器客户端放行**：既不带 `sec-fetch-site`、也不带 `Origin` 的请求
 *    （curl、本机脚本、CLI、只有 `sec-fetch-mode` 的 Node fetch）**不判来源**。
 *    这是**刻意的取舍**：本机同用户进程本来就能直接改 `state.json`，
 *    插件伪造一层"我挡住了本机"没有意义；这里要挡的只是**浏览器跨站**。
 *
 * 403 一律走 `sendJson`，只回一句固定文案，**绝不回显请求头原文或任何凭据**——
 * 把来源头/主机头的内容回显出去等于给探测者一个免费的 oracle。
 * 文案里连 `sec-fetch` / `origin` 这些**头名**都不出现（只说"来源标记""来源"），
 * 这样"响应体里搜不到任何请求头痕迹"是一个可以直接断言的性质。
 *
 * ⚠️ **挡不住谁**（已知局限，写在这里免得被当成"已经安全了"）：
 *
 *   - **挡不住本机进程**：见第 4 条。同用户下任何进程都能直接改 `state.json`。
 *     这条栅栏**不是鉴权层**（宿主 `/api` 那层还有"可信但未认证 → 401"，本插件
 *     没有凭据体系）。
 *   - **挡不住 DNS rebinding**：宿主那条栅栏额外要求 `Host` 是 loopback 或配置里的
 *     trusted 权威，所以 rebinding（页面在 `attacker.example`、DNS 指向 127.0.0.1）
 *     会在 Host 那一关被拒。本插件**没有** `trustedHosts` 配置，也不该假定只在
 *     本机服务，所以第 2 条只比"Origin 与 Host 是否一致"——同一个域名下的 rebinding
 *     页面这两者天然一致，**能过**。要补这一条得先有"本插件的可信权威"配置，
 *     超出本次范围。
 *   - **挡不住已被注入的同源脚本**：同源 XSS 在栅栏眼里就是"自己人"。
 *   - **桌面壳（`dsh-app://app/`）那条注入 `apiBase` 的路径会被挡**：跨 scheme 请求的
 *     `sec-fetch-site` 就是 `cross-site`（第 1 条），而 `Origin: dsh-app://app`
 *     也不可能等于 `Host: 127.0.0.1:<port>`（第 2 条）。宿主自己的 `/api` 栅栏同样如此。
 *
 * ## content-type 刻意不校验
 *
 * handler 与 `readJsonBody()` 都**不看** `content-type`，直接 `JSON.parse` body。
 * 这是刻意的：客户端的 `fetch` 会带 `application/json`，而要防的"简单请求"恰恰是
 * `text/plain` —— 那种请求必须在**栅栏那一层**被 403，而不是靠"content-type 不认识
 * 于是解析失败"这种副作用拒掉（`text/plain` 的 body 一样可以是合法 JSON）。
 * 松着收下 body 也让 curl/脚本这类非浏览器调用方不必多带一个头。
 */
import { PROMPT_HALL_URL } from './hall.js'

/** 本插件独占的 HTTP 前缀。最长前缀胜出，所以不会与别的插件冲突。 */
export const API_PREFIX = '/dsh-prompt-adapt/api'

/** `PUT /custom` 的文本上限（UTF-16 码元数）。 */
export const MAX_CUSTOM_TEXT_CHARS = 200_000

/** 请求体字节上限。比字符上限宽裕，因为 UTF-8 一个汉字占 3 字节。 */
export const MAX_BODY_BYTES = 1_000_000

/** 单次请求体读取的硬超时（毫秒）。防止半开连接把请求挂住。 */
const BODY_TIMEOUT_MS = 10_000

/**
 * 允许的 mode 取值。与 `lib/state.js` 的 `MODE` 同源，这里再列一次是为了
 * **在任何写入之前**就拒掉非法值，而不是等 `setMode()` 抛错。
 */
const ALLOWED_MODES = new Set(['auto', 'custom'])

/**
 * 写方法集合。浏览器对这些方法**一定**带 `Origin`（读方法同源时反而不带），
 * 所以"浏览器的写请求却没有 Origin"是可判定的异常 —— 见模块顶部栅栏第 3 条。
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * `sec-fetch-site` 的放行值。
 *   - `same-origin` = 设置页自己发起的同源请求（正常路径）
 *   - `none` = 用户直接在地址栏敲/点书签进入（浏览器仍会带这个头，但没有来源站点）
 * 其余值（`same-site` / `cross-site`）都不是"同源设置页"，一律拒。
 */
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'none'])

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // 设置页与宿主同源，但显式关掉缓存避免读到旧的画像
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 读请求体并解析 JSON。
 *
 * 三重保护（设置页是**本机**界面，但仍然不该信任它的输入）：
 *   1. 声明了 `content-length` 且超限 → 立刻 413，**不读**body
 *   2. 实际读到的字节数超限 → 中止并 413（防 `content-length` 撒谎）
 *   3. 读取超时 → 408（防半开连接挂住 handler）
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<{ok:true, value:any} | {ok:false, status:number, error:string}>}
 */
function readJsonBody(req, limit) {
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.resolve({ ok: false, status: 413, error: `请求体过大（声明 ${declared} 字节，上限 ${limit}）` })
  }

  return new Promise(resolve => {
    const chunks = []
    let received = 0
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      resolve(result)
    }

    const timer = setTimeout(() => {
      // 半开连接：不再等待，按超时处理
      req.destroy?.()
      finish({ ok: false, status: 408, error: '读取请求体超时' })
    }, BODY_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    const onData = (chunk) => {
      received += chunk.length
      if (received > limit) {
        req.destroy?.()
        finish({ ok: false, status: 413, error: `请求体过大（已读 ${received} 字节，上限 ${limit}）` })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) {
        finish({ ok: true, value: {} })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(text) })
      } catch {
        finish({ ok: false, status: 400, error: '请求体不是合法 JSON' })
      }
    }
    const onError = (error) => {
      finish({ ok: false, status: 400, error: `读取请求体失败：${error?.message ?? error}` })
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/**
 * 只取字符串字段，并裁到上限。非字符串一律当缺省处理。
 * @param {any} value
 * @param {number} max
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
function asText(value, max) {
  if (value === undefined || value === null) return { ok: true, value: '' }
  if (typeof value !== 'string') return { ok: false, error: 'text 必须是字符串' }
  if (value.length > max) {
    return { ok: false, error: `text 过长（${value.length} 字符，上限 ${max}）` }
  }
  return { ok: true, value }
}

/**
 * 可选的字符串字段：缺省 → `''`，是字符串 → 原样，其它类型 → `null`（= 非法）。
 *
 * 与 `asText()` 分开是因为语义不同：`id` / `claim` / `key` 都为**可选**（三个动作
 * 各自只需要其中一部分），但"给了一个数字"必须被拒掉而不是当成空串 ——
 * 当成空串会让 `id=123` 这种客户端 bug 变成"找不到条目"这种含糊的 409。
 * @param {any} value
 * @returns {string|null}
 */
function asOptionalText(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : null
}

/**
 * 取一个请求头的字符串值。
 *
 * Node 对重复头通常已经合并成 `'a, b'`（个别头保留成数组），所以这里只保证
 * "拿到的不是对象"。合并值会被后面的白名单/同源比对自然拒掉 —— **fail closed**，
 * 不需要为了容错去猜"用户到底想发哪个值"。
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {string} name 小写头名（Node 的 key 一律小写）
 * @returns {string|undefined}
 */
function headerText(headers, name) {
  const value = headers?.[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/**
 * 本前缀的浏览器信任栅栏。判据、理由与已知局限见模块顶部"信任栅栏"一节 ——
 * 这里只落实现，改判据请连注释一起改。
 *
 * 返回的 `error` 文案是**固定字符串**，不含任何请求头原文/凭据；
 * 调用方只做 `sendJson(res, 403, { ok:false, error })`。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} method 已归一化为大写的请求方法
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function checkRequestTrust(req, method) {
  const headers = req.headers ?? {}
  const fetchSite = headerText(headers, 'sec-fetch-site')?.trim().toLowerCase()
  const origin = headerText(headers, 'origin')

  if (fetchSite === 'cross-site') {
    return { ok: false, error: '拒绝跨站请求：本接口只服务同源设置页与本机客户端' }
  }

  if (origin !== undefined) {
    const host = headerText(headers, 'host')
    let sameOrigin = false
    if (host !== undefined) {
      try {
        // 两侧都过 WHATWG 归一化：大小写、默认端口、尾点差异都不会造成误判
        sameOrigin = new URL(origin).host === new URL(`http://${host}`).host
      } catch {
        sameOrigin = false
      }
    }
    if (!sameOrigin) {
      return { ok: false, error: '拒绝跨源请求：来源与请求目标主机不一致或不可解析' }
    }
  } else if (WRITE_METHODS.has(method) && fetchSite !== undefined) {
    // "浏览器发起"只认 sec-fetch-site：Node 的 fetch 会带 sec-fetch-mode 却不带它，
    // 而那是第 4 条要放行的非浏览器客户端（理由与实测见模块顶部第 3 条）。
    return { ok: false, error: '拒绝缺少来源标记的浏览器写请求' }
  }

  if (fetchSite !== undefined && !TRUSTED_FETCH_SITES.has(fetchSite)) {
    return { ok: false, error: '拒绝来源不明的请求：来源标记既不是同源也不是直连' }
  }

  return { ok: true }
}

/**
 * 注册全部 HTTP 路由。
 *
 * @param {object} opts
 * @param {any} root cordis 上下文
 * @param {{getState:Function,setMode:Function,setCustomText:Function,regenerateNow:Function,markCopied:Function,getPromptHallUrl:Function,
 *   pinEntry?:Function,sealEntry?:Function,deleteEntry?:Function,clearMark?:Function,rescanNow?:Function}} service
 *   `promptAdapt` 服务实例（`pinEntry`/`sealEntry`/`deleteEntry`/`clearMark` 是条目
 *   处置按钮用的，缺任何一个都会让对应按钮回 409 而不是 500）
 * @param {ReturnType<import('./state.js').createLogger>} log
 * @returns {(() => void) | null} disposer；`webServer` 不可用时返回 `null`
 */
export function registerRoutes({ root, service, log }) {
  const webServer = typeof root.get === 'function' ? root.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') {
    // 正常宿主上**不该出现这一条**：调用点是 `root.inject(['webServer'], ...)`，
    // 服务就绪后才会调到这里。出现即说明宿主缺 webServer（精简宿主），
    // 或者服务在回调与注册之间消失了 —— 两种情况下都只降级，不影响其它功能。
    log.warn(
      '[http] webServer 服务不可用：设置页将读不到宿主数据（扫描/画像/注入不受影响）',
    )
    return null
  }

  /**
   * 统一入口。返回 `true` 表示已处理（无论状态码）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const handler = async (req, res) => {
    // 只看 pathname，忽略 query
    const rawPath = String(req.url ?? '')
    const queryAt = rawPath.indexOf('?')
    const pathname = queryAt >= 0 ? rawPath.slice(0, queryAt) : rawPath
    const method = String(req.method ?? 'GET').toUpperCase()

    // 去掉前缀得到子路径。因为前缀匹配要求 `${prefix}/`，
    // 这里理论上不会拿到裸前缀，但仍然兜一层。
    let route = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
    if (route === '') route = '/'
    // 容忍尾斜杠
    if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1)

    try {
      // ── 信任栅栏（最先判，早于任何路由分发与 body 读取）─────────────
      // 判据/理由/局限见模块顶部"信任栅栏"一节。必须放在最前面：
      // 403 的请求**不读 body**，也不进任何业务分支 —— 免鉴权写入通道就是被这条堵住的。
      const trust = checkRequestTrust(req, method)
      if (!trust.ok) {
        sendJson(res, 403, { ok: false, error: trust.error })
        return
      }

      // ── GET /state ────────────────────────────────────────────────
      if (route === '/state' && method === 'GET') {
        if (typeof service.validate === 'function') service.validate()
        const state = service.getState()
        sendJson(res, 200, {
          contract: 1,
          ...state,
          hallUrl: safeHallUrl(service, log),
        })
        return
      }

      // ── POST /mode ───────────────────────────────────────────────
      if (route === '/mode' && method === 'POST') {
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (!body.ok) {
          sendJson(res, body.status, { ok: false, error: body.error })
          return
        }
        const mode = body.value?.mode
        // 在任何写入之前就拒掉非法值 —— 模式是硬约束，不接受"最接近的合法值"
        if (typeof mode !== 'string' || !ALLOWED_MODES.has(mode)) {
          sendJson(res, 400, {
            ok: false,
            error: `mode 必须是 'auto' 或 'custom'（收到 ${JSON.stringify(mode)}）`,
          })
          return
        }
        service.setMode(mode)
        sendJson(res, 200, { ok: true, mode, state: service.getState() })
        return
      }

      // ── PUT /custom ──────────────────────────────────────────────
      if (route === '/custom' && method === 'PUT') {
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (!body.ok) {
          sendJson(res, body.status, { ok: false, error: body.error })
          return
        }
        const text = asText(body.value?.text, MAX_CUSTOM_TEXT_CHARS)
        if (!text.ok) {
          sendJson(res, 413, { ok: false, error: text.error })
          return
        }
        service.setCustomText(text.value)
        sendJson(res, 200, { ok: true, length: text.value.length, state: service.getState() })
        return
      }

      // ── POST /regenerate ─────────────────────────────────────────
      if (route === '/regenerate' && method === 'POST') {
        // 立刻回 202：画像生成是一次 LLM 调用，可能跑几分钟，
        // 不能让设置页的请求挂在那里等。
        sendJson(res, 202, {
          ok: true,
          started: true,
          message: '画像生成已在后台开始；完成后 GET /state 可看到新版本',
        })
        // 后台跑，失败只记日志（服务内部已经把失败写进 lastRun）
        void Promise.resolve()
          .then(() => service.regenerateNow())
          .then(result => {
            if (result?.ok) log.info(`[http] 手动触发的画像生成完成 v${result.profile?.version}`)
            else if (result?.skipped) log.info(`[http] 手动触发的画像生成被跳过：${result.reason}`)
            else log.warn(`[http] 手动触发的画像生成失败：${result?.error ?? '未知'}`)
          })
          .catch(error => log.error(`[http] 手动触发画像生成抛错：${error?.message ?? error}`))
        return
      }

      // ── POST /copied ─────────────────────────────────────────────
      if (route === '/copied' && method === 'POST') {
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (!body.ok) {
          sendJson(res, body.status, { ok: false, error: body.error })
          return
        }
        const text = asText(body.value?.text, MAX_CUSTOM_TEXT_CHARS)
        if (!text.ok) {
          sendJson(res, 413, { ok: false, error: text.error })
          return
        }
        // `at` 与 `profileVersion` 由**宿主**决定，不采信客户端传来的值 ——
        // 客户端时钟可能不准，而这两个字段是"复制之后画像有没有再变"的判据基准。
        service.markCopied(text.value, {
          entries: body.value?.entries,
          algorithmVersion: body.value?.algorithmVersion,
        })
        sendJson(res, 200, { ok: true, copiedSnapshot: service.getState().copiedSnapshot })
        return
      }

      // ── POST /entry/{pin,unpin,seal,unseal,delete} ───────────────
      // 界面里每条画像条目旁的三个按钮 + 折叠区里的「恢复 / 取消置顶」。
      // 路由名用 `/entry/<动作>`（而不是一条 `/entry` 带 `action` 字段）：
      // 与既有风格一致（一条路径一个动词），排障时看日志/网络面板就能分清动作。
      const entryRoutes = {
        '/entry/pin': 'pin',
        '/entry/unpin': 'unpin',
        '/entry/seal': 'seal',
        '/entry/unseal': 'unseal',
        '/entry/delete': 'delete',
      }
      if (entryRoutes[route] && method === 'POST') {
        const action = entryRoutes[route]
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (!body.ok) {
          sendJson(res, body.status, { ok: false, error: body.error })
          return
        }
        const id = asOptionalText(body.value?.id)
        const claim = asOptionalText(body.value?.claim)
        const key = asOptionalText(body.value?.key)
        if (id === null || claim === null || key === null) {
          sendJson(res, 400, { ok: false, error: 'id / claim / key 必须是字符串' })
          return
        }
        // 「打标记」三个动作要求至少有一种定位方式；撤销要求 key（标记记录的身份）。
        if (action === 'unpin' || action === 'unseal') {
          if (!key) {
            sendJson(res, 400, { ok: false, error: `${action} 需要 key（标记记录的比对键）` })
            return
          }
        } else if (!id && !claim && !key) {
          sendJson(res, 400, { ok: false, error: `${action} 需要 id / claim / key 之一` })
          return
        }
        const result = action === 'pin'
          ? service.pinEntry(id, claim, key)
          : action === 'seal'
            ? service.sealEntry(id, claim, key)
            : action === 'delete'
              ? service.deleteEntry(id, claim, key)
              : service.clearMark(key)
        if (!result || result.ok !== true) {
          // 找不到条目 / 找不到标记 / 置顶到顶：都不是服务器故障，如实回 409 与原因。
          sendJson(res, 409, {
            ok: false,
            error: String(result?.error ?? `${action} 失败`),
          })
          return
        }
        // 一并回最新状态：界面不必再等一次 /state 往返（与 POST /mode 的做法一致）。
        sendJson(res, 200, { ok: true, action, result, state: service.getState() })
        return
      }

      // ── POST /rescan（附加：让设置页可以强制重扫） ─────────────────
      if (route === '/rescan' && method === 'POST') {
        sendJson(res, 202, { ok: true, started: true })
        void Promise.resolve()
          .then(() => service.rescanNow?.())
          .then(result => log.info(`[http] 手动重扫完成：${JSON.stringify(result?.totals ?? result ?? {})}`))
          .catch(error => log.error(`[http] 手动重扫抛错：${error?.message ?? error}`))
        return
      }

      // ── 前缀根：给设置页一个自检入口 ─────────────────────────────
      if (route === '/' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-prompt-adapt',
          contract: 1,
          prefix: API_PREFIX,
          endpoints: [
            'GET  /state',
            'POST /mode',
            'PUT  /custom',
            'POST /regenerate',
            'POST /copied',
            'POST /rescan',
            'POST /entry/pin',
            'POST /entry/unpin',
            'POST /entry/seal',
            'POST /entry/unseal',
            'POST /entry/delete',
          ],
        })
        return
      }

      // ── 未知路径 ─────────────────────────────────────────────────
      sendJson(res, 404, { ok: false, error: `未知路径 ${method} ${pathname}` })
    } catch (error) {
      // 任何未预期异常都不能把连接挂死
      log.error(`[http] 处理 ${method} ${pathname} 抛错：${error?.message ?? error}`)
      try {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      } catch {
        try {
          res.end()
        } catch {
          /* 连接可能已经断了 */
        }
      }
    }
  }

  const disposer = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  log.info(`[http] 已注册 prefix 路由 ${API_PREFIX}（11 个端点）`)
  return typeof disposer === 'function' ? disposer : null
}

/**
 * 取提示词大厅链接，并做"空则不显示死链"的兜底。
 *
 * 未配置时返回 `null` 而不是空串 —— 让设置页只需判断 `if (hallUrl)`。
 * 复用了 `lib/hall.js` 的判定，保证"配置里怎么写"与"接口返回什么"一致。
 */
function safeHallUrl(service, log) {
  try {
    const value = service.getPromptHallUrl()
    const text = typeof value === 'string' ? value.trim() : ''
    return text || null
  } catch (error) {
    log.warn(`[http] 读取提示词大厅链接失败：${error?.message ?? error}`)
    return null
  }
}
