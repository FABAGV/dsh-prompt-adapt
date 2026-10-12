/**
 * 尾巴扫描 / 帧预算 / 轮转起点 / 明文回收 / 异步预热 / turn 位置性推导 的回归。
 *
 * 这些断言全部用**手工构造的多帧 zstd 文件**（`zlib.zstdCompressSync` 逐帧压完
 * 拼接），不碰任何真实会话日志，也不读用户的 `~/.dsh`：状态与语料都落在
 * `os.tmpdir()` 下的临时目录里。这样每条断言都只看一个变量，不受宿主并发追加
 * 的干扰（`test/selftest.mjs` 对付不了这一点，所以那边全是"活环境"形式的弱断言）。
 *
 * 覆盖：
 *   (a) 从游标 offset 起只扫尾巴 == 从 0 全量扫再过滤 `end > from`（逐帧一致），
 *       并且增量扫描真的只读 `[offset, size)` 这一段、不再 `readFileSync` 全文件
 *   (b) 帧预算 = 2 时只解压 2 帧、offset 只推进到第 2 帧末尾；结构扫描也被预算截断
 *       （用"第 6 帧位置放垃圾字节"证明：预算内不碰它，预算放开才撞上）
 *   (c) 段首 magic 非法（offset 落在帧中间）→ 退回全量扫 + warn，不猜
 *   (d) 轮转起点让"排最后"的文件在第二轮就被读到；每轮起点前移，不再位置性饥饿
 *   (e) 游标退休后 `plain/<sha1>.jsonl` 被回收，且有引用的那份不许动
 *   (f) `warmFromCacheAsync` 与 `warmFromCache` 语义完全一致（含缓存缺失/条数告警）
 *   (g) `turn/start` 在上一帧（甚至同会话的另一个文件）时，`user/message` 的 turn
 *       被位置性地补上；两个回合各自拿到自己的 turn
 *   (h) `maxOutputLength` 真的拦得住解压炸弹
 *
 * 运行：
 *   node test/scan-tail.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { SessionScanner, listSessionFiles, normalizeInto } from '../lib/sessions.js'
import { scanZstdFrames, decompressFrame, ZSTD_MAGIC } from '../lib/frames.js'

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
function section(title) {
  console.log('')
  console.log('='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

const tmpRoots = []
function newRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pa-${tag}-`))
  tmpRoots.push(root)
  return root
}

/** 每个 batch 一个独立 zstd 帧（与宿主格式一致）。 */
function framesOf(batches, { checksum = false } = {}) {
  return batches.map(lines => {
    const text = lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
    const body = Buffer.from(text, 'utf8')
    return checksum
      ? zlib.zstdCompressSync(body, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
      : zlib.zstdCompressSync(body)
  })
}
function writeLog(file, batches, options) {
  const parts = framesOf(batches, options)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat(parts))
  return parts
}
function plainFile(plainDir, rel) {
  return path.join(plainDir, crypto.createHash('sha1').update(rel).digest('hex') + '.jsonl')
}
function makeScanner(root, plainDir, maxFramesPerScan = 1e9) {
  const warns = []
  const debugs = []
  const log = {
    debug: message => debugs.push(String(message)),
    info() {},
    warn: message => warns.push(String(message)),
    error: message => warns.push(`ERROR ${message}`),
  }
  const scanner = new SessionScanner({
    sessionsRoot: root,
    plainDir,
    maxWindowSize: 64 << 20,
    maxFramesPerScan,
    log,
  })
  return { scanner, warns, debugs }
}
function humanMessage(seq, time, text) {
  return { type: 'user/message', seq, time, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
/**
 * 调 `warmFromCacheAsync`；实现上没这个方法时返回已 resolve 的 Promise。
 * 目的是"缺了异步版"报成断言失败，而不是让整份测试在 TypeError 上崩掉。
 */
function warmIfSupported(scanner, cursor) {
  return typeof scanner.warmFromCacheAsync === 'function'
    ? scanner.warmFromCacheAsync(cursor, { yieldEvery: 1 })
    : Promise.resolve(null)
}
function turnStart(seq, time, turn) {
  return { type: 'turn/start', seq, time, data: { turn } }
}
const REL = path.join('proj', 'session-aaaa', 'session.v4.jsonl.zstd')
const REL_B = path.join('proj', 'session-bbbb', 'session.v4.jsonl.zstd')
const REL_C = path.join('proj', 'session-cccc', 'session.v4.jsonl.zstd')

// ── (a) 尾巴扫描 vs 全量扫 + 过滤 ────────────────────────────────
section('(a) 从游标处扫尾巴 == 从 0 全量扫再过滤 end > from')
{
  const batches = [
    [humanMessage(1, 1000, 'm1')],
    [humanMessage(2, 2000, 'm2')],
    [humanMessage(3, 3000, 'm3')],
    [humanMessage(4, 4000, 'm4')],
    [humanMessage(5, 5000, 'm5')],
  ]
  const full = Buffer.concat(framesOf(batches, { checksum: true }))
  const { frames: all } = scanZstdFrames(full)
  check('全量扫出 5 帧', all.length === 5, `${all.length} 帧 / ${full.length} 字节`)

  for (const from of all.slice(0, 4).map(frame => frame.end)) {
    // 只把尾巴那一段交给扫描器（正是 #decode 的做法），并把 base 传进去
    const tail = scanZstdFrames(full.subarray(from), Number.POSITIVE_INFINITY, from)
    const filtered = all.filter(frame => frame.end > from)
    check(`offset=${from}：尾部扫描与"全量过滤"逐帧一致`,
      JSON.stringify(tail.frames) === JSON.stringify(filtered),
      `${tail.frames.length} 帧 vs ${filtered.length} 帧`)
    check(`offset=${from}：完整文件的尾巴不该报 tornStart`, tail.tornStart === undefined)
    // 偏移换算：段内 buffer + base 必须解出与整文件 buffer 完全相同的明文。
    // 包 try/catch：实现不支持 base offset 时这里会抛（旧实现的 subarray 会切到
    // 非法帧），抛错本身就算这条断言失败 —— 让整份测试继续跑完、把所有红都报出来，
    // 比在第一处 throw 上直接崩掉更有用。
    let same = false
    try {
      same = filtered.every(frame =>
        decompressFrame(full.subarray(from), frame, 64 << 20, from) ===
          decompressFrame(full, frame, 64 << 20))
    } catch {
      same = false
    }
    check(`offset=${from}：base offset 换算后明文逐字节一致`, same)
  }
  check('段首 magic 就是帧边界（本测试的构造前提）',
    all.every(frame => full.readUInt32LE(frame.start) === ZSTD_MAGIC))
}

section('(a2) 增量扫描只读 [offset, size) 这一段，不再 readFileSync 整个文件')
{
  const root = newRoot('tailread')
  const plainDir = path.join(root, '_plain')
  const file = path.join(root, REL)
  const batches = [
    [humanMessage(1, 1000, 'm1')],
    [humanMessage(2, 2000, 'm2')],
    [humanMessage(3, 3000, 'm3')],
    [humanMessage(4, 4000, 'm4')],
  ]
  const parts = writeLog(file, batches)
  const { scanner } = makeScanner(root, plainDir)
  const cursor = { version: 1, files: {} }
  scanner.scan(cursor) // 首扫必然走全量（游标为 0 / 内存集为空）
  const before = fs.statSync(file).size
  check('首扫后水位 = 文件字节数', cursor.files[REL].offset === before, `${cursor.files[REL].offset}`)

  // 追加第 5 帧，然后在"只应该读尾巴"的这一轮上装探针
  fs.appendFileSync(file, parts[0].subarray(0, 0)) // no-op，保持 parts 语义清晰
  const extra = framesOf([[humanMessage(5, 5000, 'm5')]])[0]
  fs.appendFileSync(file, extra)
  const size = fs.statSync(file).size

  const realReadFileSync = fs.readFileSync
  const realReadSync = fs.readSync
  const fileReads = []
  const ranges = []
  fs.readFileSync = function probeReadFileSync(target, ...rest) {
    if (String(target) === String(file)) fileReads.push(String(target))
    return realReadFileSync.call(fs, target, ...rest)
  }
  fs.readSync = function probeReadSync(fd, buffer, offset, length, position) {
    ranges.push({ offset, length, position })
    return realReadSync.call(fs, fd, buffer, offset, length, position)
  }
  let s2
  try {
    s2 = scanner.scan(cursor)
  } finally {
    fs.readFileSync = realReadFileSync
    fs.readSync = realReadSync
  }

  check('增量轮没有 readFileSync 会话日志（只读了尾巴那一段）',
    fileReads.length === 0, fileReads.length ? `仍然读了整个文件 ${fileReads.length} 次` : 'readFileSync 0 次')
  const requested = ranges.reduce((sum, range) => sum + range.length, 0)
  check('readSync 的窗口正好是 [offset, size)',
    ranges.length > 0 && ranges[0].position === before && requested === size - before,
    `position=${ranges[0]?.position}（期望 ${before}），合计读 ${requested} 字节（期望 ${size - before}）`)
  check('只解压了新帧，水位推进到文件末尾',
    s2.newFrames === 1 && cursor.files[REL].offset === size,
    `newFrames=${s2.newFrames} offset=${cursor.files[REL].offset}/${size}`)
}

// ── (b) 帧预算既是解压上界也是扫描上界 ──────────────────────────
section('(b) 帧预算 = 2：只解压 2 帧，offset 停在第 2 帧末尾')
{
  const root = newRoot('budget')
  const plainDir = path.join(root, '_plain')
  const file = path.join(root, REL)
  const batches = [
    [humanMessage(1, 1000, 'm1')],
    [humanMessage(2, 2000, 'm2')],
    [humanMessage(3, 3000, 'm3')],
    [humanMessage(4, 4000, 'm4')],
    [humanMessage(5, 5000, 'm5')],
  ]
  const parts = framesOf(batches)
  const full = Buffer.concat(parts)
  const { frames: all } = scanZstdFrames(full)
  // 第 5 帧之后再放一段**结构非法**的字节：如果结构扫描不按预算停下，它必定撞上这里
  const garbage = Buffer.from('this-is-not-a-zstd-frame-at-all')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([full, garbage]))

  const { scanner, warns } = makeScanner(root, plainDir, 2)
  const cursor = { version: 1, files: {} }
  const s1 = scanner.scan(cursor)
  const firstEntry = cursor.files[REL]
  check('预算 = 2 → 只解压 2 帧', s1.newFrames === 2, `${s1.newFrames} 帧 / ${s1.newEvents} 事件`)
  check('offset 只推进到第 2 帧末尾（不是文件末尾）',
    firstEntry?.offset === all[1].end && firstEntry?.offset !== fs.statSync(file).size,
    `offset=${firstEntry?.offset}，第 2 帧末尾=${all[1].end}，文件=${fs.statSync(file).size}`)
  check('内存事件集也只有这 2 条', scanner.byFile.get(REL)?.length === 2,
    `${scanner.byFile.get(REL)?.length} 条`)
  check('预算内没有碰到尾巴里的垃圾（结构扫描被 maxFrames 截断）',
    s1.errors === 0 && !warns.some(w => w.includes('invalid frame magic')),
    `errors=${s1.errors}`)

  // 对照：把预算放开，一定会撞上那段垃圾 —— 证明它确实非法，
  // 也就是说上一轮"没报错"真的是因为扫描在预算处停下了，而不是垃圾恰好合法。
  scanner.maxFramesPerScan = 1e9
  const s2 = scanner.scan(cursor)
  check('预算放开后终于撞上垃圾并报错（对照成立）', s2.errors === 1, `errors=${s2.errors}`)
  check('错误文案里的偏移是**整文件**偏移（不是段内偏移）',
    warns.some(w => w.includes(`invalid frame magic at byte ${full.length}`)),
    `期望出现 byte ${full.length}；实际 ${JSON.stringify(warns.slice(-1))}`)
  check('抛错的那一轮不推进水位', cursor.files[REL]?.offset === all[1].end,
    `offset=${cursor.files[REL]?.offset}`)
}

// ── (c) 段首 magic 非法 → 退回全量扫 ────────────────────────────
section('(c) 游标落在帧中间（段首不是 magic）→ 退回全量扫 + warn')
{
  const root = newRoot('fallback')
  const plainDir = path.join(root, '_plain')
  const file = path.join(root, REL)
  const batches = [
    [humanMessage(1, 1000, 'm1')],
    [humanMessage(2, 2000, 'm2')],
    [humanMessage(3, 3000, 'm3')],
    [humanMessage(4, 4000, 'm4')],
  ]
  const parts = writeLog(file, batches)
  const full = Buffer.concat(parts)
  const { frames: all } = scanZstdFrames(full)
  const { scanner, warns } = makeScanner(root, plainDir)
  const cursor = { version: 1, files: {} }
  scanner.scan(cursor)

  // 把水位改到第 2 帧 payload 中间：模拟老版本游标语义 / 外部动过文件。
  // 内存集还在（byFile 有它），所以不会走 lostMemory 的全量重建分支。
  const from = all[1].start + 5
  cursor.files[REL].offset = from
  const realReadFileSync = fs.readFileSync
  let fullReads = 0
  fs.readFileSync = function probeReadFileSync(target, ...rest) {
    if (String(target) === String(file)) fullReads += 1
    return realReadFileSync.call(fs, target, ...rest)
  }
  let s
  try {
    s = scanner.scan(cursor)
  } finally {
    fs.readFileSync = realReadFileSync
  }

  check('段首不是 magic 时报了 warn（不猜）', warns.some(w => w.includes('不是帧边界')),
    JSON.stringify(warns.filter(w => w.includes('不是帧边界'))))
  check('退回全量扫（readFileSync 了整个文件）', fullReads === 1, `${fullReads} 次`)
  check('没有把它当成错误（全量扫是正常兜底路径）', s.errors === 0, `errors=${s.errors}`)
  check('含 from 的那一帧 + 之后所有帧都被解压，水位回到文件末尾',
    s.newFrames === 3 && cursor.files[REL].offset === full.length,
    `newFrames=${s.newFrames} offset=${cursor.files[REL].offset}/${full.length}`)
  const again = scanner.scan(cursor)
  check('下一轮恢复正常的尾巴路径（零新帧）', again.newFrames === 0 && again.errors === 0,
    `newFrames=${again.newFrames}`)
}

// ── (d) 轮转起点 ────────────────────────────────────────────────
section('(d) 轮转起点：排最后的文件第二轮就被读到')
{
  const root = newRoot('rotor')
  const plainDir = path.join(root, '_plain')
  writeLog(path.join(root, REL), [
    [humanMessage(1, 1000, 'a1')],
    [humanMessage(2, 2000, 'a2')],
    [humanMessage(3, 3000, 'a3')],
  ])
  writeLog(path.join(root, REL_B), [
    [humanMessage(1, 1000, 'b1')],
    [humanMessage(2, 2000, 'b2')],
    [humanMessage(3, 3000, 'b3')],
  ])
  const listed = listSessionFiles(root).map(info => info.rel)
  const first = listed[0]
  const last = listed[listed.length - 1]
  check('构造了两个文件，且能区分"排第一/排最后"', listed.length === 2 && first !== last,
    `${first} → ${last}`)

  const { scanner } = makeScanner(root, plainDir, 2)
  const cursor = { version: 1, files: {} }
  const s1 = scanner.scan(cursor)
  // ⚠️ 被跳过的文件不是"没有游标条目"：scan() 会给它落一条占位条目
  // `{offset:0, plain:null, events:0}`（`changed:false` 的 else 分支），
  // 关键是它 **一个帧都没解**，也没有声明明文缓存（plain 保持 null）。
  check('第一轮：预算耗在第一个文件上，最后一个文件一个帧都没读到',
    s1.skipped === 1 && (cursor.files[last]?.offset ?? 0) === 0 &&
      cursor.files[last]?.plain === null && (cursor.files[first]?.offset ?? 0) > 0,
    `skipped=${s1.skipped} first.offset=${cursor.files[first]?.offset} ` +
      `last=${JSON.stringify(cursor.files[last] ?? null)}`)
  check('轮转起点记在 cursor.rotor 上（= 本轮第一个没读到的文件）',
    cursor.rotor === last, `rotor=${cursor.rotor}`)

  const s2 = scanner.scan(cursor)
  check('第二轮：从轮转起点开始 → 排最后的文件被读到（不再等前面全部读完）',
    (cursor.files[last]?.offset ?? 0) > 0,
    `last.offset=${cursor.files[last]?.offset}，本轮解压 ${s2.newFrames} 帧`)
  check('第二轮把预算花在了它身上（第一个文件反而被跳过）',
    s2.skipped === 1 && cursor.rotor === first, `skipped=${s2.skipped} rotor=${cursor.rotor}`)
}

section('(d2) 三个文件 / 每轮 2 帧：3 轮内每个文件都不再是 offset = 0（旧实现要 5 轮以上）')
{
  const trace = []
  for (const tag of ['rr1', 'rr2']) {
    const root = newRoot(tag)
    const plainDir = path.join(root, '_plain')
    const rels = [REL, REL_B, REL_C]
    for (const rel of rels) {
      writeLog(path.join(root, rel), [
        [humanMessage(1, 1000, '1')],
        [humanMessage(2, 2000, '2')],
        [humanMessage(3, 3000, '3')],
      ])
    }
    const listed = listSessionFiles(root).map(info => info.rel)
    const { scanner } = makeScanner(root, plainDir, 2)
    const cursor = { version: 1, files: {} }
    const rounds = []
    for (let i = 0; i < 3; i += 1) {
      const stats = scanner.scan(cursor)
      rounds.push({
        newFrames: stats.newFrames,
        skipped: stats.skipped,
        rotor: cursor.rotor,
        started: Object.keys(cursor.files).length,
      })
    }
    const allStarted = listed.every(rel => (cursor.files[rel]?.offset ?? 0) > 0)
    const rotorWalks = rounds.every((round, i) => round.rotor === listed[(i + 1) % listed.length])
    if (tag === 'rr1') {
      check('3 轮内三个文件都至少解压过帧（位置性饥饿消失）', allStarted,
        listed.map(rel => `${rel.split(path.sep)[1]}=${cursor.files[rel]?.offset ?? 0}`).join(' '))
      check('轮转起点按文件顺序往前走（listed[0] → listed[1] → listed[2]）', rotorWalks,
        rounds.map(round => `rotor=${round.rotor?.split(path.sep)[1]}`).join(' | '))
    }
    trace.push(JSON.stringify(rounds))
  }
  check('同样输入 → 同样顺序（确定性）', trace[0] === trace[1], trace[0])
}

// ── (e) 明文缓存回收 ────────────────────────────────────────────
section('(e) 游标退休后明文缓存被回收，被引用的那份不动')
{
  const root = newRoot('reclaim')
  const plainDir = path.join(root, '_plain')
  writeLog(path.join(root, REL), [[humanMessage(1, 1000, 'a')]])
  writeLog(path.join(root, REL_B), [[humanMessage(1, 1000, 'b')]])
  const { scanner } = makeScanner(root, plainDir)
  const cursor = { version: 1, files: {} }
  scanner.scan(cursor)
  const plainA = plainFile(plainDir, REL)
  const plainB = plainFile(plainDir, REL_B)
  check('预备条件：两份明文缓存都在', fs.existsSync(plainA) && fs.existsSync(plainB))

  // 会话目录里删掉 B（retire 路径要求文件真的不在磁盘上）
  fs.rmSync(path.join(root, REL_B))
  const s = scanner.scan(cursor)
  check('B 的游标条目与内存集都退休了',
    cursor.files[REL_B] === undefined && !scanner.byFile.has(REL_B),
    `errors=${s.errors}`)
  check('B 的明文缓存被回收（以前会永久残留）', !fs.existsSync(plainB), plainB)
  check('仍有游标引用的 A 的缓存不许动',
    fs.existsSync(plainA) && cursor.files[REL] !== undefined, plainA)

  // 游标是磁盘上的 JSON，可能被改坏。名字带 `../` 时删除动作不许跑出 plain/。
  {
    const outside = path.join(root, 'outside-target.jsonl')
    fs.writeFileSync(outside, 'must-not-be-deleted', 'utf8')
    const escapeCursor = {
      version: 1,
      files: { [REL_C]: { offset: 0, plain: `..${path.sep}outside-target.jsonl`, events: 0 } },
    }
    const { scanner: escapeCase, debugs } = makeScanner(root, plainDir)
    escapeCase.scan(escapeCursor)
    check('明文缓存名带 ../ 时拒绝回收（删除动作不会跑出 plain/）',
      fs.existsSync(outside) && debugs.some(message => message.includes('拒绝回收')),
      debugs.filter(message => message.includes('拒绝回收')).join(' | '))
  }
}

// ── (f) warmFromCacheAsync ≡ warmFromCache ─────────────────────
section('(f) warmFromCacheAsync 与 warmFromCache 语义完全一致')
{
  const root = newRoot('warm')
  const plainDir = path.join(root, '_plain')
  writeLog(path.join(root, REL), [
    [humanMessage(1, 1000, 'a1')],
    [humanMessage(2, 2000, 'a2')],
  ])
  writeLog(path.join(root, REL_B), [[humanMessage(1, 1000, 'b1')]])
  const { scanner } = makeScanner(root, plainDir)
  const cursor = { version: 1, files: {} }
  scanner.scan(cursor)

  const snapshot = () => JSON.parse(JSON.stringify(cursor))
  const syncCursor = snapshot()
  const asyncCursor = snapshot()
  const syncCase = makeScanner(root, plainDir)
  const asyncCase = makeScanner(root, plainDir)
  const supportsAsync = typeof asyncCase.scanner.warmFromCacheAsync === 'function'
  check('scanner 暴露 warmFromCacheAsync（调用点用 typeof 判断后调用）', supportsAsync)
  syncCase.scanner.warmFromCache(syncCursor)
  const returned = supportsAsync
    ? asyncCase.scanner.warmFromCacheAsync(asyncCursor, { yieldEvery: 1 })
    : null
  check('warmFromCacheAsync 返回 Promise（调用点可以 await）', returned instanceof Promise)
  if (returned) await returned

  const dump = map => JSON.stringify([...map.entries()])
  check('同步/异步预热出来的 byFile 内容一致',
    dump(syncCase.scanner.byFile) === dump(asyncCase.scanner.byFile),
    `${syncCase.scanner.byFile.size} 个文件`)
  check('预热确实读到了事件（不是两个空 Map 相等）',
    syncCase.scanner.byFile.size === 2 && syncCase.scanner.byFile.get(REL).length === 2,
    `${syncCase.scanner.byFile.get(REL)?.length} 条`)

  // 缓存缺失：两个版本都必须"warn + 作废该文件游标"，且文案一致
  fs.rmSync(plainFile(plainDir, REL))
  const syncMiss = snapshot()
  const asyncMiss = snapshot()
  const syncCase2 = makeScanner(root, plainDir)
  const asyncCase2 = makeScanner(root, plainDir)
  syncCase2.scanner.warmFromCache(syncMiss)
  await warmIfSupported(asyncCase2.scanner, asyncMiss)
  check('缓存缺失时两个版本都打了同样的 warn',
    syncCase2.warns.length === 1 && syncCase2.warns[0] === asyncCase2.warns[0] &&
      syncCase2.warns[0].includes('明文缓存缺失'),
    JSON.stringify(syncCase2.warns))
  check('缓存缺失时两个版本都把该文件的游标作废（offset/plain/events 归零）',
    JSON.stringify(syncMiss.files[REL]) === JSON.stringify(asyncMiss.files[REL]) &&
      syncMiss.files[REL].offset === 0 && syncMiss.files[REL].plain === null &&
      syncMiss.files[REL].events === 0,
    JSON.stringify(syncMiss.files[REL]))
  check('缺失的那个文件不写进 byFile，另一个照旧还原',
    !syncCase2.scanner.byFile.has(REL) && !asyncCase2.scanner.byFile.has(REL) &&
      syncCase2.scanner.byFile.has(REL_B) && asyncCase2.scanner.byFile.has(REL_B))

  // 条数不一致：两个版本的告警也要一致。这一段用**全新的语料**，
  // 否则会先撞上上一段留下的"缓存缺失"（那是另一条告警，测不出这里的东西）。
  {
    const root2 = newRoot('warm-dup')
    const plainDir2 = path.join(root2, '_plain')
    writeLog(path.join(root2, REL_B), [[humanMessage(1, 1000, 'b1')]])
    const { scanner: seed } = makeScanner(root2, plainDir2)
    const seedCursor = { version: 1, files: {} }
    seed.scan(seedCursor)
    // 模拟"追加明文之后、存游标之前"被打断：缓存里多出一份重复明文
    const plainB = plainFile(plainDir2, REL_B)
    fs.appendFileSync(plainB, fs.readFileSync(plainB))

    const syncDup = JSON.parse(JSON.stringify(seedCursor))
    const asyncDup = JSON.parse(JSON.stringify(seedCursor))
    const syncCase3 = makeScanner(root2, plainDir2)
    const asyncCase3 = makeScanner(root2, plainDir2)
    syncCase3.scanner.warmFromCache(syncDup)
    await warmIfSupported(asyncCase3.scanner, asyncDup)
    check('条数不一致时两个版本都报了同一条告警',
      syncCase3.warns.length === 1 && syncCase3.warns[0] === asyncCase3.warns[0] &&
        syncCase3.warns[0].includes('不一致'),
      JSON.stringify(syncCase3.warns))
  }
}

// ── (g) turn 位置性推导 ─────────────────────────────────────────
section('(g) turn 位置性推导：user/message 的 turn 由排序后的位置补上')
{
  // g1: turn/start 在上一帧
  {
    const root = newRoot('turn1')
    const plainDir = path.join(root, '_plain')
    writeLog(path.join(root, REL), [
      [turnStart(1, 1000, 7)],
      [humanMessage(2, 2000, 'hi')],
    ])
    const { scanner } = makeScanner(root, plainDir)
    scanner.scan({ version: 1, files: {} })
    const events = scanner.bySession().get('session-aaaa')
    const human = events.find(event => event.type === 'user/message')
    check('turn/start 在上一帧 → user/message 的 turn 被补成 7',
      human?.turn === 7, `turn=${human?.turn}`)
    check('补 turn 是幂等的（再取一次 bySession 结果相同）',
      scanner.bySession().get('session-aaaa').find(event => event.type === 'user/message')?.turn === 7)
  }

  // g2: 同一会话内两个回合，各自的 user/message 拿到各自的 turn
  {
    const root = newRoot('turn2')
    const plainDir = path.join(root, '_plain')
    writeLog(path.join(root, REL), [
      [turnStart(1, 1000, 1), humanMessage(2, 2000, 'first')],
      [turnStart(3, 3000, 2)],
      [humanMessage(4, 4000, 'second')],
    ])
    const { scanner } = makeScanner(root, plainDir)
    scanner.scan({ version: 1, files: {} })
    const humans = scanner.bySession().get('session-aaaa').filter(event => event.type === 'user/message')
    check('两个回合的 user/message 各自拿到自己的 turn',
      humans.length === 2 && humans[0].turn === 1 && humans[1].turn === 2,
      humans.map(event => event.turn).join(','))
  }

  // g3: 流开头还没有任何回合标记 → 保持 null（不许凭空造 turn）
  {
    const root = newRoot('turn3')
    const plainDir = path.join(root, '_plain')
    writeLog(path.join(root, REL), [
      [humanMessage(1, 1000, 'before')],
      [turnStart(2, 2000, 1)],
      [humanMessage(3, 3000, 'after')],
    ])
    const { scanner } = makeScanner(root, plainDir)
    scanner.scan({ version: 1, files: {} })
    const humans = scanner.bySession().get('session-aaaa').filter(event => event.type === 'user/message')
    check('第一个回合标记之前的发言保持 turn = null，之后的才补上',
      humans.length === 2 && humans[0].turn === null && humans[1].turn === 1,
      humans.map(event => event.turn).join(','))
  }

  // g4: turn/start 在**另一个明文缓存文件**里（同一 sessionId 的 v3/v4）——
  // 这是"必须放在 bySession() 而不是单帧内推"的直接证据
  {
    const root = newRoot('turn4')
    const plainDir = path.join(root, '_plain')
    const dir = path.join(root, 'proj', 'session-aaaa')
    writeLog(path.join(dir, 'session.v3.jsonl.zstd'), [[turnStart(1, 1000, 5)]])
    writeLog(path.join(dir, 'session.v4.jsonl.zstd'), [[humanMessage(2, 2000, 'cross-file')]])
    const { scanner } = makeScanner(root, plainDir)
    scanner.scan({ version: 1, files: {} })
    const humans = scanner.bySession().get('session-aaaa').filter(event => event.type === 'user/message')
    check('turn/start 在同会话的另一个文件里也能被位置性推导出来',
      humans.length === 1 && humans[0].turn === 5, `turn=${humans[0]?.turn}`)
  }

  // g5: 归一化本身没被改动 —— 单帧 normalizeInto 出来的 user/message turn 仍是 null
  {
    const records = []
    normalizeInto(records, [humanMessage(1, 1000, 'x')], 's', 0)
    check('normalizeInto 的语义没变（user/message 单帧内 turn 仍是 null）',
      records.length === 1 && records[0].turn === null, `turn=${records[0]?.turn}`)
  }
}

// ── (h) 解压炸弹防御 ───────────────────────────────────────────
section('(h) maxOutputLength 拦得住解压炸弹')
{
  // 70MiB 的全零 → 压缩成一个很小的合法帧，但明文超过 64MiB 的输出上限
  const bomb = zlib.zstdCompressSync(Buffer.alloc(70 << 20))
  check('炸弹帧本身很小（压缩比极高，窗口上限拦不住它）', bomb.length < 64 << 10,
    `${bomb.length} 字节 → 70MiB 明文`)
  let caught = null
  try {
    decompressFrame(bomb, { start: 0, end: bomb.length }, 64 << 20)
  } catch (error) {
    caught = error
  }
  check('超限帧被拦下并包成 "corrupt ... failed validation"',
    caught !== null && caught.message.includes('failed validation'), caught?.message)
  check('根因是 ERR_BUFFER_TOO_LARGE（不是别的失败）',
    caught?.cause?.code === 'ERR_BUFFER_TOO_LARGE', String(caught?.cause?.code ?? caught?.cause?.message))
}

// ── 收尾 ───────────────────────────────────────────────────────
for (const root of tmpRoots) {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论
  }
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))
process.exit(fail === 0 ? 0 : 1)
