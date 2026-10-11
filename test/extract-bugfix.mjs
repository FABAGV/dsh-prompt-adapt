/**
 * 提取层（frames.js / sessions.js / signals.js）的边界回归测试。
 *
 * 与 selftest.mjs 的区别：这里**不碰真实会话目录**，全部用临时目录里合成的
 * zstd 分帧日志，专门盯游标水位、明文缓存、帧预算、列举失败这几条路径。
 *
 * 每一条都对应一个真实踩到过的边界（见同目录审查报告）：
 *   1. 帧预算耗尽时不许给没读过的文件落游标、不许清空明文缓存
 *   2. 截断（文件被重写变短）时的全量重建
 *   3. 会话目录列举失败 ≠ 文件已删除（不许清空游标）
 *   4. 坏 JSONL 行必须报出来再跳过
 *   5. 同一 sessionId 的多版本文件取并集 + 同键去重
 *   6. warmFromCache 发现明文缓存与游标水位条数不一致时要报警
 *   7. 末尾未完成帧（torn）不推进游标，补齐后只解一次
 *
 * 运行：node test/extract-bugfix.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { SessionScanner, normalizeInto, listSessionFiles } from '../lib/sessions.js'
import { scanZstdFrames, decompressFrame } from '../lib/frames.js'
import { computeSessionSignals, isHumanMessage } from '../lib/signals.js'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const eq = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: 期望 ${expected}，实际 ${actual}`)
}

/** 合成一条会话日志：每个 batch 一个独立 zstd 帧（与宿主格式一致）。 */
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
/** 与 writeLog 对应的明文（用于逐字节断言缓存内容）。 */
function plainTextOf(batches) {
  return batches
    .map(lines => lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n')
    .join('')
}
function newRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pa-extract-'))
}
function makeScanner(root, plainDir, maxFramesPerScan = 1e9) {
  const warns = []
  const log = {
    debug() {},
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
  return { scanner, warns }
}
function plainFile(plainDir, rel) {
  return path.join(plainDir, crypto.createHash('sha1').update(rel).digest('hex') + '.jsonl')
}
function humanMessage(seq, time, text) {
  return { type: 'user/message', seq, time, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
function turnStart(seq, time, turn) {
  return { type: 'turn/start', seq, time, data: { turn } }
}

const REL = path.join('proj', 'session-aaaa', 'session.v4.jsonl.zstd')
const REL_B = path.join('proj', 'session-bbbb', 'session.v4.jsonl.zstd')
const REL_C = path.join('proj', 'session-cccc', 'session.v4.jsonl.zstd')

console.log('=== 提取层边界回归 ===')

// ── 1. 帧预算耗尽 ────────────────────────────────────────────────
check('预算耗尽：不给没读过的文件落游标（不许出现 offset=0 却声明了 plain 的条目）', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  const batches = [[humanMessage(1, 1000, 'a1')], [humanMessage(2, 2000, 'a2')], [humanMessage(3, 3000, 'a3')]]
  writeLog(path.join(root, REL), batches)
  writeLog(path.join(root, REL_B), [[humanMessage(1, 1000, 'b1')], [humanMessage(2, 2000, 'b2')]])
  const { scanner, warns } = makeScanner(root, plainDir, 2)
  const cursor = { version: 1, files: {} }
  const s1 = scanner.scan(cursor)
  eq(s1.skipped > 0, true, `第一轮应当报出被预算挡下的文件（skipped=${s1.skipped}）`)
  const bogus = Object.entries(cursor.files).filter(([, e]) => e.offset === 0 && e.plain)
  eq(bogus.length, 0, `不该有条目声明了明文缓存却没读过（${JSON.stringify(bogus)}）`)
  assert(
    warns.some(w => w.includes('预算') && w.includes('未读')),
    `预算耗尽必须打日志，实际: ${JSON.stringify(warns)}`,
  )
  // 继续扫到本轮零新帧：事件不许永久丢
  let rounds = 0
  let last = s1
  while (last.newFrames > 0 && rounds < 30) {
    last = scanner.scan(cursor)
    rounds += 1
  }
  eq(last.newFrames, 0, `继续扫描直到不再有新帧（用了 ${rounds + 1} 轮）`)
  const bySession = scanner.bySession()
  const total = [...bySession.values()].reduce((n, list) => n + list.filter(isHumanMessage).length, 0)
  eq(total, 5, '饥饿过后 5 条真人发言必须一条不少')
  for (const [rel, e] of Object.entries(cursor.files)) {
    const size = fs.statSync(path.join(root, rel)).size
    eq(e.offset, size, `${rel} 读完后的水位应等于文件字节数`)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 2. 截断（文件被重写变短）────────────────────────────────────
check('截断 + 预算为 0：不许把明文缓存清空；预算恢复后按新内容重建', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  const file = path.join(root, REL)
  const four = [[humanMessage(1, 1000, 'x1')], [humanMessage(2, 2000, 'x2')], [humanMessage(3, 3000, 'x3')], [humanMessage(4, 4000, 'x4')]]
  const two = [[humanMessage(1, 1100, 'y1')], [humanMessage(2, 2200, 'y2')]]
  writeLog(file, four)
  const { scanner } = makeScanner(root, plainDir, 1e9)
  const cursor = { version: 1, files: {} }
  scanner.scan(cursor)
  const before = fs.readFileSync(plainFile(plainDir, REL), 'utf8')
  eq(before, plainTextOf(four), '初次扫描后缓存应为全量明文')
  eq(cursor.files[REL].offset, fs.statSync(file).size, '初次扫描水位应为文件字节数')
  eq(scanner.byFile.get(REL).length, 4, '初次扫描应有 4 条事件')

  // 文件被重写成更短的两帧（轮转/重写场景）
  writeLog(file, two)
  scanner.maxFramesPerScan = 0
  const s = scanner.scan(cursor)
  eq(s.skipped > 0, true, '预算为 0 时应报饥饿')
  eq(fs.readFileSync(plainFile(plainDir, REL), 'utf8'), before, '预算为 0 时明文缓存必须原封不动')
  eq(scanner.byFile.get(REL).length, 4, '预算为 0 时内存事件集也不该被清空')

  scanner.maxFramesPerScan = 1e9
  scanner.scan(cursor)
  eq(fs.readFileSync(plainFile(plainDir, REL), 'utf8'), plainTextOf(two), '预算恢复后缓存应整体重建为新内容')
  eq(scanner.byFile.get(REL).length, 2, '内存事件集应重建为新内容')
  eq(cursor.files[REL].offset, fs.statSync(file).size, '重建后水位应等于新的文件字节数')
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 3. 列举失败 ≠ 文件已删除 ─────────────────────────────────────
check('会话目录列不出来：游标与内存事件集都不许被清空', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  writeLog(path.join(root, REL), [[humanMessage(1, 1000, 'a')]])
  const { scanner, warns } = makeScanner(root, plainDir, 1e9)
  const cursor = { version: 1, files: {} }
  scanner.scan(cursor)
  eq(Object.keys(cursor.files).length, 1, '预备条件：游标里应有 1 条')

  // 同一个根目录上制造一次"临时列举失败"（权限抖动 / 句柄耗尽的样子）：
  // 磁盘上的文件一个都没少，只是这一轮 list 不出来。用**同一个扫描器**，
  // 这样也能验证它内存里那 1 个文件的事件没被连带清掉。
  const realReaddirSync = fs.readdirSync
  try {
    fs.readdirSync = function patched(target, options) {
      if (String(target) === String(root)) {
        const error = new Error('EACCES: permission denied, scandir (测试注入)')
        error.code = 'EACCES'
        throw error
      }
      return realReaddirSync.call(fs, target, options)
    }
    const s = scanner.scan(cursor)
    eq(s.scanned, 0, '列举失败时不该报告扫到文件')
    eq(Object.keys(cursor.files).length, 1, '列举失败不许清空游标')
    eq(scanner.byFile.size, 1, '列举失败不许清空内存事件集')
    assert(warns.some(w => w.includes('目录列举失败')), `列举失败必须打日志，实际: ${JSON.stringify(warns)}`)
  } finally {
    fs.readdirSync = realReaddirSync
  }
  // 恢复后再扫一轮：应当照旧走快路径，零新帧
  const after = scanner.scan(cursor)
  eq(after.newFrames, 0, '列举恢复后不该重解任何帧')

  // 文件真的消失了 → 仍然要退休，否则游标与缓存无限增长
  fs.rmSync(root, { recursive: true, force: true })
  const { scanner: gone } = makeScanner(root, plainDir, 1e9)
  gone.byFile.set(REL, [{ type: 'x' }])
  gone.scan(cursor)
  eq(Object.keys(cursor.files).length, 0, '文件真的不在磁盘上时应退休游标条目')
  eq(gone.byFile.size, 0, '文件真的不在磁盘上时应退休内存集')
})

// ── 4. 坏行必须被报出来 ──────────────────────────────────────────
check('坏 JSONL 行：报出来再跳过，不影响同帧的好行', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  writeLog(path.join(root, REL), [['{"type":"user/message","seq":1,"time":1,"data":{}}', '{"type":"user/mess']])
  const { scanner, warns } = makeScanner(root, plainDir, 1e9)
  scanner.scan({ version: 1, files: {} })
  const records = scanner.byFile.get(REL)
  eq(records.length, 1, '好行应被解析出来')
  assert(
    warns.some(w => w.includes('JSONL')),
    `坏行必须打日志，实际: ${JSON.stringify(warns)}`,
  )
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 5. 多版本并集 + 同键去重 ─────────────────────────────────────
check('同一 sessionId 的 v3/v4 取并集：同键同内容去重，同键不同内容两条都留', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  const dir = path.join(root, 'proj', 'session-aaaa')
  const shared = { type: 'turn/start', seq: 7, time: 700, data: { turn: 1 } }
  writeLog(path.join(dir, 'session.v3.jsonl.zstd'), [[shared], [humanMessage(8, 800, 'v3 独有')]])
  writeLog(path.join(dir, 'session.v4.jsonl.zstd'), [
    [shared], // 同键同内容 → 去重
    [{ type: 'turn/start', seq: 7, time: 700, data: { turn: 2 } }], // 同键不同内容 → 保留
    [humanMessage(9, 900, 'v4 独有')],
  ])
  const { scanner } = makeScanner(root, plainDir, 1e9)
  const cursor = { version: 1, files: {} }
  scanner.scan(cursor)
  eq(Object.keys(cursor.files).length, 2, '两个版本文件都要读')
  const events = scanner.bySession().get('session-aaaa')
  eq(events.filter(e => e.type === 'turn/start').length, 2, '同键不同内容的两条 turn/start 都要留')
  eq(events.filter(e => isHumanMessage(e)).length, 2, '两个版本各自的真人发言都要留')
  eq(events.filter(e => e.type === 'turn/start' && e.data.turn === 1).length, 1, '同键同内容的重复要丢掉')
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 6. warmFromCache 一致性告警 ──────────────────────────────────
check('明文缓存条数与游标水位不一致时要报警', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  writeLog(path.join(root, REL), [[humanMessage(1, 1000, 'a')], [humanMessage(2, 2000, 'b')]])
  const { scanner } = makeScanner(root, plainDir, 1e9)
  const cursor = { version: 1, files: {} }
  scanner.scan(cursor)
  eq(cursor.files[REL].events, 2, '预备条件：游标应记录 2 条事件')

  // 模拟"追加明文之后、存游标之前"被打断：缓存里多出一份重复明文
  fs.appendFileSync(plainFile(plainDir, REL), fs.readFileSync(plainFile(plainDir, REL)))
  const { scanner: warm, warns } = makeScanner(root, plainDir, 1e9)
  warm.warmFromCache(cursor)
  assert(
    warns.some(w => w.includes('不一致')),
    `缓存条数与游标不一致必须报警，实际: ${JSON.stringify(warns)}`,
  )
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 7. torn 末帧 ─────────────────────────────────────────────────
check('末尾未完成帧：不推进游标，补齐后只解一次（含带校验和的帧）', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  const file = path.join(root, REL)
  const [frameA, frameB] = framesOf([['pa-1'], ['pb-1']], { checksum: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })

  // 只写 A + B 的前 60%（B 落成 torn 尾巴）
  const cut = Math.max(1, Math.floor(frameB.length * 0.6))
  fs.writeFileSync(file, Buffer.concat([frameA, frameB.subarray(0, cut)]))
  const { scanner } = makeScanner(root, plainDir, 1e9)
  const cursor = { version: 1, files: {} }
  const s1 = scanner.scan(cursor)
  eq(s1.newFrames, 1, 'torn 尾巴不算新帧')
  eq(cursor.files[REL].offset, frameA.length, '水位应停在最后一个完整帧的末尾')
  eq(fs.readFileSync(plainFile(plainDir, REL), 'utf8'), 'pa-1\n', '缓存只应有第一帧明文')

  // 只有 torn 尾巴继续增长：水位不动
  fs.appendFileSync(file, frameB.subarray(cut, cut + 2))
  const s2 = scanner.scan(cursor)
  eq(s2.newFrames, 0, '尾巴还没长成完整帧，不该有新帧')
  eq(cursor.files[REL].offset, frameA.length, '水位不该被 torn 尾巴推动')

  // 补齐剩下部分：这一帧只解一次
  fs.appendFileSync(file, frameB.subarray(cut + 2))
  const s3 = scanner.scan(cursor)
  eq(s3.newFrames, 1, '补齐后应恰好解出 1 个新帧')
  eq(fs.readFileSync(plainFile(plainDir, REL), 'utf8'), 'pa-1\npb-1\n', '缓存必须是两帧明文，不能重复')
  const s4 = scanner.scan(cursor)
  eq(s4.newFrames + s4.changed, 0, '再扫一轮应零新帧零变化')
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 8. 帧扫描本身 ────────────────────────────────────────────────
check('按 magic 逐帧切分：多帧、带校验和帧、torn 起点都与宿主实现一致', () => {
  const parts = framesOf([['1'], ['2'], ['3']], { checksum: true })
  const joined = Buffer.concat(parts)
  const { frames, tornStart } = scanZstdFrames(joined)
  eq(tornStart, undefined, '完整文件不该有 tornStart')
  eq(frames.length, 3, '应切出 3 帧')
  eq(frames[0].start, 0, '第一帧从 0 开始')
  eq(frames[2].end, joined.length, '最后一帧到文件末尾')
  eq(decompressFrame(joined, frames[1], 64 << 20), '2\n', '第二帧明文')
  const torn = scanZstdFrames(joined.subarray(0, joined.length - 5))
  eq(torn.frames.length, 2, '截掉尾部后只剩 2 个完整帧')
  eq(torn.tornStart, frames[2].start, 'tornStart 应指向第三帧起点')
})

// ── 8. 游标有水位但内存里没有事件（"没读到"不许当成"没有新数据"）────
check('内存事件集缺失时按全量重建，不许一直走快路径把这个文件跳过', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  const file = path.join(root, REL)
  const batches = [[humanMessage(1, 1000, 'a')], [humanMessage(2, 2000, 'b')], [humanMessage(3, 3000, 'c')]]
  writeLog(file, batches)
  const size = fs.statSync(file).size
  // 游标说"已经读到文件末尾"，但内存里没有这个文件的任何事件
  // （warmFromCache 会跳过 plain 为空的条目，正是这个形状）
  const cursor = { version: 1, files: { [REL]: { offset: size, plain: null, events: 0 } } }
  const { scanner } = makeScanner(root, plainDir, 1e9)
  scanner.scan(cursor)
  eq(scanner.byFile.get(REL)?.length ?? 0, 3, '事件必须被重新读进来，不能缺席')
  eq(cursor.files[REL].offset, size, '水位不变（文件没有变化）')
  eq(fs.readFileSync(plainFile(plainDir, REL), 'utf8'), plainTextOf(batches), '明文缓存应被重建为该文件的完整明文，不能重复追加')
  const again = scanner.scan(cursor)
  eq(again.newFrames, 0, '恢复正常后再扫应为零新帧')
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 9. 明文缓存读失败后重建：不许把已有的缓存再追加一遍 ──────────
check('明文缓存读取抛错（临时故障）后重建：缓存内容不翻倍', () => {
  const root = newRoot()
  const plainDir = path.join(root, '_plain')
  writeLog(path.join(root, REL), [[humanMessage(1, 1000, 'a')], [humanMessage(2, 2000, 'b')]])
  const { scanner: first } = makeScanner(root, plainDir, 1e9)
  const cursor = { version: 1, files: {} }
  first.scan(cursor)
  const plain = plainFile(plainDir, REL)
  const good = fs.readFileSync(plain, 'utf8')
  eq(good, plainTextOf([[humanMessage(1, 1000, 'a')], [humanMessage(2, 2000, 'b')]]), '预备条件：缓存为全量明文')

  // 冷启动时读缓存抛错（权限抖动 / 被占用）：warmFromCache 会把游标作废重来
  const { scanner: restarted, warns } = makeScanner(root, plainDir, 1e9)
  const realReadFileSync = fs.readFileSync
  try {
    fs.readFileSync = function patched(target, ...rest) {
      if (String(target) === String(plain)) {
        const error = new Error('EBUSY: resource busy (测试注入)')
        error.code = 'EBUSY'
        throw error
      }
      return realReadFileSync.call(fs, target, ...rest)
    }
    restarted.warmFromCache(cursor)
  } finally {
    fs.readFileSync = realReadFileSync
  }
  assert(warns.some(w => w.includes('明文缓存缺失')), '读缓存失败必须打日志')
  eq(cursor.files[REL].offset, 0, '读缓存失败后游标应作废重来')
  restarted.scan(cursor)
  eq(fs.readFileSync(plain, 'utf8'), good, '重建必须是整体重写，不能把旧缓存再追加一遍')
  eq(restarted.byFile.get(REL).length, 2, '重建后事件数应正确')
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 10. 信号层：没有 callId 的 tool/result 计入 unpaired ─────────
check('没有 callId 的 tool/result 计入 unpaired（不再是无处可计的洞）', () => {
  const events = []
  normalizeInto(events, [
    { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, callId: 'c1', name: 'pwsh' } },
    { type: 'tool/result', seq: 2, time: 62000, data: { turn: 1, message: { source: { callId: 'c1' } } } },
    { type: 'tool/result', seq: 3, time: 63000, data: { turn: 1, message: {} } },
  ], 's1', 0)
  const signals = computeSessionSignals(events, {
    delegatePatterns: [],
    longToolMs: 60000,
    humanWaitTools: [],
    repeatFailMin: 3,
    answerWindowMs: 1800000,
  })
  eq(signals.longTools, 1, '配上的那次超时应记为命令失控')
  eq(signals.unpairedToolResults, 1, '没有 callId 的那条应计入 unpaired')
})

check('listSessionFiles 的列举失败回调可被调用（签名向后兼容）', () => {
  const missing = path.join(newRoot(), 'not-here')
  const messages = []
  const out = listSessionFiles(missing, m => messages.push(m))
  eq(out.length, 0, '目录不存在时返回空列表')
  eq(messages.length, 1, '应回调一次失败信息')
  const out2 = listSessionFiles(missing) // 不传回调也必须能用
  eq(out2.length, 0, '不传回调时不应抛错')
})

console.log('')
console.log('========================================================================')
console.log(`结果：${passed} 通过 / ${failed} 失败`)
console.log('========================================================================')
process.exit(failed === 0 ? 0 : 1)
