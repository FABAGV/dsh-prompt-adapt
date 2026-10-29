/**
 * HTTP 信任栅栏自检：验证 `lib/http.js` 的 `checkRequestTrust()` 在**真实** HTTP 链路上
 * 挡得住浏览器跨站、放得过合法调用方。
 *
 * 为什么不用 `fetch()`（`test/httptest.mjs` 的手法）：`origin` 与 `sec-fetch-*` 都是
 * Fetch 规范的 **forbidden header**，`fetch()` 会**静默丢掉**我们设的值 —— 用它根本
 * 测不了栅栏。所以这里用 `node:http` 直接发请求，逐条构造要判的头，并用**真实监听的**
 * `127.0.0.1:<port>`（从 `server.address()` 取，不硬编码端口）拼 Host/Origin。
 *
 * 另外记下 handler 实际收到的头，证明"我们真发出去了"而不是被 http 客户端改掉。
 *
 * ⚠️ 只在**临时 `DSH_HOME`** 下跑，不碰用户的 `~/.dsh`。
 *
 * 运行：
 *   node test/http-trust.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Context } from '@deepseek-ai/cordis'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-adapt-trust-'))
process.env.DSH_HOME = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true })

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const mod = await import('../lib/index.js')
const { API_PREFIX } = await import('../lib/http.js')

/** 建一个只提供最小服务的 Context，并 apply 插件。 */
function buildContext() {
  const root = new Context()
  root.provide('systemPrompt', { section: () => () => {} })
  root.provide('timer', { interval: () => () => {} })
  const registered = []
  root.provide('webServer', {
    register(route) {
      registered.push(route)
      return () => {}
    },
  })
  mod.default.apply(root, { logLevel: 'error', scan: { scanOnStart: false } })
  // 插件在 apply 里注册了 webserver/index-inject 的结构化行；桌面端就是靠它把
  // `__DSH_PROMPT_ADAPT__.token` 交给页面的。这里主动 emit 一次，既验证行存在，
  // 也拿到本次 apply 生成的 token 供后面的凭据通道测试使用。
  const table = []
  if (typeof root.emit === 'function') root.emit('webserver/index-inject', table)
  const authRow = table.find(row => row && row.kind === 'global' && row.name === '__DSH_PROMPT_ADAPT__')
  return { root, registered, table, authToken: authRow?.value?.token }
}

/** 起一个真 HTTP server，只挂插件注册的那条 prefix 路由。 */
async function startServer(route) {
  /** 最近一次 handler 收到的头 —— 用来证明客户端真把头发出去了。 */
  const seen = []
  const server = http.createServer((req, res) => {
    const pathname = String(req.url ?? '').split('?')[0]
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
      seen.push(req.headers)
      void route.handler(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not matched by plugin route')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, port, seen, close: () => new Promise(r => server.close(r)) }
}

const { registered, table: indexInjections, authToken } = buildContext()
const { port, seen, close } = await startServer(registered[0])

/** 真实监听地址 —— Host/Origin 都用它拼，绝不硬编码端口。 */
const AUTHORITY = `127.0.0.1:${port}`
const SAME_ORIGIN = `http://${AUTHORITY}`

/**
 * 发一个原始 HTTP 请求（可以用 fetch 设不了的头）。
 * @param {{method?:string, path:string, headers?:object, body?:string}} init
 */
function raw({ method = 'GET', path: p, headers = {}, body }) {
  const payload = body === undefined ? null : Buffer.from(body, 'utf8')
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: `${API_PREFIX}${p}`,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (payload) req.end(payload)
    else req.end()
  })
}

/** 一次"合法设置页"请求：浏览器语义 = same-origin 的 Fetch Metadata + 同源 Origin。 */
const browser = (method, p, body) => raw({
  method,
  path: p,
  headers: {
    host: AUTHORITY,
    origin: SAME_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  },
  body: body === undefined ? undefined : JSON.stringify(body),
})

console.log('='.repeat(72))
console.log('A. 非浏览器客户端（无来源标记）保持放行 —— 刻意的取舍')
console.log('='.repeat(72))
{
  const res = await raw({ path: '/state', headers: { host: AUTHORITY } })
  check('(a) 无 Origin/无 sec-fetch 的 GET /state → 200', res.status === 200, `status=${res.status}`)
  check('(a) 而且真拿到了业务数据（contract=1，不是空壳）',
    res.json?.contract === 1 && 'effectiveText' in (res.json ?? {}), `contract=${res.json?.contract}`)
  check('(a) 本机脚本的写请求也放行（POST /mode → 200）',
    (await raw({
      method: 'POST', path: '/mode', headers: { host: AUTHORITY }, body: JSON.stringify({ mode: 'custom' }),
    })).status === 200)
  await raw({ method: 'POST', path: '/mode', headers: { host: AUTHORITY }, body: JSON.stringify({ mode: 'auto' }) })

  // ⚠️ 回归钉子：Node 的 `fetch()`（undici）每个请求都带 `sec-fetch-mode: cors`，
  // 但**不带** `sec-fetch-site`、也不带 `Origin`（起个 http server 打印 req.headers 就能复现）。
  // 它属于"非浏览器客户端"。曾经把"任一 sec-fetch-*"当成浏览器指纹，结果
  // test/httptest.mjs 与 test/marks-guard.mjs 的全部写请求被 403（闸门变红）。
  const nodeFetchStyle = await raw({
    method: 'POST',
    path: '/mode',
    headers: { host: AUTHORITY, 'sec-fetch-mode': 'cors' },
    body: JSON.stringify({ mode: 'custom' }),
  })
  check('(a) 只有 sec-fetch-mode（Node fetch 指纹）、无 Origin 的写请求 → 200（不被误判成浏览器）',
    nodeFetchStyle.status === 200, `status=${nodeFetchStyle.status} error=${nodeFetchStyle.json?.error}`)
  await raw({ method: 'POST', path: '/mode', headers: { host: AUTHORITY }, body: JSON.stringify({ mode: 'auto' }) })
}

console.log('')
console.log('='.repeat(72))
console.log('B. 同源浏览器请求（正常设置页）→ 200')
console.log('='.repeat(72))
{
  const res = await browser('GET', '/state')
  check('(b) sec-fetch-site: same-origin + Origin 与 Host 一致 → 200',
    res.status === 200, `status=${res.status}`)
  check('(b) handler 收到的 Host 就是我们发的那一个（客户端没改写）',
    seen.at(-1)?.host === AUTHORITY, `host=${seen.at(-1)?.host}`)
  check('(b) handler 收到的 Origin 就是我们发的那一个',
    seen.at(-1)?.origin === SAME_ORIGIN, `origin=${seen.at(-1)?.origin}`)
}

console.log('')
console.log('='.repeat(72))
console.log('B2. 桌面端：index-inject 凭据 + CORS 预检（跨源设置页）')
console.log('='.repeat(72))
{
  const authRow = indexInjections.find(
    row => row && row.kind === 'global' && row.name === '__DSH_PROMPT_ADAPT__',
  )
  check('(b2) apply 时注册了 __DSH_PROMPT_ADAPT__ 的 global 注入行', !!authRow)
  check('(b2) 注入行里有非空 token',
    typeof authToken === 'string' && authToken.length >= 16, `len=${authToken?.length ?? 0}`)

  const preflight = await raw({
    method: 'OPTIONS',
    path: '/state',
    headers: {
      host: AUTHORITY,
      origin: 'null',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-dsh-prompt-adapt-token',
    },
  })
  check('(b2) 桌面端 CORS 预检 → 204（不能先被信任栅栏 403）',
    preflight.status === 204, `status=${preflight.status}`)
  check('(b2) 预检带 Access-Control-Allow-Origin: *',
    preflight.headers['access-control-allow-origin'] === '*',
    String(preflight.headers['access-control-allow-origin']))
  check('(b2) 预检允许 token 头',
    String(preflight.headers['access-control-allow-headers'] || '').includes('x-dsh-prompt-adapt-token'))

  const desktop = await raw({
    path: '/state',
    headers: {
      host: AUTHORITY,
      origin: 'null',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'x-dsh-prompt-adapt-token': authToken,
    },
  })
  check('(b2) 带正确 token 的跨源 GET /state → 200', desktop.status === 200,
    `status=${desktop.status} error=${desktop.json?.error}`)
  check('(b2) 200 响应也带 CORS 头（浏览器能读 body）',
    desktop.headers['access-control-allow-origin'] === '*')

  const noToken = await raw({
    path: '/state',
    headers: {
      host: AUTHORITY,
      origin: 'null',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
    },
  })
  check('(b2) 没有 token 的跨源请求仍然 → 403', noToken.status === 403, `status=${noToken.status}`)

  const badToken = await raw({
    path: '/state',
    headers: {
      host: AUTHORITY,
      origin: 'null',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'x-dsh-prompt-adapt-token': 'definitely-wrong',
    },
  })
  check('(b2) 错误 token → 403', badToken.status === 403, `status=${badToken.status}`)
}

console.log('')
console.log('='.repeat(72))
console.log('C. 跨站请求 → 403')
console.log('='.repeat(72))
{
  const get = await raw({
    path: '/state',
    headers: {
      host: AUTHORITY,
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'empty',
    },
  })
  check('(c) 跨站 GET /state → 403', get.status === 403, `status=${get.status}`)
  check('(c) 403 是 JSON（客户端能读 error）',
    String(get.headers['content-type']).includes('application/json'), String(get.headers['content-type']))

  // 简单请求：POST + text/plain 不触发预检，正是要挡的那条路
  const before = (await raw({ path: '/state', headers: { host: AUTHORITY } })).json
  const post = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ mode: 'custom' })
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `${API_PREFIX}/mode`,
      headers: {
        host: AUTHORITY,
        'content-type': 'text/plain',
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'empty',
      },
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
  check('(c) 跨站简单请求（POST /mode + text/plain）→ 403', post.status === 403, `status=${post.status}`)
  const after = (await raw({ path: '/state', headers: { host: AUTHORITY } })).json
  check('(c) 被拒的写入**没有生效**（mode 仍是 ' + before?.mode + '）', after?.mode === before?.mode,
    `mode=${after?.mode}`)
}

console.log('')
console.log('='.repeat(72))
console.log('D. Origin 与 Host 不一致 → 403')
console.log('='.repeat(72))
{
  const res = await raw({
    method: 'POST',
    path: '/mode',
    headers: { host: AUTHORITY, origin: 'http://evil.example' },
    body: JSON.stringify({ mode: 'custom' }),
  })
  check('(d) Origin=http://evil.example 与 Host 不一致 → 403', res.status === 403, `status=${res.status}`)

  const portOnly = await raw({
    method: 'POST',
    path: '/mode',
    headers: { host: AUTHORITY, origin: `http://127.0.0.1:${port + 1}` },
    body: JSON.stringify({ mode: 'custom' }),
  })
  check('(d) 只差一个端口（同机不同源）也 → 403', portOnly.status === 403, `status=${portOnly.status}`)

  // DNS rebinding：页面在别的域名下、DNS 指向 127.0.0.1，Origin 与 Host 天然一致。
  // 宿主没有 connection 服务时（这个测试就是），Host 必须是本机地址。
  const custom = await raw({
    path: '/state',
    headers: { host: 'harness.internal', origin: 'http://harness.internal', 'sec-fetch-site': 'same-origin' },
  })
  check('(d) Host=harness.internal 且 Origin 与之一致 → 403（挡住 DNS rebinding）',
    custom.status === 403, `status=${custom.status}`)
  check('(d) 自定义 Host 确实透传到了 handler',
    seen.at(-1)?.host === 'harness.internal', `host=${seen.at(-1)?.host}`)
  check('(d) 403 的文案不回显请求头', !custom.text.includes('harness.internal'), custom.text)
  const localhostName = await raw({ path: '/state', headers: { host: `localhost:${port}` } })
  check('(d) Host=localhost:<port> 照常放行', localhostName.status === 200, `status=${localhostName.status}`)
}

console.log('')
console.log('='.repeat(72))
console.log('E. 浏览器写请求缺 Origin → 403')
console.log('='.repeat(72))
{
  const res = await raw({
    method: 'POST',
    path: '/mode',
    headers: { host: AUTHORITY, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    body: JSON.stringify({ mode: 'custom' }),
  })
  check('(e) POST /mode + same-origin 但缺 Origin → 403', res.status === 403, `status=${res.status}`)

  const read = await raw({
    path: '/state',
    headers: { host: AUTHORITY, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
  })
  check('(e) 读方法（GET）缺 Origin 不拒：同源 GET 本来就不带 Origin → 200',
    read.status === 200, `status=${read.status}`)

  const sameSite = await raw({
    path: '/state',
    headers: { host: AUTHORITY, origin: SAME_ORIGIN, 'sec-fetch-site': 'same-site' },
  })
  check('(e) sec-fetch-site: same-site → 403（同站不同源，不是设置页）', sameSite.status === 403,
    `status=${sameSite.status}`)

  const none = await raw({ path: '/state', headers: { host: AUTHORITY, 'sec-fetch-site': 'none' } })
  check('(e) sec-fetch-site: none（地址栏直连）→ 200', none.status === 200, `status=${none.status}`)
}

console.log('')
console.log('='.repeat(72))
console.log('F. 合法请求不被误伤（浏览器语义下四个端点仍全部可达）')
console.log('='.repeat(72))
{
  const state = await browser('GET', '/state')
  check('(f) GET /state → 200', state.status === 200, `status=${state.status}`)

  const mode = await browser('POST', '/mode', { mode: 'custom' })
  check('(f) POST /mode → 200', mode.status === 200 && mode.json?.mode === 'custom',
    `status=${mode.status} mode=${mode.json?.mode}`)

  const text = '信任栅栏自检写入的自定义文本'
  const custom = await browser('PUT', '/custom', { text })
  check('(f) PUT /custom → 200', custom.status === 200 && custom.json?.length === text.length,
    `status=${custom.status}`)

  const pin = await browser('POST', '/entry/pin', { claim: '信任栅栏自检条目' })
  check('(f) POST /entry/pin 到达业务逻辑（200 或 409，总之不是 403/404）',
    pin.status === 200 || pin.status === 409, `status=${pin.status} error=${pin.json?.error}`)

  // 写确实落到了 state：漏掉这一步的话，"全 200 但什么都没写"也能骗过上面几条
  await browser('POST', '/mode', { mode: 'custom' })
  const effective = await browser('GET', '/state')
  check('(f) 合法写入真的生效（effectiveText 含自定义文本）',
    String(effective.json?.effectiveText).includes(text), String(effective.json?.effectiveSource))
  await browser('POST', '/mode', { mode: 'auto' })
}

console.log('')
console.log('='.repeat(72))
console.log('G. 403 响应体不回显任何请求头（四条判据逐条查）')
console.log('='.repeat(72))
{
  // 每一条判据的 403 都要单独查一遍：只查其中一条的话，另外三条的文案里
  // 混进请求头原文也测不出来。
  const cases = [
    ['跨站（第 1 条）', {
      method: 'POST', path: '/mode',
      headers: {
        host: 'harness.internal',
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
      },
    }],
    ['Origin 与 Host 不一致（第 2 条）', {
      method: 'POST', path: '/mode',
      headers: { host: AUTHORITY, origin: 'http://evil.example' },
    }],
    ['浏览器写请求缺 Origin（第 3 条）', {
      method: 'POST', path: '/mode',
      headers: { host: AUTHORITY, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    }],
    ['sec-fetch-site 不是同源/直连（第 3 条）', {
      method: 'POST', path: '/mode',
      headers: { host: AUTHORITY, origin: SAME_ORIGIN, 'sec-fetch-site': 'same-site' },
    }],
  ]
  const tokens = ['sec-fetch', 'origin', 'evil.example', 'harness.internal', AUTHORITY,
    'cross-site', 'same-site', 'no-cors', 'http://']

  for (const [label, init] of cases) {
    const res = await raw({ ...init, body: JSON.stringify({ mode: 'custom' }) })
    check(`(g) ${label} → 403`, res.status === 403, `status=${res.status}`)
    check(`(g) ${label} 的 body 是 JSON 且 ok:false`,
      res.json !== null && res.json.ok === false && typeof res.json.error === 'string', res.text)
    const text = res.text.toLowerCase()
    check(`(g) ${label} 的 body 不含任何请求头原文/头名`,
      tokens.every(token => !text.includes(token.toLowerCase())), res.text)
    check(`(g) ${label} 的 body 不含凭据类字段`,
      !/(cookie|authorization|token|secret)/i.test(res.text), res.text)
  }

  // 栅栏先于路由分发：连未知路径也不会先漏出"404 路由存在性"
  const unknown = await raw({
    path: '/nope',
    headers: { host: AUTHORITY, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  })
  check('(g) 跨站请求打未知路径也先吃 403（栅栏在最前面，早于路由分发）',
    unknown.status === 403, `status=${unknown.status}`)
}

console.log('')
console.log('='.repeat(72))
console.log('H. 权限策略与控制台票据：没有 DSH 登录校验时只读')
console.log('='.repeat(72))
{
  const read = await raw({ path: '/privacy', headers: { host: AUTHORITY } })
  check('(h) GET /privacy 本机可读', read.status === 200 && read.json?.policy?.effective?.['qq-group']?.tier === 'chat', `status=${read.status}`)
  const write = await raw({
    method: 'PUT',
    path: '/privacy',
    headers: { host: AUTHORITY },
    body: JSON.stringify({ overrides: { classes: { 'qq-group': { tier: 'full' } } } }),
  })
  check('(h) 没有 DSH 登录校验时 PUT /privacy → 403', write.status === 403, `status=${write.status}`)
  const after = await raw({ path: '/privacy', headers: { host: AUTHORITY } })
  check('(h) 被拒的修改没有生效', after.json?.policy?.effective?.['qq-group']?.tier === 'chat')
  const ticket = await raw({ method: 'POST', path: '/console/ticket', headers: { host: AUTHORITY } })
  check('(h) 没有 DSH 登录校验时拿不到控制台票据 → 403', ticket.status === 403, `status=${ticket.status}`)
  check('(h) 403 的文案指向 DSH 设置页或本机控制台', /DSH|控制台/.test(write.json?.error ?? ''), write.text)
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))

await close()

if (fail === 0) {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 清不掉也无所谓 */
  }
}
process.exit(fail === 0 ? 0 : 1)
