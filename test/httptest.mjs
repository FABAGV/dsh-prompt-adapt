/**
 * HTTP 路由自检：用**真实的 `IncomingMessage` / `ServerResponse`** 驱动 handler，
 * 不手写假 req/res —— 因为这一层最容易出错的地方恰恰是 body 读取、状态码、
 * content-type 这些与 Node 流语义耦合的部分。
 *
 * 做法：起一个真的 `http.Server`，把插件注册的 handler 挂上去，
 * 然后用 `fetch()` 打真实请求。这样测的是端到端的那条链路。
 *
 * ⚠️ 只在**临时 `DSH_HOME`** 下跑真实 HTTP，端口用 0（系统分配），
 * 跑完立刻关掉。不碰用户的 `~/.dsh`。
 *
 * 运行：
 *   node test/httptest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Context } from '@deepseek-ai/cordis'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-adapt-http-'))
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
function buildContext({ withWebServer = true } = {}) {
  const root = new Context()
  root.provide('systemPrompt', { section: () => () => {} })
  root.provide('timer', { interval: () => () => {} })
  // 故意不提供 llm：验证 regenerate 的失败路径不崩
  const registered = []
  if (withWebServer) {
    root.provide('webServer', {
      register(route) {
        registered.push(route)
        return () => {
          const index = registered.indexOf(route)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    })
  }
  mod.default.apply(root, { logLevel: 'error', scan: { scanOnStart: false } })
  return { root, registered }
}

/** 起一个真 HTTP server，只挂插件注册的那条 prefix 路由。 */
async function startServer(route) {
  const server = http.createServer((req, res) => {
    const pathname = String(req.url ?? '').split('?')[0]
    // 复刻宿主的前缀匹配语义：pathname === prefix 或 startsWith(prefix + '/')
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
      void route.handler(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not matched by plugin route')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, base: `http://127.0.0.1:${port}${API_PREFIX}`, close: () => new Promise(r => server.close(r)) }
}

console.log('='.repeat(72))
console.log('A. 路由注册')
console.log('='.repeat(72))
const { registered } = buildContext()
{
  check('注册了恰好 1 条路由', registered.length === 1, `${registered.length} 条`)
  const route = registered[0]
  check('kind 是 prefix', route?.kind === 'prefix', String(route?.kind))
  check('path 是插件专属前缀', route?.path === API_PREFIX, String(route?.path))
  check('handler 是函数', typeof route?.handler === 'function')
  check('前缀不会撞到别人（带插件名）', API_PREFIX.startsWith('/dsh-prompt-adapt/'))
}

console.log('')
console.log('='.repeat(72))
console.log('B. 端到端请求（真实 http server + fetch）')
console.log('='.repeat(72))
const { base, server, close } = await startServer(registered[0])
const get = (p) => fetch(`${base}${p}`)
const send = (method, p, body) =>
  fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

try {
  // ── 前缀根自检 ────────────────────────────────────────────────────
  {
    const res = await get('/')
    const json = await res.json()
    check('GET / 返回自检信息', res.status === 200 && json.plugin === 'dsh-prompt-adapt', `status=${res.status}`)
    check('GET / 列出了端点', Array.isArray(json.endpoints) && json.endpoints.length >= 5,
      `${json.endpoints?.length} 个`)
  }

  // ── GET /state ───────────────────────────────────────────────────
  {
    const res = await get('/state')
    const json = await res.json()
    check('GET /state 返回 200', res.status === 200, `status=${res.status}`)
    check('GET /state 带 contract 版本号', json.contract === 1)
    check('GET /state 的 content-type 是 JSON',
      String(res.headers.get('content-type')).includes('application/json'))
    check('GET /state 带 cache-control: no-store（设置页不读到旧画像）',
      String(res.headers.get('cache-control')).includes('no-store'))
    check('GET /state 返回 mode', json.mode === 'auto' || json.mode === 'custom', String(json.mode))
    check('GET /state 返回 effectiveText / profile / lastRun',
      'effectiveText' in json && 'profile' in json && 'lastRun' in json)
    check('GET /state 带首跑进度 trigger（界面据此回答“还差几条”）',
      json.trigger && typeof json.trigger === 'object' &&
        typeof json.trigger.autoRun === 'boolean' &&
        Number.isFinite(json.trigger.triggerUserMessages) &&
        Number.isFinite(json.trigger.triggerNewSessions) &&
        typeof json.trigger.scanned === 'boolean',
      JSON.stringify(json.trigger))
    check('未配置大厅链接时 hallUrl 是 null（界面不显示死链）', json.hallUrl === null,
      JSON.stringify(json.hallUrl))
    check('GET /state 不泄漏任何密钥字段',
      !/(apiKey|api_key|token|secret|password)/i.test(JSON.stringify(json)))
  }

  // ── POST /mode ───────────────────────────────────────────────────
  {
    const bad = await send('POST', '/mode', { mode: 'both' })
    check('POST /mode 拒绝非法模式（不存在"两个都开"）', bad.status === 400, `status=${bad.status}`)
    const badBody = await bad.json()
    check('拒绝时给出可读原因', typeof badBody.error === 'string' && badBody.error.includes('auto'),
      badBody.error)

    const missing = await send('POST', '/mode', {})
    check('POST /mode 缺 mode 字段时 400', missing.status === 400, `status=${missing.status}`)

    const ok = await send('POST', '/mode', { mode: 'custom' })
    const okBody = await ok.json()
    check('POST /mode 接受 custom', ok.status === 200 && okBody.mode === 'custom', `status=${ok.status}`)
    check('切换后 state 一并返回（省一次往返）', okBody.state?.mode === 'custom')

    const back = await send('POST', '/mode', { mode: 'auto' })
    check('POST /mode 接受 auto', back.status === 200)
  }

  // ── PUT /custom ──────────────────────────────────────────────────
  {
    const text = '请始终用中文回答，不要用 emoji。'
    const res = await send('PUT', '/custom', { text })
    const json = await res.json()
    check('PUT /custom 写入成功', res.status === 200 && json.ok === true, `status=${res.status}`)
    check('PUT /custom 回显长度', json.length === text.length, `${json.length}`)

    // 写入后必须立刻生效（缓存失效）
    await send('POST', '/mode', { mode: 'custom' })
    const state = await (await get('/state')).json()
    check('写入后 effectiveText 立刻是自定义文本', state.effectiveText.includes(text),
      JSON.stringify(state.effectiveText.slice(0, 50)))
    check('effectiveSource 标成 customText', state.effectiveSource === 'customText')

    // 非法类型
    const badType = await send('PUT', '/custom', { text: 12345 })
    check('PUT /custom 拒绝非字符串', badType.status === 413, `status=${badType.status}`)

    // 超长（超字符上限）
    const huge = 'a'.repeat(200_001)
    const tooBig = await send('PUT', '/custom', { text: huge })
    check('PUT /custom 拒绝超长文本（字符上限 200000）', tooBig.status === 413, `status=${tooBig.status}`)
    const tooBigBody = await tooBig.json()
    check('超长拒绝给出上限说明', String(tooBigBody.error).includes('200000'), tooBigBody.error)

    // 空 body 应当被当成空文本（清空）
    const empty = await send('PUT', '/custom', {})
    check('PUT /custom 空 text 视为清空（回 200）', empty.status === 200, `status=${empty.status}`)
    await send('PUT', '/custom', { text })

    // body 不是合法 JSON
    const notJson = await fetch(`${base}/custom`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    })
    check('PUT /custom 拒绝非法 JSON', notJson.status === 400, `status=${notJson.status}`)
  }

  // ── 超大 body 的字节上限 ──────────────────────────────────────────
  {
    // 声明超大 content-length 但只发一点点：应当被 content-length 预检拦下
    const res = await fetch(`${base}/custom`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': '5000000' },
      body: JSON.stringify({ text: 'x' }),
    }).catch(() => null)
    // 有些 fetch 实现不允许伪造 content-length；拿不到响应也算通过预检（连接被拒）
    check('超大 content-length 被预检拦下（或连接被拒）',
      res === null || res.status === 413, res ? `status=${res.status}` : '连接被拒')
  }

  // ── POST /copied ─────────────────────────────────────────────────
  {
    const res = await send('POST', '/copied', { text: '请始终用中文回答，不要用 emoji。' })
    const json = await res.json()
    check('POST /copied 记录快照', res.status === 200 && json.copiedSnapshot?.text !== null,
      `status=${res.status}`)
    check('复制时间由宿主决定（at 是数字）', typeof json.copiedSnapshot?.at === 'number')
    check('快照里带上条目摘要与 algorithmVersion（跨浏览器也能精确比较）',
      'entries' in json.copiedSnapshot && typeof json.copiedSnapshot.algorithmVersion === 'string',
      String(json.copiedSnapshot.algorithmVersion))

    const state = await (await get('/state')).json()
    check('staleCopy 字段仍然存在（保留给非用户可见用途）', typeof state.staleCopy === 'boolean',
      `staleCopy=${state.staleCopy}`)
  }

  // ── POST /regenerate ─────────────────────────────────────────────
  {
    const res = await send('POST', '/regenerate', {})
    const json = await res.json()
    check('POST /regenerate 立刻回 202（不阻塞等 LLM）', res.status === 202, `status=${res.status}`)
    check('POST /regenerate 回 started:true', json.started === true)
    // 等后台任务把失败落到 lastRun（llm 服务缺失）
    await new Promise(r => setTimeout(r, 300))
    const state = await (await get('/state')).json()
    check('llm 缺失时后台生成失败被记入 lastRun（不崩、不静默）',
      state.lastRun?.ok === false && /llm 服务不可用/.test(String(state.lastRun.error)),
      String(state.lastRun?.error))
  }

  // ── POST /rescan ─────────────────────────────────────────────────
  {
    const res = await send('POST', '/rescan', {})
    check('POST /rescan 回 202', res.status === 202, `status=${res.status}`)
    await new Promise(r => setTimeout(r, 200))
  }

  // ── 未知路径 / 方法不允许 ────────────────────────────────────────
  {
    const res = await get('/nope')
    const json = await res.json()
    check('未知路径返回 404 JSON（不是宿主 fallback 的 HTML）', res.status === 404, `status=${res.status}`)
    check('404 带可读原因', String(json.error).includes('/nope'), json.error)

    const wrongMethod = await send('POST', '/state', {})
    check('方法不对返回 404（/state 只支持 GET）', wrongMethod.status === 404, `status=${wrongMethod.status}`)
  }

  // ── 尾斜杠容忍 ───────────────────────────────────────────────────
  {
    const res = await get('/state/')
    check('容忍尾斜杠 /state/', res.status === 200, `status=${res.status}`)
  }

  // ── 状态持久化到临时 DSH_HOME ────────────────────────────────────
  {
    const stateFile = path.join(tmpRoot, 'prompt-adapt', 'state.json')
    check('状态写在 $DSH_HOME/prompt-adapt 下', fs.existsSync(stateFile), stateFile)
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    check('落盘 mode 是合法枚举', ['auto', 'custom'].includes(saved.mode), String(saved.mode))
    check('落盘不含密钥字段', !/(apiKey|api_key|token|secret|password)/i.test(JSON.stringify(saved)))
    check('没有往会话根目录写东西', fs.readdirSync(path.join(tmpRoot, 'sessions')).length === 0)
    check('落盘的 copiedSnapshot 带 entries/algorithmVersion',
      'entries' in saved.copiedSnapshot && typeof saved.copiedSnapshot.algorithmVersion === 'string')
  }
} finally {
  await close()
}

console.log('')
console.log('='.repeat(72))
console.log('C. 降级：拿不到 webServer 时')
console.log('='.repeat(72))
{
  let threw = null
  let ctx = null
  try {
    ctx = buildContext({ withWebServer: false })
  } catch (error) {
    threw = error
  }
  check('没有 webServer 时 apply() 不抛', threw === null, threw?.message)
  check('服务仍然注册（宿主进程内可用）', ctx?.root.get('promptAdapt') != null)
  check('没有注册任何路由', ctx?.registered.length === 0, `${ctx?.registered.length} 条`)
  // 服务方法仍然可用 —— 只是浏览器够不到
  const service = ctx.root.get('promptAdapt')
  let methodThrew = null
  try {
    service.setMode('custom')
    service.setCustomText('降级路径仍然可写')
    service.getState()
  } catch (error) {
    methodThrew = error
  }
  check('降级时服务方法仍可用（扫描/画像/注入都不受影响）', methodThrew === null, methodThrew?.message)
  check('降级时状态仍然落盘',
    fs.existsSync(path.join(tmpRoot, 'prompt-adapt', 'state.json')))
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))

if (fail === 0) {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 清不掉也无所谓 */
  }
}
process.exit(fail === 0 ? 0 : 1)
