/**
 * 本机网页控制台的 HTTP 服务。
 *
 * 只监听 127.0.0.1（没有配置项能改成别的地址）。每个请求都要过四道检查：
 *   1. 对端地址是本机；
 *   2. Host 头是 127.0.0.1 / localhost / [::1] 加本服务的端口（挡 DNS rebinding）；
 *   3. 已登录（会话 cookie）；
 *   4. 写操作带 `x-pa-csrf` 头且 Origin 与 Host 一致（挡跨站请求）。
 *
 * 登录有两种方式：
 *   - 登录密钥：存在状态目录的 `console-key` 文件里，能读这个文件的只有你本机的账户；
 *   - 一次性票据：DSH 设置页（经 DSH 自己的登录校验）向宿主要一张 60 秒有效、只能用一次的票据。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'console')
const ASSET_NAME = /^\/([a-z][a-z0-9-]{0,40})\.(js|css)$/
const ASSET_TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' }
const PUBLIC_ASSETS = {
  '/login.css': ['app.css', 'text/css; charset=utf-8'],
}

/** `/` → index.html；`/<名字>.js|css` → lib/console 下的同名文件（名字只允许小写字母、数字、连字符）。 */
function assetFor(pathname) {
  if (pathname === '/') return ['index.html', 'text/html; charset=utf-8']
  const match = ASSET_NAME.exec(pathname)
  return match ? [`${match[1]}.${match[2]}`, ASSET_TYPES[match[2]]] : null
}
const COOKIE = 'pa_console'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const TICKET_TTL_MS = 60 * 1000
const MAX_SESSIONS = 20
const MAX_BODY = 1_000_000
const LOGIN_FAIL_LIMIT = 10
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': CSP,
}

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.replace(/^::ffff:/i, '')
  return value === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

export class ConsoleServer {
  /**
   * @param {object} opts
   * @param {string} opts.stateDir 登录密钥文件放在这里
   * @param {number} [opts.port] 0 = 系统分配
   * @param {{handle:(req:{method:string, path:string, query:URLSearchParams, body:any, session:object})=>Promise<{status:number, json:any}>}} opts.api
   * @param {object} [opts.log]
   */
  constructor({ stateDir, port = 6710, api, log }) {
    this.stateDir = stateDir
    this.keyFile = path.join(stateDir, 'console-key')
    this.wantedPort = port
    this.api = api
    this.log = log
    this.sessions = new Map()
    this.tickets = new Map()
    this.loginFailures = []
    this.server = null
    this.port = null
    this.retryTimer = null
    this.stopped = false
    this.key = this.#loadKey()
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  #loadKey() {
    try {
      const value = fs.readFileSync(this.keyFile, 'utf8').trim()
      if (/^[A-Za-z0-9_-]{32,}$/.test(value)) return value
    } catch {
      /* 第一次启动：下面生成 */
    }
    return this.rotateKey()
  }

  /** 换一把登录密钥；已登录的浏览器会被登出。 */
  rotateKey() {
    const value = crypto.randomBytes(24).toString('base64url')
    try {
      fs.mkdirSync(this.stateDir, { recursive: true })
      fs.writeFileSync(this.keyFile, `${value}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.log?.warn(`[console] 登录密钥写盘失败（本次进程内仍可用）：${error?.message ?? error}`)
    }
    this.key = value
    this.sessions.clear()
    return value
  }

  /** 发一张一次性登录票据（给 DSH 设置页的「打开控制台」按钮用）。 */
  issueTicket() {
    const now = Date.now()
    for (const [ticket, expiresAt] of this.tickets) if (expiresAt <= now) this.tickets.delete(ticket)
    if (this.tickets.size > 50) this.tickets.clear()
    const ticket = crypto.randomBytes(24).toString('base64url')
    this.tickets.set(ticket, now + TICKET_TTL_MS)
    return { ticket, url: this.url ? `${this.url}/login?ticket=${ticket}` : null, expiresInMs: TICKET_TTL_MS }
  }

  /** 开始监听。端口被占（常见于上一个实例还没退干净）时每 2 秒重试，最多 10 次。 */
  start() {
    return new Promise(resolve => {
      let attempts = 0
      const tryListen = () => {
        if (this.stopped) return resolve(false)
        attempts += 1
        const server = http.createServer((req, res) => {
          this.#handle(req, res).catch(error => {
            this.log?.error(`[console] 处理请求出错：${error?.message ?? error}`)
            try {
              this.#send(res, 500, { ok: false, error: '控制台内部错误' })
            } catch {
              /* 连接可能已断开 */
            }
          })
        })
        server.requestTimeout = 120_000
        server.headersTimeout = 20_000
        server.once('error', error => {
          if (error?.code === 'EADDRINUSE' && attempts < 10 && !this.stopped) {
            this.log?.warn(`[console] 端口 ${this.wantedPort} 被占用，2 秒后重试（第 ${attempts} 次）`)
            this.retryTimer = setTimeout(tryListen, 2000)
            this.retryTimer.unref?.()
            return
          }
          this.log?.error(`[console] 控制台没能启动：${error?.message ?? error}`)
          resolve(false)
        })
        server.listen(this.wantedPort, '127.0.0.1', () => {
          server.unref()
          this.server = server
          this.port = server.address().port
          this.log?.info(`[console] 控制台已启动：${this.url}（登录密钥在 ${this.keyFile}）`)
          resolve(true)
        })
      }
      tryListen()
    })
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.sessions.clear()
    this.tickets.clear()
    const server = this.server
    this.server = null
    this.port = null
    if (!server) return Promise.resolve()
    return new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  #send(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload ?? null)
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      ...extraHeaders,
    })
    res.end(body)
  }

  #sendText(res, status, text, type, extraHeaders = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(text), ...extraHeaders })
    res.end(text)
  }

  #hostOk(req) {
    const host = String(req.headers.host ?? '')
    let url
    try {
      url = new URL(`http://${host}`)
    } catch {
      return false
    }
    const hostname = url.hostname.toLowerCase()
    const portOk = Number(url.port || 80) === this.port
    return portOk && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]')
  }

  #session(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    if (!token) return null
    const session = this.sessions.get(token)
    if (!session) return null
    if (Date.now() - session.lastSeen > SESSION_TTL_MS) {
      this.sessions.delete(token)
      return null
    }
    session.lastSeen = Date.now()
    return session
  }

  #createSession(via) {
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]
      this.sessions.delete(oldest[0])
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const session = { csrf: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now(), lastSeen: Date.now(), via }
    this.sessions.set(token, session)
    const cookie = `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    return { token, session, cookie }
  }

  #loginBlocked() {
    const now = Date.now()
    this.loginFailures = this.loginFailures.filter(at => now - at < 60_000)
    return this.loginFailures.length >= LOGIN_FAIL_LIMIT
  }

  async #handle(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return this.#send(res, 403, { ok: false, error: '控制台只接受本机访问' })
    if (!this.#hostOk(req)) return this.#send(res, 403, { ok: false, error: '请用 127.0.0.1 或 localhost 访问控制台' })
    const url = new URL(req.url ?? '/', 'http://console.invalid')
    const method = String(req.method ?? 'GET').toUpperCase()
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()

    if (url.pathname === '/login') return this.#login(req, res, url, method)
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') return this.#send(res, 403, { ok: false, error: '拒绝跨站请求' })

    if (method === 'GET' && PUBLIC_ASSETS[url.pathname]) return this.#asset(res, PUBLIC_ASSETS[url.pathname])
    if (method === 'GET' && url.pathname === '/favicon.ico') return this.#sendText(res, 204, '', 'text/plain')

    const session = this.#session(req)
    const asset = method === 'GET' ? assetFor(url.pathname) : null
    if (asset) {
      if (!session) return url.pathname === '/' ? this.#redirect(res, '/login') : this.#send(res, 401, { ok: false, error: '请先登录控制台' })
      return this.#asset(res, asset)
    }
    if (!url.pathname.startsWith('/api/')) return this.#send(res, 404, { ok: false, error: '没有这个页面' })
    if (!session) return this.#send(res, 401, { ok: false, error: '请先登录控制台' })

    if (method !== 'GET' && method !== 'HEAD') {
      if (!safeEqual(req.headers['x-pa-csrf'], session.csrf)) return this.#send(res, 403, { ok: false, error: '缺少或错误的 CSRF 令牌，请刷新页面' })
      const origin = req.headers.origin
      if (origin !== undefined && origin !== `http://${req.headers.host}`) return this.#send(res, 403, { ok: false, error: '来源不一致' })
    }

    if (url.pathname === '/api/me' && method === 'GET') {
      return this.#send(res, 200, { ok: true, csrf: session.csrf, url: this.url, via: session.via, since: session.createdAt })
    }
    if (url.pathname === '/api/logout' && method === 'POST') {
      for (const [token, value] of this.sessions) if (value === session) this.sessions.delete(token)
      return this.#send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
    }
    if (url.pathname === '/api/console/rotate-key' && method === 'POST') {
      this.rotateKey()
      return this.#send(res, 200, { ok: true, keyFile: this.keyFile }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
    }

    let body = null
    if (method !== 'GET' && method !== 'HEAD') {
      const type = String(req.headers['content-type'] ?? '')
      const read = await readBody(req)
      if (!read.ok) return this.#send(res, read.status, { ok: false, error: read.error })
      if (read.text.trim()) {
        if (!type.toLowerCase().startsWith('application/json')) return this.#send(res, 415, { ok: false, error: '请求体必须是 JSON' })
        try {
          body = JSON.parse(read.text)
        } catch {
          return this.#send(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        }
      }
    }
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('浏览器断开了连接'))
    })
    const result = await this.api.handle({ method, path: url.pathname.slice('/api'.length), query: url.searchParams, body, session, signal: controller.signal })
    if (res.writableEnded || res.destroyed) return
    return this.#send(res, result?.status ?? 200, result?.json ?? { ok: true })
  }

  async #login(req, res, url, method) {
    if (method === 'GET') {
      const ticket = url.searchParams.get('ticket')
      if (!ticket) return this.#loginPage(res, 200)
      const expiresAt = this.tickets.get(ticket)
      this.tickets.delete(ticket)
      if (!expiresAt || expiresAt < Date.now()) {
        return this.#loginPage(res, 401, '这个登录链接已失效（只能用一次，60 秒内有效）。请回到 DSH 设置页重新打开，或用登录密钥登录。')
      }
      // 票据链接通常是从 DSH 的页面（别的站点）点开的：在这种跨站导航的响应里直接 303，
      // 跳转后的请求仍算跨站，SameSite=Strict 的 cookie 不会被带上。先落到本站的页面，再由它跳转。
      const { cookie } = this.#createSession('dsh-settings')
      return this.#enterPage(res, cookie)
    }
    if (method !== 'POST') return this.#send(res, 405, { ok: false, error: '不支持的方法' })
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') return this.#loginPage(res, 403, '拒绝跨站登录。')
    if (this.#loginBlocked()) return this.#loginPage(res, 429, '尝试次数太多，请一分钟后再试。')
    const read = await readBody(req, 10_000)
    if (!read.ok) return this.#loginPage(res, read.status, read.error)
    const key = new URLSearchParams(read.text).get('key')
    if (!safeEqual(String(key ?? '').trim(), this.key)) {
      this.loginFailures.push(Date.now())
      return this.#loginPage(res, 401, '登录密钥不对。')
    }
    const { cookie } = this.#createSession('key')
    return this.#redirect(res, '/', cookie)
  }

  #redirect(res, location, cookie) {
    const headers = { ...SECURITY_HEADERS, location, 'content-length': 0 }
    if (cookie) headers['set-cookie'] = cookie
    res.writeHead(303, headers)
    res.end()
  }

  #enterPage(res, cookie) {
    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/">' +
      '<title>正在进入控制台</title><link rel="stylesheet" href="/login.css"></head>' +
      '<body class="login"><main class="login-card"><p>已登录，正在进入控制台…</p><p><a href="/">没有自动跳转就点这里</a></p></main></body></html>'
    return this.#sendText(res, 200, html, 'text/html; charset=utf-8', { 'set-cookie': cookie })
  }

  #asset(res, [file, type]) {
    let text
    try {
      text = fs.readFileSync(path.join(ASSET_DIR, file), 'utf8')
    } catch {
      return this.#send(res, 404, { ok: false, error: `没有这个文件：${file}` })
    }
    return this.#sendText(res, 200, text, type)
  }

  #loginPage(res, status, message = '') {
    let html
    try {
      html = fs.readFileSync(path.join(ASSET_DIR, 'login.html'), 'utf8')
    } catch {
      html = '<!doctype html><meta charset="utf-8"><title>登录</title><p>控制台文件缺失。</p>'
    }
    const escaped = message.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
    html = html.replace('<!--MESSAGE-->', escaped ? `<p class="login-error" role="alert">${escaped}</p>` : '')
    html = html.replace('<!--KEYFILE-->', this.keyFile.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`))
    return this.#sendText(res, status, html, 'text/html; charset=utf-8')
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise(resolve => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) return resolve({ ok: false, status: 413, error: '请求体过大' })
    const chunks = []
    let size = 0
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      req.destroy?.()
      finish({ ok: false, status: 408, error: '读取请求体超时' })
    }, 10_000)
    timer.unref?.()
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        req.destroy?.()
        finish({ ok: false, status: 413, error: '请求体过大' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', error => finish({ ok: false, status: 400, error: `读取请求体失败：${error?.message ?? error}` }))
  })
}
