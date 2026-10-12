/**
 * T1–T4 的回归：每 tick 只算一遍信号 / details 不白算 / 异步预热排序 / 材料预算可见。
 *
 * 为什么单独一个文件而不是塞进 selftest：
 *   · 这些改动的关键状态（`lastScan` / `warmup` / 材料累加器）都活在 `apply()` 的闭包里，
 *     只有**在真实 Context 上跑 apply() + 真跑一次 tick** 才验得到 ——
 *     手法与 `test/loadtest.mjs` 一致（真 cordis Context + 临时 DSH_HOME + 假 timer）。
 *   · 纯函数（`shouldReuseScan()` / `summarizeMaterialStats()`）则直接按判定矩阵单测，
 *     不去 monkey-patch ESM 模块（ESM 的绑定是只读的，那种测试成本高于收益）。
 *
 * ⚠️ 全程不碰用户的 `~/.dsh`：`DSH_HOME` 与 `stateDir` / `sessionsRoot` 都指向临时目录
 *    （apply 收到的是显式配置，与会话目录无关）。
 *
 * 运行： node test/tick-signals.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { SessionScanner } from '../lib/sessions.js'
import { computeAllSignals } from '../lib/signals.js'
import { collectHumanMessages } from '../lib/profile.js'
import { emptyState } from '../lib/state.js'
import plugin, {
  Config,
  resolveConfig,
  shouldReuseScan,
  summarizeMaterialStats,
} from '../lib/index.js'

// 先钉住 DSH_HOME：apply() 里 `resolveDshHome()` 还兜着 stateDir/sessionsRoot 的默认值，
// 万一哪条路径漏传了显式配置，也必须落在临时目录里（绝不写用户的 ~/.dsh）。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-tick-signals-'))
process.env.DSH_HOME = TMP_ROOT

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

function newDir(name) {
  const dir = path.join(TMP_ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 合成一条会话日志文件：一个 zstd 帧，里面是 JSONL（与宿主格式一致）。 */
function writeSession(sessionsRoot, sessionId, lines, { project = 'proj' } = {}) {
  const file = path.join(sessionsRoot, project, sessionId, 'session.v4.jsonl.zstd')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
  return path.relative(sessionsRoot, file)
}

/** 一条真人发言（形状与 test/extract-bugfix.mjs 的 humanMessage() 同源，已被信号层认账）。 */
function humanMessage(seq, time, text) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/**
 * 拿到与**扫描路径完全一致**的 `bySession`（`event.message.source.kind === 'user'`
 * 这种规范化形状由 scanner 里的 `normalizeInto()` 产生 —— 手写"原始日志形状"的事件
 * 直接喂给 `computeAllSignals()` 是不算真人发言的，这条踩过一次）。
 */
function probeBySession(sessionId, lines) {
  const sessionsRoot = newDir(`probe-log-${sessionId}`)
  const plainDir = newDir(`probe-plain-${sessionId}`)
  writeSession(sessionsRoot, sessionId, lines)
  const scanner = new SessionScanner({
    sessionsRoot,
    plainDir,
    maxWindowSize: 64 << 20,
    maxFramesPerScan: 400,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  scanner.scan({ version: 1, files: {} })
  return scanner.bySession()
}

/**
 * 在真实 Context 上 apply() 本插件。
 * 只提供最小服务集合：systemPrompt（收下注入段）、timer（**收下 tick 回调，手动触发**）、
 * webServer（让路由注册这条路也跑一遍）；llm 按需提供。
 */
function boot({ stateDir, sessionsRoot, scanOnStart = false, profile = {}, llm = null, logLevel = 'error' }) {
  const root = new Context()
  const sections = []
  root.provide('systemPrompt', {
    section(definition) {
      sections.push(definition)
      return () => {}
    },
  })
  const intervals = []
  root.provide('timer', {
    interval(callback, delay) {
      intervals.push({ callback, delay })
      return () => {}
    },
  })
  root.provide('webServer', { register: () => () => {} })
  if (llm) root.provide('llm', llm)

  plugin.apply(root, {
    logLevel,
    stateDir,
    sessionsRoot,
    scan: { scanOnStart, intervalMs: 120000 },
    profile,
  })
  const service = root.get('promptAdapt')
  return { root, service, intervals, sections, stateFile: path.join(stateDir, 'state.json') }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return predicate()
}

/**
 * 探针：`lib/profile.js` 的 `maxMaterialChars` + `stats`（**另一个代理**的改动）是否已落地。
 *
 * 没落地时 `stats` 不会被填（全 0），所以涉及"被裁掉多少"的断言现在只能验字段位与数值形状；
 * 落地后（`stats` 被填）同一批断言自动升级成强断言（dropped > 0 / total > 0）。
 * 这样本测试今天不会无辜变红，对方落地后也不会失去覆盖。
 */
const PEER_STATS_PROBE = { chars: 0, kept: 0, dropped: 0, total: 0 }
collectHumanMessages(
  probeBySession('stats-probe', Array.from({ length: 100 }, (unused, i) =>
    humanMessage(i + 1, 1000 + i, '嗯'.repeat(1000)))),
  { maxMessageChars: 1200, maxMaterialChars: 5000, stats: PEER_STATS_PROBE },
)
const PEER_STATS_LANDED = ['chars', 'kept', 'dropped', 'total'].some(key => Number(PEER_STATS_PROBE[key]) > 0)

console.log('='.repeat(72))
console.log('A. shouldReuseScan() 判定矩阵（T1 的复用/失效判据）')
console.log('='.repeat(72))
{
  const now = 1_700_000_000_000
  const fresh = { at: now - 1000, revision: 7, error: null }
  const ctx = { now, intervalMs: 120000, force: false, revision: 7 }

  check('无历史 → 不复用', shouldReuseScan(null, ctx).reuse === false)
  check('无历史（undefined）→ 不复用', shouldReuseScan(undefined, ctx).reuse === false)
  check('在间隔内 + 非 force + revision 一致 → 复用', shouldReuseScan(fresh, ctx).reuse === true)
  check('force → 不复用（手动 rescan/regenerate 要现算）',
    shouldReuseScan(fresh, { ...ctx, force: true }).reuse === false)
  check('超出间隔 → 不复用',
    shouldReuseScan({ ...fresh, at: now - 120001 }, ctx).reuse === false,
    `elapsed=120001ms`)
  check('正好等于间隔 → 复用（边界取"还在间隔内"，与定时器同节拍不白重算）',
    shouldReuseScan({ ...fresh, at: now - 120000 }, ctx).reuse === true)
  check('上一次扫描出错 → 不复用',
    shouldReuseScan({ ...fresh, error: 'EACCES' }, ctx).reuse === false)
  check('两次之间 byFile 被别的扫描动过（revision 不一致）→ 不复用',
    shouldReuseScan(fresh, { ...ctx, revision: 8 }).reuse === false)
  check('不传 revision 时不做这项校验 → 复用',
    shouldReuseScan(fresh, { now, intervalMs: 120000 }).reuse === true)
  check('时间戳在未来（时钟回拨/脏数据）→ 不复用',
    shouldReuseScan({ ...fresh, at: now + 5000 }, ctx).reuse === false)
  check('时间戳非法 → 不复用', shouldReuseScan({ at: 'x', revision: 7 }, ctx).reuse === false)
  check('每条判定都给出非空理由（理由进 debug 日志）',
    [null, fresh, { ...fresh, error: 'x' }].every(item => {
      const verdict = shouldReuseScan(item, ctx)
      return typeof verdict.reason === 'string' && verdict.reason.length > 0
    }))
}

console.log('')
console.log('='.repeat(72))
console.log('B. profile.maxMaterialChars 默认值（T4：三处同值）')
console.log('='.repeat(72))
{
  check('resolveConfig({}).profile.maxMaterialChars === 80000',
    resolveConfig({}).profile.maxMaterialChars === 80000,
    String(resolveConfig({}).profile.maxMaterialChars))
  check('显式配置覆盖默认值（不会被 defaults 吃掉）',
    resolveConfig({ profile: { maxMaterialChars: 40000 } }).profile.maxMaterialChars === 40000,
    String(resolveConfig({ profile: { maxMaterialChars: 40000 } }).profile.maxMaterialChars))

  const outcome = Config['~standard'].validate({})
  const schemaValue = outcome?.value ?? outcome
  const schemaHasField = schemaValue?.profile != null && 'maxMaterialChars' in schemaValue.profile
  // schema.js 那一处是**另一个代理**的改动：没落地时这个字段根本不存在，
  // 所以这里只在它存在时做等值断言（否则测试会无辜变红）。
  check('schema 默认值 === 80000（对方改动落地后必须等值；未落地则此处只记录）',
    schemaHasField ? schemaValue.profile.maxMaterialChars === 80000 : true,
    schemaHasField
      ? `schema=${schemaValue.profile.maxMaterialChars}`
      : 'schema.js 尚未加该字段（对方改动未落地）→ 跳过等值比对')
}

console.log('')
console.log('='.repeat(72))
console.log('C. summarizeMaterialStats()：形状与数值兜底（T4 的可见化）')
console.log('='.repeat(72))
{
  const full = summarizeMaterialStats({ chars: 12000, kept: 200, dropped: 40000, total: 52000 })
  check('四个字段原样透传（dropped > 0 时可被看见）',
    full.chars === 12000 && full.kept === 200 && full.dropped === 40000 && full.total === 52000,
    JSON.stringify(full))
  check('null → 全 0（字段位仍在，不是 undefined）',
    JSON.stringify(summarizeMaterialStats(null)) === JSON.stringify({ chars: 0, kept: 0, dropped: 0, total: 0 }))
  const dirty = summarizeMaterialStats({ chars: '7', kept: undefined, dropped: -5, total: NaN })
  check('脏值被规整成有限非负整数', dirty.chars === 7 && dirty.kept === 0 && dirty.dropped === 0 && dirty.total === 0,
    JSON.stringify(dirty))
  check('小数向下取整', summarizeMaterialStats({ dropped: 3.7 }).dropped === 3)
  check('返回值只有这四个字段（不会把别的字段漏进 /state）',
    Object.keys(full).sort().join(',') === 'chars,dropped,kept,total', Object.keys(full).join(','))
}

console.log('')
console.log('='.repeat(72))
console.log('D. 一次 tick：信号只算一遍（T1）')
console.log('='.repeat(72))
{
  const sessionsRoot = newDir('d-sessions')
  const stateDir = newDir('d-state')
  const sessionId = 'session-dddd'
  writeSession(sessionsRoot, sessionId, [
    humanMessage(1, 1000, '第一条'),
    humanMessage(2, 2000, '第二条'),
    humanMessage(3, 3000, '第三条'),
  ])

  // 计数钩子：`computeAllSignals()` 的输入就是 `scanner.bySession()` 的返回值，
  // 所以"一次 tick 里 computeAllSignals 算了几遍"等价于"bySession() 被调了几次"
  // （scanOnce 是 1 次 bySession + 1 次 computeAllSignals，两者一一对应）。
  // 改之前：scanOnce 一次 + maybeGenerate 又一次 = 2 次。
  const proto = SessionScanner.prototype
  const originalBySession = proto.bySession
  let bySessionCalls = 0
  proto.bySession = function patchedBySession() {
    bySessionCalls += 1
    return originalBySession.call(this)
  }

  try {
    const { service, intervals } = boot({ stateDir, sessionsRoot })
    check('scanOnStart=false 时 apply() 不自己扫（计数从 0 开始）', bySessionCalls === 0, `${bySessionCalls} 次`)

    check('注册了定时 tick 回调', typeof intervals[0]?.callback === 'function' && intervals[0].delay === 120000,
      `delay=${intervals[0]?.delay}`)

    intervals[0].callback() // 定时器回调是 `() => void tick()`：拿不到 promise，靠状态等它落地
    const done = await waitFor(() => service.host.store.state.lastRun?.at != null)
    check('tick 跑完了（lastRun 被写上）', done === true,
      JSON.stringify(service.host.store.state.lastRun))

    check('一次 tick 只调一次 bySession()（改前是 2 次）', bySessionCalls === 1, `${bySessionCalls} 次`)
    check('lastSignals 真的算出来了（不是空手复用）',
      service.host.store.state.lastSignals?.totals?.humanMessages === 3 &&
        service.host.store.state.lastSignals?.sessionCount === 1,
      JSON.stringify(service.host.store.state.lastSignals?.totals))

    // 复用是**同一个对象**：现算的话 `computeAllSignals()` 每次都造一份新的 totals。
    const reused = service.host.scanSnapshot()
    check('非 force 拿到的 totals 与 scanOnce 写进 lastSignals 的是同一份数字（同一个对象）',
      reused.totals === service.host.store.state.lastSignals.totals)
    check('复用不重算：bySession() 调用次数没有增加', bySessionCalls === 1, `${bySessionCalls} 次`)

    const again = service.host.scanSnapshot()
    check('连续两次非 force 拿到同一个快照对象（证明走的是复用分支）', again === reused)

    const forced = service.host.scanSnapshot({ force: true })
    check('force → 现算（新对象）', forced !== reused)
    check('force 走了一次 bySession()（重算确实发生了）', bySessionCalls === 2, `${bySessionCalls} 次`)
    check('复用/现算两条路径的形状一致（都有 totals + bySession，调用方不必分叉）',
      reused.totals != null && reused.bySession != null && forced.totals != null && forced.bySession != null)
    check('缓存里不驻留逐会话 details（T2：只有 totals 会被复用，details 不该被留一整个周期）',
      !('sessions' in reused) && !('signals' in reused), JSON.stringify(Object.keys(reused)))

    // T2：单会话路径（界面在用）必须保持默认 details
    const single = service.getSessionSignals(sessionId)
    check('getSessionSignals() 仍有 details（单会话路径不受扫描路径的 details:false 影响）',
      single != null && typeof single.details === 'object' && single.details !== null,
      `details=${JSON.stringify(Object.keys(single?.details ?? {}))}`)
    check('getSessionSignals() 的 humanMessages 与扫描口径一致', single?.humanMessages === 3,
      String(single?.humanMessages))
  } finally {
    proto.bySession = originalBySession
  }
}

console.log('')
console.log('='.repeat(72))
console.log('E. 材料预算写进 lastRun.material（T4：成功与失败都不吞）')
console.log('='.repeat(72))
{
  const sessionsRoot = newDir('e-sessions')
  const stateDir = newDir('e-state')
  const sessionId = 'session-eeee'
  // 100 条 × 1000 字符 = 10 万字符材料，超出 maxMaterialChars 的 80000 上限。
  const lines = []
  for (let i = 0; i < 100; i++) lines.push(humanMessage(i + 1, 1000 + i, '嗯'.repeat(1000)))
  writeSession(sessionsRoot, sessionId, lines)

  // 假 llm：材料**已经收集完之后**才失败（`generateProfile()` 调 `llm.stream()`）。
  const llm = {
    stream() {
      throw new Error('假 llm：故意失败（材料已经取到了）')
    },
  }

  const { service, intervals } = boot({
    stateDir,
    sessionsRoot,
    profile: { provider: 'test-provider', model: 'test-model', maxMessageChars: 1200 },
    llm,
  })

  intervals[0].callback()
  const failed = await waitFor(() => service.host.store.state.lastRun?.ok === false, 15000)
  const lastRun = service.getState().lastRun
  check('生成失败被如实记进 lastRun（假 llm 的错）', failed === true && /假 llm/.test(String(lastRun?.error)),
    String(lastRun?.error))

  const material = lastRun?.material
  check('失败路径也写入了 lastRun.material（不静默省略）', material != null && typeof material === 'object',
    JSON.stringify(material))
  check('material 四个字段都是有限数字',
    ['chars', 'kept', 'dropped', 'total'].every(key => Number.isFinite(material?.[key])),
    JSON.stringify(material))

  // 对方（profile.js 的 maxMaterialChars + stats）是否已落地由上面的一次性探针判定，
  // 没落地时这里只验字段位与数值形状，落地后自动变成"dropped 必须 > 0"。
  check('材料被裁时 lastRun.material.dropped > 0 出现在状态里',
    PEER_STATS_LANDED ? material.dropped > 0 : true,
    PEER_STATS_LANDED
      ? `dropped=${material.dropped}（材料量 chars=${material.chars} total=${material.total}）`
      : `profile.js 的 stats 尚未落地（探针 ${JSON.stringify(PEER_STATS_PROBE)}）→ 只验字段位与数值；落地后本条会强断言 dropped>0`)

  const saved = fs.existsSync(path.join(stateDir, 'state.json'))
    ? JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    : null
  check('material 随 state.json 落盘（重启后仍能解释"画像为什么不全面"）',
    saved?.lastRun?.material != null, JSON.stringify(saved?.lastRun?.material))

  // 不生成的那一轮（not-due）必须**保留**上一次的材料数字，而不是抹成 undefined：
  // 造一个"已有一版画像 + 水位等于当前信号"的状态，再调一次非 force 的生成判定。
  const beforeQuiet = JSON.stringify(service.host.store.state.lastRun.material)
  service.host.store.state.profile = { version: 1, entries: [{ id: 'X1', category: 'A', claim: '占位条目' }] }
  service.host.store.state.lastGeneration = { at: Date.now(), humanMessages: 100, sessions: 1 }
  await service.host.maybeGenerate()
  check('not-due 分支保留上一次生成的材料数字（字段位与数值都在，不抹成 undefined）',
    service.host.store.state.lastRun.ok === null &&
      JSON.stringify(service.host.store.state.lastRun.material) === beforeQuiet,
    JSON.stringify(service.host.store.state.lastRun))
  check('not-due 之后 /state 的 material 字段位仍在', 'material' in service.getState().lastRun)
}

console.log('')
console.log('='.repeat(72))
console.log('E2. 成功路径也写 material（T4：成功与失败都不吞）')
console.log('='.repeat(72))
{
  const sessionsRoot = newDir('e2-sessions')
  const stateDir = newDir('e2-state')
  const sessionId = 'session-gggg'
  const lines = []
  for (let i = 0; i < 30; i++) lines.push(humanMessage(i + 1, 1000 + i, '哎'.repeat(1000)))
  writeSession(sessionsRoot, sessionId, lines)

  // 假 llm：按真契约吐一份合法画像 JSON（形状抄自 test/selftest.mjs 的 stubbed.stream）。
  const llm = {
    async *stream() {
      yield {
        type: 'text-delta',
        text: '{"entries":[{"id":"A1","category":"A","claim":"习惯一句话下达任务",',
      }
      yield { type: 'text-delta', text: '"evidence":["嗯"],"confidence":"high"}]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const { service, intervals } = boot({
    stateDir,
    sessionsRoot,
    profile: { provider: 'test-provider', model: 'test-model', maxMessageChars: 1200 },
    llm,
    // 这一段要读 plugin.log 里的材料量报告（"静默省略最糟"那条要求的可见性），
    // 所以开到 info；其余段落用 error，免得测试输出被插件日志淹掉。
    logLevel: 'info',
  })
  intervals[0].callback()
  const ok = await waitFor(() => service.host.store.state.lastRun?.ok === true, 20000)
  const lastRun = service.getState().lastRun
  check('生成成功（假 llm 输出合法画像 JSON）', ok === true, String(lastRun?.error))
  check('成功路径的 material 有四个有限数字（不只在失败路径写）',
    lastRun?.material != null &&
      ['chars', 'kept', 'dropped', 'total'].every(key => Number.isFinite(lastRun.material[key])),
    JSON.stringify(lastRun?.material))
  check('成功路径的材料数字与落盘一致（state.json 不丢）',
    (() => {
      const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
      return JSON.stringify(saved?.lastRun?.material) === JSON.stringify(lastRun?.material)
    })(), JSON.stringify(lastRun?.material))
  check('材料被 stats 记账后，成功路径能看到非零材料量（对方落地后强断言）',
    PEER_STATS_LANDED ? Object.values(lastRun.material).some(value => value > 0) : true,
    PEER_STATS_LANDED ? JSON.stringify(lastRun.material) : 'stats 未落地 → 只验形状')

  // 材料量必须**如实**可见：这里用可观测口径（`messages` / `picked` 现算）断言，
  // 所以不依赖 profile.js 的 stats 是否落地。
  const logText = fs.readFileSync(path.join(stateDir, 'plugin.log'), 'utf8')
  check('info 日志如实报出材料量（条数 + 字符 kept/collected，30 条 × 1000 字符）',
    logText.includes('材料 30 条（累计 30 条，字符 30000/30000）'),
    (logText.split('\n').find(line => line.includes('开始生成')) ?? '(没有"开始生成"日志)').slice(0, 170))
  check('日志里的材料量不含凭空编造的数字（stats 未落地时不报 chars=0 那种假话）',
    !/材料量 chars=0/.test(logText))
}

console.log('')
console.log('='.repeat(72))
console.log('F. T3 异步预热：apply() 不等它，但首次扫描必须等它')
console.log('='.repeat(72))
{
  const proto = SessionScanner.prototype
  const originalWarm = proto.warmFromCache
  const originalScan = proto.scan
  const hadAsync = 'warmFromCacheAsync' in proto

  const events = []
  let warmDone = false

  // 模拟对方即将新增的异步预热：语义与同步版一致（最终调用同步版），
  // 但**至少让出一个宏任务**，这样"apply() 有没有等它"才可观测。
  proto.warmFromCacheAsync = async function fakeWarmAsync(cursor) {
    events.push('warm:async-start')
    await new Promise(resolve => setTimeout(resolve, 5))
    this.warmFromCache(cursor)
    warmDone = true
    events.push('warm:async-done')
  }
  proto.warmFromCache = function patchedWarm(cursor) {
    events.push('warm:sync')
    return originalWarm.call(this, cursor)
  }
  proto.scan = function patchedScan(cursor) {
    events.push(warmDone ? 'scan:after-warm' : 'scan:BEFORE-warm')
    return originalScan.call(this, cursor)
  }

  try {
    const sessionsRoot = newDir('f-sessions')
    const stateDir = newDir('f-state')
    const { service } = boot({ stateDir, sessionsRoot, scanOnStart: true })

    check('apply() 同步返回：返回时预热还没跑（没有被 await 拖住）',
      warmDone === false && events.length === 0, `events=${JSON.stringify(events)}`)
    check('apply() 之后 state/路由/服务都已就绪（不因预热而推迟）',
      service != null && typeof service.getState === 'function')

    const scanned = await waitFor(() => events.includes('scan:after-warm') || events.includes('scan:BEFORE-warm'))
    check('首次扫描确实发生了', scanned === true, JSON.stringify(events))
    check('预热先于首次扫描收尾（顺序不能反：反了 lostMemory 会让全量重解）',
      events.indexOf('warm:async-done') >= 0 &&
        events.indexOf('warm:async-done') < events.indexOf('scan:after-warm'),
      JSON.stringify(events))
    check('首次扫描时 byFile 已经预热过（没有 BEFORE-warm）',
      !events.includes('scan:BEFORE-warm'), JSON.stringify(events))
    check('同步预热没有被 apply() 同步调用过（异步版存在时第一次预热发生在 apply 返回之后）',
      events.length > 0 && events[0] === 'warm:async-start',
      JSON.stringify(events))
    // 首次 tick 是"预热 → 扫描 → 算信号"整条链走完，所以这里等状态落地再断言
    const signalsLanded = await waitFor(() => service.host.store.state.lastSignals != null)
    check('首次 tick 也落了 lastSignals（预热不吞扫描）', signalsLanded === true,
      JSON.stringify(service.host.store.state.lastSignals))

    // ── 降级路径：没有异步版时必须**同步**预热（旧行为，逐字节保留） ──
    delete proto.warmFromCacheAsync
    events.length = 0
    warmDone = false
    const fallbackRoot = newDir('f-sessions-fallback')
    const fallbackState = newDir('f-state-fallback')
    boot({ stateDir: fallbackState, sessionsRoot: fallbackRoot })
    check('没有 warmFromCacheAsync 时：预热是同步的（apply() 返回前就调过）',
      events.includes('warm:sync'), JSON.stringify(events))
    check('降级路径不发异步预热', !events.includes('warm:async-start'), JSON.stringify(events))
  } finally {
    proto.warmFromCache = originalWarm
    proto.scan = originalScan
    if (!hadAsync) delete proto.warmFromCacheAsync
  }
}

console.log('')
console.log('='.repeat(72))
console.log('G. 形状与契约（T4 的 /state 字段位 + T2 的调用契约）')
console.log('='.repeat(72))
{
  check('emptyState().lastRun 从一开始就有 material 字段位（界面按 lastRun.material 读不会炸）',
    'material' in emptyState().lastRun && emptyState().lastRun.material === null,
    JSON.stringify(emptyState().lastRun))

  // T2 的接线是"扫描路径传第三个参数 { details: false }"，从外部没法直接观测
  // （details 的开关在 lib/signals.js 那一侧，是另一个代理的改动）。这里按
  // "落地后必须成立"的契约写自适应断言：落地前只记录，落地后 `lean` 确实不再有 details。
  const probeSessionId = 'probe-session'
  const probeMap = probeBySession(probeSessionId, [humanMessage(1, 1000, '探测一条真人发言')])
  const signalsConfig = resolveConfig({}).signals
  const full = computeAllSignals(probeMap, signalsConfig)
  const lean = computeAllSignals(probeMap, signalsConfig, { details: false })
  const fullHasDetails = full.sessions[probeSessionId] != null && 'details' in full.sessions[probeSessionId]
  const leanHasDetails = lean.sessions[probeSessionId] != null && 'details' in lean.sessions[probeSessionId]
  check('不传第三个参数时仍拿到 details（单会话/界面那条路径的默认行为没变）', fullHasDetails,
    `sessions=${Object.keys(full.sessions).join(',')}`)
  check('关掉 details 不改变 totals（本插件扫描路径读的就是 totals，数字不许漂）',
    JSON.stringify(lean.totals) === JSON.stringify(full.totals),
    leanHasDetails
      ? '对方改动未落地（details 仍被构造）→ 本插件照常传参，落地即省掉整包 details'
      : '对方改动已落地：扫描路径的整包 details 已被省掉')
  check('探测用的 bySession 形状与扫描路径一致（sessions 只统计有真人发言的会话）',
    full.totals.humanMessages === 1 && full.totals.sessions === 1,
    JSON.stringify(full.totals))
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`临时目录：${TMP_ROOT}`)
console.log('='.repeat(72))

if (fail === 0) {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* 清不掉也无所谓 */
  }
}
process.exit(fail === 0 ? 0 : 1)
