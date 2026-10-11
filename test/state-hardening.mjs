/**
 * `lib/state.js` 的落盘 / 加载边界自检。
 *
 * 盯的是三件在正常路径上永远看不到、出事就是"用户数据没了"的事：
 *   1. 原子写的临时文件名是否**每个进程独立**（固定名会被第二个宿主进程 rename 走）
 *   2. 读不动 / 解析不出来的 `state.json` 会不会被**下一次写盘静默覆盖**
 *   3. 半损坏（类型不对）的字段会不会让 `effective()` 抛 —— 抛了就是每次 GET /state 500
 *
 * ⚠️ 只在自己建的临时目录里跑，不碰任何真实状态目录。
 * 运行：node test/state-hardening.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StateStore, MODE, emptyState } from '../lib/state.js'
import { renderProfileText } from '../lib/profile.js'

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-adapt-state-'))
const logLines = []
const log = {
  debug: (...a) => logLines.push(['debug', a.join(' ')]),
  info: (...a) => logLines.push(['info', a.join(' ')]),
  warn: (...a) => logLines.push(['warn', a.join(' ')]),
  error: (...a) => logLines.push(['error', a.join(' ')]),
}
const dirFor = (name) => {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const statePathIn = (dir) => path.join(dir, 'state.json')
const corruptFilesIn = (dir) =>
  fs.readdirSync(dir).filter(name => name.startsWith('state.json.corrupt-'))
const makeStore = (dir) => {
  const store = new StateStore({ dir, log })
  store.setProfileRenderer(renderProfileText)
  return store
}

console.log('='.repeat(72))
console.log('1. 原子写：临时文件名与残留')
console.log('='.repeat(72))
{
  const dir = dirFor('atomic')
  const store = makeStore(dir)

  // 抓 state.js 真正用的临时路径：它就是通过 `node:fs` 的默认导出调的，
  // 所以替换同一个对象上的方法就能看见（抓不到就让检查失败，不能"静默通过"）。
  const realWrite = fs.writeFileSync
  const realRename = fs.renameSync
  const writes = []
  const renames = []
  try {
    fs.writeFileSync = (file, ...rest) => { writes.push(String(file)); return realWrite(file, ...rest) }
    fs.renameSync = (from, to) => { renames.push([String(from), String(to)]); return realRename(from, to) }
    store.state.mode = MODE.CUSTOM
    store.state.customText = '请始终用中文回答。'
    store.saveState()
  } finally {
    fs.writeFileSync = realWrite
    fs.renameSync = realRename
  }

  const statePath = statePathIn(dir)
  check('抓到了原子写用的临时路径（抓不到就不算测过）',
    writes.length >= 1 && renames.length >= 1, `write=${writes.length} rename=${renames.length}`)

  const tmpPath = renames[0]?.[0] ?? ''
  check('临时文件名带进程号（两个宿主进程共用 DSH_HOME 时不会互相 rename）',
    tmpPath.includes(`.${process.pid}.`), tmpPath || '(没抓到)')
  check('临时文件与目标同目录（rename 才是同分区原子操作）',
    path.dirname(tmpPath) === dir && renames[0]?.[1] === statePath,
    `${path.dirname(tmpPath)} → ${renames[0]?.[1]}`)
  check('写盘后没有留下临时文件',
    fs.readdirSync(dir).every(name => !name.endsWith('.tmp')),
    fs.readdirSync(dir).join(', '))
  check('写盘后 state.json 是完整合法 JSON',
    JSON.parse(fs.readFileSync(statePath, 'utf8')).customText === '请始终用中文回答。')
}

console.log('')
console.log('='.repeat(72))
console.log('2. 读不动的 state.json：留档而不是被覆盖')
console.log('='.repeat(72))
{
  // 真实构造：一次被中断的写盘留下的半个 JSON —— 前面是完整字段，尾部断掉。
  // 里面带着用户手写的自定义文本，这是"被覆盖掉就回不来"的那部分数据。
  const dir = dirFor('corrupt')
  const good = {
    version: 1, mode: 'custom', customText: '用户非常重要的自定义文本，丢了要重打三千字。',
    profile: { version: 3, entries: [{ id: 'A1', category: 'A', claim: '用中文沟通' }] },
    autoExtraText: '', copiedSnapshot: { text: null, at: null, profileVersion: null },
    lastGeneration: { at: null, humanMessages: 0, sessions: 0 }, lastSignals: null,
    lastRun: { at: null, ok: null, reason: '', error: null, spuriousRate: null, diff: null },
    updatedAt: 0,
  }
  const torn = JSON.stringify(good, null, 2).slice(0, 200) // 半写：JSON.parse 一定抛
  fs.writeFileSync(statePathIn(dir), torn, 'utf8')
  let parseThrew = false
  try { JSON.parse(torn) } catch { parseThrew = true }
  check('构造的确实是"半个 JSON"', parseThrew, `${torn.length} 字节`)

  const store = makeStore(dir)
  const kept = corruptFilesIn(dir)
  check('读不出来时原文件被留档（不是被丢弃）', kept.length === 1, kept.join(', '))
  check('留档内容与原来那份**逐字节一致**',
    kept.length === 1 && fs.readFileSync(path.join(dir, kept[0]), 'utf8') === torn)
  check('留档里还能人工认出用户数据',
    kept.length === 1 && fs.readFileSync(path.join(dir, kept[0]), 'utf8').includes('用户非常重要的自定义文本'))
  check('留档路径写进了日志（用户能知道去哪找）',
    logLines.some(([, line]) => line.includes('原文件已留档为')), '')
  check('留档后以空白状态启动（不假装读到了半份数据）',
    store.state.mode === MODE.AUTO && store.state.customText === '' && store.state.profile === null)

  store.state.mode = MODE.CUSTOM
  store.state.customText = '状态仍然可用'
  store.saveState()
  check('留档之后插件继续可用：新的 state.json 是合法 JSON',
    JSON.parse(fs.readFileSync(statePathIn(dir), 'utf8')).customText === '状态仍然可用')
  check('留档文件没有被这次写盘清掉（用户还有得救）', corruptFilesIn(dir).length === 1)

  // 0 字节（断电 / 被外部工具清空）同样不能静默吞掉
  const dir2 = dirFor('empty')
  fs.writeFileSync(statePathIn(dir2), '', 'utf8')
  makeStore(dir2)
  check('0 字节的 state.json 也留档', corruptFilesIn(dir2).length === 1, corruptFilesIn(dir2).join(', '))
}

console.log('')
console.log('='.repeat(72))
console.log('3. 合法 JSON 但取值不合法：不误伤、不覆盖')
console.log('='.repeat(72))
{
  // 这条与 selftest 第 10 节的既有用例同形：非法 mode 必须**兜回 auto**，
  // 而且它是"能读"的文件，不该被当成损坏留档。
  const dir = dirFor('badmode')
  fs.writeFileSync(statePathIn(dir), JSON.stringify({ mode: 'both', customText: 'x' }), 'utf8')
  const store = makeStore(dir)
  check('非法 mode 仍然兜回 auto（既有语义不变）', store.state.mode === MODE.AUTO)
  check('能读的文件不会被留档（不误伤）', corruptFilesIn(dir).length === 0, corruptFilesIn(dir).join(', '))
  check('能读的字段仍然保留', store.state.customText === 'x')
}

console.log('')
console.log('='.repeat(72))
console.log('4. 半损坏字段不能让 effective() 抛')
console.log('='.repeat(72))
{
  // 4a. customText 不是字符串：effective() 会调 .trim()
  const dir = dirFor('badtext')
  fs.writeFileSync(statePathIn(dir),
    JSON.stringify({ mode: 'custom', customText: 12345, autoExtraText: {} }), 'utf8')
  const store = makeStore(dir)
  let threw = null
  let effective = null
  try { effective = store.effective() } catch (error) { threw = error }
  check('customText/autoExtraText 类型不对时 effective() 不抛', threw === null, threw?.message ?? '')
  check('类型不对时按空文本处理', effective?.text === '' && store.state.customText === '')
  check('兜底写进了日志', logLines.some(([, line]) => line.includes('不是字符串')))

  // 4b. 画像形状不对：渲染器会 entries.filter(...) → TypeError
  const dir2 = dirFor('badprofile')
  const weird = { version: 2, entries: { 这不是: '数组' } }
  fs.writeFileSync(statePathIn(dir2),
    JSON.stringify({ mode: 'auto', profile: weird, autoExtraText: '补充说明还在' }), 'utf8')
  const store2 = makeStore(dir2)
  let threw2 = null
  let eff2 = null
  try { eff2 = store2.effective() } catch (error) { threw2 = error }
  check('画像形状不对时 effective() 不抛（不修的话这里会 TypeError）',
    threw2 === null, threw2 ? `${threw2.constructor.name}: ${threw2.message}` : '')
  check('渲染失败只让画像部分为空，autoExtraText 照旧生效',
    eff2?.text === '补充说明还在', JSON.stringify(eff2?.text))
  check('画像原文没有被销毁（仍在状态里，GET /state 还能看到它，用户能自己修）',
    store2.state.profile != null && JSON.stringify(store2.state.profile) === JSON.stringify(weird),
    JSON.stringify(store2.state.profile))
  check('渲染失败写进了日志', logLines.some(([, line]) => line.includes('画像渲染失败')))

  // 4c. 正常画像不受影响（不回归）
  const dir3 = dirFor('goodprofile')
  fs.writeFileSync(statePathIn(dir3), JSON.stringify({
    mode: 'auto',
    profile: { version: 1, entries: [{ id: 'A1', category: 'A', claim: '用中文沟通' }] },
  }), 'utf8')
  const store3 = makeStore(dir3)
  check('正常画像照旧渲染', store3.effective().text.includes('用中文沟通'))
  check('正常画像不会触发"渲染失败"日志', !logLines.some(([, line]) => line.includes('画像渲染失败') && line.includes('正常')))
}

console.log('')
console.log('='.repeat(72))
console.log('5. effective() 的边界组合（模式互斥：只能二选一）')
console.log('='.repeat(72))
{
  const dir = dirFor('boundary')
  const store = makeStore(dir)
  store.state.profile = { version: 1, entries: [{ id: 'A1', category: 'A', claim: '画像内容' }] }
  store.state.customText = '手写文本'
  store.state.autoExtraText = '补充说明'

  store.state.mode = MODE.AUTO
  check('模式1：画像 + 补充说明，手写文本不参与',
    store.effective().text === renderProfileText(store.state.profile) + '\n\n补充说明')
  store.state.profile = null
  check('模式1：画像为空时只剩补充说明（不是空串）', store.effective().text === '补充说明')
  store.state.autoExtraText = ''
  check('模式1：画像与补充说明都为空 → 空串', store.effective().text === '')
  store.state.mode = MODE.CUSTOM
  store.state.customText = ''
  check('模式2：文本为空 → 空串（不回落到画像）',
    store.effective().text === '' && store.effective().source === 'customText')
  store.state.customText = '  '
  check('模式2：全是空白 → 仍是空串（trim 后）', store.effective().text === '')
  check('模式2 下 autoExtraText 不参与生效', !store.effective().text.includes('补充说明'))
  store.state.mode = MODE.AUTO
  check('两个数据都在时，生效的仍然只有模式1 那一份',
    store.effective().source === 'profile' && store.effective().text === '')
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
} else {
  console.log(`临时目录留着看现场：${tmpRoot}`)
}
process.exit(fail === 0 ? 0 : 1)
