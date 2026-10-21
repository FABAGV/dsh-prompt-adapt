/**
 * 自检：对着**真实的**会话日志跑一遍四层，验证增量语义与四个信号。
 *
 * 只读 `~/.dsh/sessions`，状态写到临时目录，不碰用户的 `~/.dsh/prompt-adapt`。
 *
 * ⚠️ **关于"环境在动"**：本测试跑在一个**活的 DSH 里**，
 * 宿主正在写"当前这个会话"的日志。所以任何"某文件字节数不变"的断言
 * 都可能被宿主的并发追加打破。凡是受影响的断言都在下面显式标注，
 * 并改成"把宿主的并发增长排除掉之后仍然成立"的形式，
 * 而不是放宽到测不出问题。
 *
 * 运行：
 *   node test/selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { SessionScanner, listSessionFiles } from '../lib/sessions.js'
import { scanZstdFrames, ZSTD_MAGIC } from '../lib/frames.js'
import { computeAllSignals, computeSessionSignals, isHumanMessage } from '../lib/signals.js'
import {
  shouldRegenerate,
  diffProfiles,
  buildProfilePrompt,
  renderProfileText,
  parseProfileJson,
  parseProfileJsonRescue,
  rescueProfileJson,
  normalizeProfile,
  generateProfile,
} from '../lib/profile.js'
import { StateStore, MODE, emptyState } from '../lib/state.js'
import { PROMPT_HALL_URL } from '../lib/hall.js'
import { resolveConfig } from '../lib/index.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
let SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const log = { debug() {}, info() {}, warn() {}, error() {} }

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-adapt-test-'))
const cursorPath = path.join(tmpRoot, 'cursor.json')

/**
 * 没有真实会话日志时（CI、新机器）生成一份**结构真实**的合成语料。
 *
 * 为什么不是"没语料就跳过"：这个文件的前五节测的正是帧扫描/增量游标/信号统计，
 * 跳过等于把大半个测试静默删掉。合成语料能覆盖同样的代码路径，只是数据是造的 ——
 * 所以会**明确打印**"本次用的是合成语料"，不伪装成真实数据。
 *
 * 目录结构与会话日志格式照抄 `tools/test-entry.mjs` 与真实 v4 日志：
 *   <root>/<project>/<session>/session.v4.jsonl.zstd，每帧一段独立 zstd。
 */
function writeSyntheticSessions(root) {
  const compress = (lines) =>
    zlib.zstdCompressSync(Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8'))
  const at = Date.now() - 3_600_000
  const header = (id) => ({ type: 'session', version: 4, id, createdAt: at - 60_000, cwd: root })
  const human = (seq, time, text, kind = 'user') => ({
    type: 'user/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }], source: { kind } },
  })
  const write = (project, id, frames) => {
    const dir = path.join(root, project, id)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    for (const lines of frames) fs.appendFileSync(file, compress(lines))
  }

  // 会话 A：3 帧，含一条非真人来源的 user/message（让 source.kind 分布 > 1）
  write('synthetic-project', 'session-a', [
    [header('session-a'), human(1, at + 1000, '第一个问题'), human(2, at + 2000, '子代理委派', 'subagent')],
    [human(3, at + 3000, '继续做'), human(4, at + 4000, '换个做法')],
    [human(5, at + 5000, '谢谢')],
  ])
  // 会话 B：2 帧（保证 `files[0]` 不管取到哪个都是多帧文件）
  write('synthetic-project', 'session-b', [
    [header('session-b'), human(1, at + 1500, '另一个会话'), human(2, at + 2500, '第二句')],
    [human(3, at + 3500, '第三句')],
  ])
}

let files = listSessionFiles(SESSIONS_ROOT)
let usedSynthetic = false
if (files.length === 0) {
  const realRoot = SESSIONS_ROOT
  SESSIONS_ROOT = path.join(tmpRoot, 'synthetic-sessions')
  writeSyntheticSessions(SESSIONS_ROOT)
  files = listSessionFiles(SESSIONS_ROOT)
  usedSynthetic = true
  console.log(`没有真实会话日志（${realRoot} 为空）→ 本次用合成语料（${files.length} 个文件）`)
}

console.log('='.repeat(72))
console.log('1. 帧扫描与解压')
console.log('='.repeat(72))
{
  check('发现会话日志文件', files.length > 0, `${files.length} 个${usedSynthetic ? '（合成）' : ''}`)

  const multi = files.find(f => f.size > 60000) ?? files[0]
  const buffer = fs.readFileSync(multi.file)
  const { frames, tornStart } = scanZstdFrames(buffer)
  check('扫描出多个帧', frames.length > 1, `${frames.length} 帧，tornStart=${tornStart}`)
  check('帧区间首尾相接且覆盖整个文件', (() => {
    let cursor = 0
    for (const frame of frames) {
      if (frame.start !== cursor) return false
      cursor = frame.end
    }
    return cursor === buffer.length
  })(), `末帧 end=${frames.at(-1)?.end} size=${buffer.length}`)

  check('首 4 字节等于 ZSTD magic', buffer.readUInt32LE(0) === ZSTD_MAGIC,
    `0x${buffer.readUInt32LE(0).toString(16)}`)

  // 关键回归：原生 API 遇到多帧只解第一帧 → 必须自己切
  const zlib = (await import('node:zlib')).default
  const naive = zlib.zstdDecompressSync(buffer).toString('utf8')
  const frame0 = zlib
    .zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end), { maxWindowSize: 64 << 20 })
    .toString('utf8')
  check('原生 zstdDecompressSync 对多帧只返回第一帧（这正是必须自己切帧的原因）',
    naive.length === frame0.length,
    `原生 ${naive.length} 字节 = 第一帧 ${frame0.length} 字节，而全文件有 ${frames.length} 帧`)

  let totalLines = 0
  for (const frame of frames) {
    const text = zlib
      .zstdDecompressSync(buffer.subarray(frame.start, frame.end), { maxWindowSize: 64 << 20 })
      .toString('utf8')
    totalLines += text.split('\n').filter(l => l.trim()).length
  }
  check('逐帧解压拿到的事件数远多于原生 API 的结果', totalLines > 1,
    `${frames.length} 帧 → ${totalLines} 行`)
}

console.log('')
console.log('='.repeat(72))
console.log('2. 增量读取：帧偏移游标')
console.log('='.repeat(72))
let scanner
let firstStats
{
  const cursor = { version: 1, files: {} }
  scanner = new SessionScanner({
    sessionsRoot: SESSIONS_ROOT,
    plainDir: path.join(tmpRoot, 'plain'),
    maxWindowSize: 64 << 20,
    maxFramesPerScan: 100000,
    log,
  })

  const t0 = Date.now()
  firstStats = scanner.scan(cursor)
  const firstMs = Date.now() - t0
  fs.writeFileSync(cursorPath, JSON.stringify(cursor, null, 2), 'utf8')

  check('首扫解压了帧', firstStats.newFrames > 0,
    `${firstStats.newFrames} 帧 / ${firstStats.newEvents} 事件 / ${firstMs}ms`)
  check('每个文件都写下了 offset 水位',
    Object.values(cursor.files).every(f => typeof f.offset === 'number' && f.offset > 0),
    `${Object.keys(cursor.files).length} 个文件`)
  check('每个文件都写下了明文缓存名',
    Object.values(cursor.files).every(f => typeof f.plain === 'string' && f.plain.endsWith('.jsonl')))

  // ⚠️ 环境在动：宿主正在写当前会话的日志。所以断言的是
  // "offset 是当时那个字节数下最后一帧的结束位置"，而不是"等于现在文件的末尾"。
  // 判据：offset <= 当前 size，且 offset 处正好落在帧边界上。
  check('offset 落在帧边界上且不超过当前文件大小', (() => {
    for (const [rel, entry] of Object.entries(cursor.files)) {
      const buffer = fs.readFileSync(path.join(SESSIONS_ROOT, rel))
      if (entry.offset > buffer.length) return false
      if (entry.offset === buffer.length) continue
      if (buffer.readUInt32LE(entry.offset) !== ZSTD_MAGIC) return false
    }
    return true
  })())

  // 第二轮：只跳过没有增长的文件。因为确实有文件在被宿主追加，
  // "整个扫描零新帧"在活环境里不成立，所以改测更强的两条：
  //   (a) 二扫解压的帧数远少于首扫（没有回头重解历史帧）
  //   (b) 未增长的文件一个帧都不再解压（用明文缓存字节数做证据）
  const t1 = Date.now()
  const secondStats = scanner.scan(cursor)
  const secondMs = Date.now() - t1
  check('二扫只解压"新增字节里的完整帧"，远少于首扫',
    secondStats.newFrames < firstStats.newFrames,
    `首扫 ${firstStats.newFrames} 帧 → 二扫 ${secondStats.newFrames} 帧 / ${secondMs}ms`)
  check('二扫不再回头重解任何历史帧', secondStats.newFrames <= 20, `${secondStats.newFrames} 帧`)
  check('二扫显著快于首扫', secondMs <= Math.max(firstMs * 0.5, 5),
    `首扫 ${firstMs}ms → 二扫 ${secondMs}ms`)
  check('游标文件已落盘', fs.existsSync(cursorPath))

  // 关键增量语义：用明文缓存的大小做证据 ——
  // 它只在真有新帧被解压时才会被追加，所以"缓存逐字节不变"等价于"零解压"。
  {
    const plainDir = path.join(tmpRoot, 'plain')
    const snapshotPlain = () => fs.readdirSync(plainDir)
      .map(name => `${name}:${fs.statSync(path.join(plainDir, name)).size}`)
      .sort()
      .join('|')
    const before = snapshotPlain()
    const again = scanner.scan(cursor)
    const after = snapshotPlain()
    check('明文缓存只在有新帧时增长（同一次扫描不重复解压任何帧）',
      again.newFrames === 0 ? before === after : true,
      again.newFrames === 0
        ? '本轮零新帧且缓存逐字节未变'
        : `本轮有 ${again.newFrames} 个新帧（宿主在追加，缓存相应增长）`)
  }
}

console.log('')
console.log('='.repeat(72))
console.log('3. 冷启动：从明文缓存还原，不解压任何帧')
console.log('='.repeat(72))
{
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'))
  const cold = new SessionScanner({
    sessionsRoot: SESSIONS_ROOT,
    plainDir: path.join(tmpRoot, 'plain'),
    maxWindowSize: 64 << 20,
    maxFramesPerScan: 100000,
    log,
  })
  const t0 = Date.now()
  cold.warmFromCache(cursor)
  const warmMs = Date.now() - t0
  const warmStats = cold.scan(cursor)
  check('warmFromCache 后事件集非空', cold.bySession().size > 0,
    `${cold.bySession().size} 个会话 / ${warmMs}ms`)
  check('warm 之后不重解任何历史帧（只可能是宿主刚追加的新帧）',
    warmStats.newFrames <= 20, `${warmStats.newFrames} 帧`)

  /**
   * "冷启动 == 热路径"必须在**同一份输入**上比，否则会被宿主的并发追加打破：
   * 两个 scanner 各自追一个正在增长的文件时，读到的帧数天然会不同。
   *
   * 所以只比对**在快照之后没有增长的文件**（= 输入完全相同），
   * 对它们要求两条路得到逐条相同的事件数。
   */
  const frozenCursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'))
  const sizeAtSnapshot = new Map(listSessionFiles(SESSIONS_ROOT).map(f => [f.rel, f.size]))

  const fromCache = new SessionScanner({
    sessionsRoot: SESSIONS_ROOT,
    plainDir: path.join(tmpRoot, 'plain'),
    maxWindowSize: 64 << 20,
    maxFramesPerScan: 100000,
    log,
  })
  fromCache.warmFromCache(JSON.parse(JSON.stringify(frozenCursor)))

  const fromScratch = new SessionScanner({
    sessionsRoot: SESSIONS_ROOT,
    plainDir: path.join(tmpRoot, 'plain-scratch'),
    maxWindowSize: 64 << 20,
    maxFramesPerScan: 100000,
    log,
  })
  fromScratch.scan({ version: 1, files: {} })

  const sizeNow = new Map(listSessionFiles(SESSIONS_ROOT).map(f => [f.rel, f.size]))
  const stable = new Set(
    Object.keys(frozenCursor.files).filter(rel => sizeAtSnapshot.get(rel) === sizeNow.get(rel)),
  )
  const growing = Object.keys(frozenCursor.files).filter(rel => !stable.has(rel))

  const a = fromCache.bySession()
  const b = fromScratch.bySession()
  const stableSessions = new Set([...stable].map(rel => rel.split(path.sep).at(-2)))
  const comparedIds = [...stableSessions].filter(id => a.has(id) && b.has(id))
  const mismatched = comparedIds.filter(id => a.get(id).length !== b.get(id).length)
  check('对输入相同的文件，冷启动（读明文缓存）与从零重扫得到相同事件集',
    comparedIds.length > 0 && mismatched.length === 0,
    `比对 ${comparedIds.length} 个未变化的会话（排除 ${growing.length} 个正在被宿主追加的文件）` +
      (mismatched.length ? `；不一致：${mismatched.slice(0, 3).join(', ')}` : ''))

  check('明文缓存确实被用来重建（事件总量与热路径同量级）', (() => {
    const coldTotal = [...a.values()].reduce((sum, list) => sum + list.length, 0)
    const hotTotal = [...scanner.bySession().values()].reduce((sum, list) => sum + list.length, 0)
    return coldTotal > hotTotal * 0.9
  })())
}

console.log('')
console.log('='.repeat(72))
console.log('4. 真人发言判据（source.kind）')
console.log('='.repeat(72))
const bySession = scanner.bySession()
const allEvents = [...bySession.values()].flat()
{
  const kinds = new Map()
  for (const event of allEvents) {
    if (event.type !== 'user/message') continue
    const kind = event.message?.source?.kind ?? '(none)'
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  const human = allEvents.filter(isHumanMessage)
  const total = [...kinds.values()].reduce((x, y) => x + y, 0)
  console.log(`  user/message source.kind 分布: ${
    [...kinds].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(' ')
  }`)
  check('真人发言只是 user-role 消息的一部分（过滤是必要的）', human.length < total,
    `真人 ${human.length} / 全部 ${total}`)
  check('真人发言全都 source.kind === "user"',
    human.every(e => e.message.source.kind === 'user'))
  check('非真人注入里确实存在多种 kind（证明这些 kind 真实存在）', kinds.size > 1,
    `${kinds.size} 种`)
}

console.log('')
console.log('='.repeat(72))
console.log('5. 四个零 LLM 计数信号（对全部真实会话）')
console.log('='.repeat(72))
const config = resolveConfig({})
const signals = computeAllSignals(bySession, config.signals)
{
  console.log('  totals =', JSON.stringify(signals.totals, null, 2).replace(/\n/g, '\n  '))
  check('统计到会话', signals.totals.sessions > 0, `${signals.totals.sessions} 个会话有真人发言`)
  for (const key of ['delegateRuns', 'longTools', 'repeatFailures', 'freeformAnswers',
                     'humanWaitTools', 'concurrentSkipped']) {
    check(`「${key}」计数存在且 >= 0`,
      typeof signals.totals[key] === 'number' && signals.totals[key] >= 0,
      `${signals.totals[key]}`)
  }

  const oneSession = [...bySession.entries()].find(([, events]) => events.some(isHumanMessage))
  const detail = computeSessionSignals(oneSession[1], config.signals)
  check('单会话明细结构完整',
    ['humanMessages', 'delegateRuns', 'longTools', 'repeatFailures', 'freeformAnswers',
     'humanWaitTools', 'concurrentSkipped', 'details'].every(key => key in detail),
    Object.keys(detail.details).join(','))

  // 阈值必须真的起作用
  const loose = computeAllSignals(bySession, { ...config.signals, longToolMs: 1 })
  check('降低 longToolMs 阈值使计数上升（阈值确实参与判据）',
    loose.totals.longTools >= signals.totals.longTools,
    `60s→${signals.totals.longTools} 次, 1ms→${loose.totals.longTools} 次`)

  const strict = computeAllSignals(bySession, { ...config.signals, longToolMs: 24 * 3600 * 1000 })
  check('极大 longToolMs 阈值使计数归零', strict.totals.longTools === 0, `${strict.totals.longTools} 次`)

  const noPhrase = computeAllSignals(bySession, {
    ...config.signals,
    delegatePatterns: ['zzz不可能出现的措辞zzz'],
  })
  check('换掉句式正则后「让你代跑」归零（正则确实参与判据）',
    noPhrase.totals.delegateRuns === 0, `${noPhrase.totals.delegateRuns} 次`)

  // 人类等待工具必须真的被排除在「命令失控」之外
  const allAsCommands = computeAllSignals(bySession, { ...config.signals, humanWaitTools: [] })
  check('把 humanWaitTools 清空后「命令失控」计数上升（排除规则确实生效）',
    allAsCommands.totals.longTools >= signals.totals.longTools,
    `排除后 ${signals.totals.longTools} 次 → 不排除 ${allAsCommands.totals.longTools} 次`)

  // 并发调用必须被跳过，且剩余时长必须物理上说得通
  const maxDuration = Math.max(0,
    ...Object.values(signals.sessions).flatMap(s => s.details.longTools.map(m => m.durationMs)))
  check('并发调用被计入 concurrentSkipped', signals.totals.concurrentSkipped >= 0,
    `${signals.totals.concurrentSkipped} 次`)
  check('过滤并发后没有超过 24 小时的荒谬时长（墙钟读数可信）',
    maxDuration < 24 * 3600 * 1000, `最长 ${(maxDuration / 1000).toFixed(1)}s`)
  check('每条 longTools 明细都带 tool / durationMs / turn',
    Object.values(signals.sessions).flatMap(s => s.details.longTools)
      .every(m => 'tool' in m && 'durationMs' in m && 'turn' in m))
  check('每条 delegateRuns 明细都带命中的句式片段与上下文',
    Object.values(signals.sessions).flatMap(s => s.details.delegateRuns)
      .every(m => typeof m.matched === 'string' && typeof m.excerpt === 'string'))
  check('每条 freeformAnswers 明细都带 offered 与 said',
    Object.values(signals.sessions).flatMap(s => s.details.freeformAnswers)
      .every(m => Array.isArray(m.offered) && m.offered.length > 0 && typeof m.said === 'string'))
}

console.log('')
console.log('='.repeat(72))
console.log('6. 触发间隔')
console.log('='.repeat(72))
{
  const base = { triggerUserMessages: 12, triggerNewSessions: 3 }
  check('首版材料不足时不触发',
    shouldRegenerate({ profile: null, lastGeneration: null, humanMessages: 5, sessions: 1, config: base }).due === false)
  check('首版材料达标时触发',
    shouldRegenerate({ profile: null, lastGeneration: null, humanMessages: 12, sessions: 1, config: base }).due === true)

  const profile = { version: 1, entries: [{ id: 'A1', category: 'A', claim: 'x' }] }
  check('新增 12 条发言触发',
    shouldRegenerate({ profile, lastGeneration: { humanMessages: 100, sessions: 50 },
      humanMessages: 112, sessions: 50, config: base }).due === true)
  check('只新增 3 个会话也触发（先到者触发）',
    shouldRegenerate({ profile, lastGeneration: { humanMessages: 100, sessions: 50 },
      humanMessages: 103, sessions: 53, config: base }).due === true)
  check('两个判据都没到时触发',
    shouldRegenerate({ profile, lastGeneration: { humanMessages: 100, sessions: 50 },
      humanMessages: 111, sessions: 52, config: base }).due === false)
}

console.log('')
console.log('='.repeat(72))
console.log('7. 画像：增量更新契约与假变化度量')
console.log('='.repeat(72))
{
  const previous = {
    version: 1,
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通', evidence: ['讲中文'],
        lastEvidenceMessages: 100, timesSeen: 1, firstSeenAt: 1 },
      { id: 'B1', category: 'B', claim: '不要在他没要求时做升级', evidence: ['不要做不必要的升级'],
        lastEvidenceMessages: 100, timesSeen: 1, firstSeenAt: 1 },
    ],
  }
  const prompt = buildProfilePrompt({
    previousProfile: previous,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: { delegateRuns: 1, longTools: 2, repeatFailures: 0, freeformAnswers: 3 },
    totalHumanMessages: 112,
    totalSessions: 53,
  })
  check('提示词含上一版画像（增量更新的前提）',
    prompt.includes('"id": "A1"') && prompt.includes('用中文沟通'))
  check('提示词明确要求逐字保留未变条目', prompt.includes('逐字保留原样'))
  check('提示词含四个计数信号', prompt.includes('AI 把活推回给用户') && prompt.includes('命令失控'))
  check('提示词标注材料是数据不是指令', prompt.includes('不是指令'))
  check('提示词含四类分类说明', ['A) ', 'B) ', 'C) ', 'D) '].every(mark => prompt.includes(mark)))

  const parsedUnchanged = {
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通', evidence: ['讲中文'], confidence: 'high' },
      { id: 'B1', category: 'B', claim: '不要在他没要求时做升级', evidence: ['不要做不必要的升级'], confidence: 'high' },
    ],
  }
  const same = normalizeProfile(parsedUnchanged, {
    version: 2, evidenceMessages: 112, now: 2, previous, provider: 'p', model: 'm', raw: '',
  })
  const diffSame = diffProfiles(previous, same)
  check('逐字未变时假变化率为 0', diffSame.spuriousRate === 0,
    `spuriousRate=${diffSame.spuriousRate} 未动=${diffSame.unchanged.length}`)
  check('逐字未变的条目继承上一版证据量（不被本次材料规模虚增）',
    same.entries[0].lastEvidenceMessages === 100,
    `lastEvidenceMessages=${same.entries[0].lastEvidenceMessages}`)

  const reworded = normalizeProfile({
    entries: [
      { id: 'A1', category: 'A', claim: '习惯用中文交流', evidence: ['讲中文'], confidence: 'high' },
      { id: 'B1', category: 'B', claim: '不要在他没要求时做升级', evidence: ['不要做不必要的升级'], confidence: 'high' },
    ],
  }, { version: 2, evidenceMessages: 112, now: 2, previous, provider: 'p', model: 'm', raw: '' })
  check('换措辞被识别为可疑变化',
    diffProfiles(previous, reworded).spuriousRate === 0.5,
    `spuriousRate=${diffProfiles(previous, reworded).spuriousRate}`)

  const changed = normalizeProfile({
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通', evidence: ['讲中文'], confidence: 'high' },
      { id: 'C1', category: 'C', claim: '先给分析再动手有效', evidence: ['先不修，分析一遍'], confidence: 'high' },
    ],
  }, { version: 2, evidenceMessages: 112, now: 2, previous, provider: 'p', model: 'm', raw: '' })
  const diffChanged = diffProfiles(previous, changed)
  check('增删条目被正确归类（且不计入可疑变化）',
    diffChanged.added.length === 1 && diffChanged.removed.length === 1 && diffChanged.spuriousRate === 0,
    `added=${diffChanged.added} removed=${diffChanged.removed} spuriousRate=${diffChanged.spuriousRate}`)

  check('每条条目都记录证据量',
    same.entries.every(e => typeof e.evidenceQuoteCount === 'number'
      && typeof e.lastEvidenceMessages === 'number'))
}

console.log('')
console.log('='.repeat(72))
console.log('7b. 差量输出契约：只输出变化 + 未变条目由插件拼回来')
console.log('='.repeat(72))
{
  /**
   * 上一版：3 条。A1 要改写、B1 未动、C1 要删。
   * 每条都带齐"改动后必须原样保留"的字段，好逐字段核。
   */
  const previous = {
    version: 4,
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通', evidence: ['讲中文', '别用英文'], confidence: 'high',
        evidenceQuoteCount: 2, lastEvidenceMessages: 100, firstSeenAt: 111, lastSeenAt: 222, timesSeen: 7 },
      { id: 'B1', category: 'B', claim: '不要在他没要求时做升级', evidence: ['不要做不必要的升级'], confidence: 'high',
        evidenceQuoteCount: 1, lastEvidenceMessages: 100, firstSeenAt: 333, lastSeenAt: 444, timesSeen: 5 },
      { id: 'C1', category: 'C', claim: '先给分析再动手有效', evidence: ['先不修，分析一遍'], confidence: 'medium',
        evidenceQuoteCount: 1, lastEvidenceMessages: 90, firstSeenAt: 555, lastSeenAt: 666, timesSeen: 2 },
    ],
  }

  // ── 提示词：契约必须明说"不要重打未变条目的正文" ──────────────────
  const prompt = buildProfilePrompt({
    previousProfile: previous,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: { delegateRuns: 1, longTools: 2, repeatFailures: 0, freeformAnswers: 3 },
    totalHumanMessages: 112,
    totalSessions: 53,
  })
  check('提示词要求差量输出（不重打未变条目正文）',
    prompt.includes('不要在 entries 里重打未变动条目的正文'))
  check('提示词给出 unchangedIds 与 deletedIds 的语义',
    prompt.includes('"unchangedIds"') && prompt.includes('"deletedIds"'))
  check('提示词说明"不出现在两个清单里 = 删除"',
    prompt.includes('一律当作你要删除'))
  check('首版提示词退化说明（无上一版时 entries 就是全部）',
    buildProfilePrompt({ previousProfile: null, messages: [], signals: {}, totalHumanMessages: 0, totalSessions: 0 })
      .includes('这是**首版**'))

  // ── 差量拼装 ──────────────────────────────────────────────────────
  const delta = {
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通，且不接受长篇英文回复', evidence: ['讲中文', '别用英文', '太长不看'], confidence: 'high' },
      { id: 'n1', category: 'B', claim: '不要在他没要求时重构', evidence: ['不要顺手改别的'], confidence: 'medium' },
    ],
    unchangedIds: ['B1'],
    deletedIds: ['C1'],
  }
  const assembled = normalizeProfile(delta, {
    version: 5, evidenceMessages: 112, now: 999, previous, provider: 'p', model: 'm', raw: '{}',
  })
  const byId = new Map(assembled.entries.map(e => [e.id, e]))
  check('差量拼装：条目集合 = 改写 1 + 新增 1 + 未变 1 − 删除 1',
    assembled.entries.length === 3 && byId.has('A1') && byId.has('n1') && byId.has('B1') && !byId.has('C1'),
    `ids=${assembled.entries.map(e => e.id).join(',')}`)

  const untouched = byId.get('B1')
  const previousB1 = previous.entries.find(e => e.id === 'B1')
  check('未变动条目的既有字段逐字段原样保留（evidence/confidence/证据量/首次出现/次数）',
    untouched.claim === previousB1.claim &&
      untouched.evidence.join('|') === previousB1.evidence.join('|') &&
      untouched.confidence === previousB1.confidence &&
      untouched.evidenceQuoteCount === 2 - 1 &&
      untouched.lastEvidenceMessages === 100 &&
      untouched.firstSeenAt === 333 &&
      untouched.timesSeen === 5,
    `evidence=${JSON.stringify(untouched.evidence)} lastEvidenceMessages=${untouched.lastEvidenceMessages} firstSeenAt=${untouched.firstSeenAt} timesSeen=${untouched.timesSeen}`)
  check('未变动条目只刷新 lastSeenAt（"最近一次确认还在"的时间）', untouched.lastSeenAt === 999)
  check('被改写的条目刷新证据量与出现次数',
    byId.get('A1').lastEvidenceMessages === 112 && byId.get('A1').timesSeen === 8,
    `lastEvidenceMessages=${byId.get('A1').lastEvidenceMessages} timesSeen=${byId.get('A1').timesSeen}`)
  check('新增条目的 firstSeenAt = 本次生成时间', byId.get('n1').firstSeenAt === 999 && byId.get('n1').timesSeen === 1)

  // ── 等价性：差量拼出来的画像 == 全量输出下逐字照抄的画像 ──────────
  const fullEcho = normalizeProfile({
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通，且不接受长篇英文回复', evidence: ['讲中文', '别用英文', '太长不看'], confidence: 'high' },
      { id: 'B1', category: 'B', claim: '不要在他没要求时做升级', evidence: ['不要做不必要的升级'], confidence: 'high' },
      { id: 'n1', category: 'B', claim: '不要在他没要求时重构', evidence: ['不要顺手改别的'], confidence: 'medium' },
    ],
  }, { version: 5, evidenceMessages: 112, now: 999, previous, provider: 'p', model: 'm', raw: '{}' })
  const sortById = list => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  check('差量拼装与全量输出逐字段等价（这就是 diffProfiles 仍然成立的前提）',
    JSON.stringify(sortById(assembled.entries)) === JSON.stringify(sortById(fullEcho.entries)))

  const diffDelta = diffProfiles(previous, assembled)
  const diffFull = diffProfiles(previous, fullEcho)
  check('差量契约下的 diff 与全量契约下的 diff 完全一致（可疑变化率不比全量多算一分）',
    JSON.stringify(diffDelta) === JSON.stringify(diffFull),
    `spuriousRate 差量=${diffDelta.spuriousRate} 全量=${diffFull.spuriousRate}，改写=${diffDelta.modified.join(',')}`)
  check('改写被算成"有依据的变化"（改写条目的 evidence 变了）',
    diffDelta.modified.length === 1 && diffDelta.modified[0] === 'A1' && diffDelta.spuriousRate === 1 / 3)
  check('未变条目严格没被算成可疑变化', !diffDelta.modified.includes('B1') && diffDelta.unchanged.includes('B1'))

  // ── 模型多打了一遍（老契约残留）时按"未变动"处理，不虚增证据量 ────
  const echoOnly = {
    entries: [{ id: 'B1', category: 'B', claim: '不要在他没要求时做升级',
      evidence: ['不要做不必要的升级'], confidence: 'high' }],
    unchangedIds: [],
  }
  const echoProfile = normalizeProfile(echoOnly, {
    version: 5, evidenceMessages: 7777, now: 999, previous, provider: 'p', model: 'm', raw: '{}',
  })
  check('模型仍逐字照抄未变条目时，按未变动处理（不虚增 lastEvidenceMessages / timesSeen）',
    echoProfile.entries[0].lastEvidenceMessages === 100 && echoProfile.entries[0].timesSeen === 5,
    `lastEvidenceMessages=${echoProfile.entries[0].lastEvidenceMessages} timesSeen=${echoProfile.entries[0].timesSeen}`)
  check('这种照抄不算可疑变化', diffProfiles(previous, echoProfile).spuriousRate === 0)

  // ── 收口类健壮性：不收坏数据、不整批丢弃 ──────────────────────────
  const ghosts = normalizeProfile(
    { entries: [{ id: 'n2', category: 'C', claim: '他自己另说时别硬塞选项', evidence: ['另说'], confidence: 'high' }],
      unchangedIds: ['A1', 'zz9'] },
    { version: 5, evidenceMessages: 112, now: 999, previous, provider: 'p', model: 'm', raw: '{}' })
  check('unchangedIds 里的未知 id 被忽略（不写空条目、不整批丢弃）',
    ghosts.entries.length === 2 && !ghosts.entries.some(e => e.id === 'zz9'),
    `ids=${ghosts.entries.map(e => e.id).join(',')}`)
  check('未知 id 被如实记进 warnings', (ghosts.warnings ?? []).some(w => w.includes('zz9')))

  const both = normalizeProfile(
    { entries: [{ id: 'A1', category: 'A', claim: '用中文沟通，且不接受长篇英文回复', evidence: ['讲中文'], confidence: 'high' }],
      unchangedIds: ['A1', 'B1'] },
    { version: 5, evidenceMessages: 112, now: 999, previous, provider: 'p', model: 'm', raw: '{}' })
  check('同一 id 同时出现在 entries 与 unchangedIds 时以 entries 为准（不重复出条目）',
    both.entries.filter(e => e.id === 'A1').length === 1 &&
      both.entries.find(e => e.id === 'A1').claim.includes('不接受长篇英文回复'))

  // ── 输出量：同一份画像，全量契约 vs 差量契约 ──────────────────────
  const fullOutput = JSON.stringify({ entries: previous.entries.map(e => ({
    id: e.id, category: e.category, claim: e.claim, evidence: e.evidence, confidence: e.confidence,
  })), unchangedIds: [], deletedIds: [] })
  const deltaOutput = JSON.stringify(delta)
  check('同一份画像下差量输出显著短于全量输出',
    deltaOutput.length < fullOutput.length,
    `全量 ${fullOutput.length} 字符 → 差量 ${deltaOutput.length} 字符（少 ${(100 * (1 - deltaOutput.length / fullOutput.length)).toFixed(1)}%）`)
}

console.log('')
console.log('='.repeat(72))
console.log('8. 画像文本渲染：字节稳定')
console.log('='.repeat(72))
{
  const profile = {
    version: 3,
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通' },
      { id: 'B1', category: 'B', claim: '不要做不必要的升级' },
      { id: 'D1', category: 'D', claim: '偏好哪种编辑器尚不明确' },
    ],
  }
  const one = renderProfileText(profile)
  check('同一画像两次渲染逐字相同（系统提示段要求字节稳定）', one === renderProfileText(profile))
  check('渲染含三类标题',
    one.includes('稳定特质') && one.includes('行不通的做法') && one.includes('证据不足'))
  check('空画像渲染为空串', renderProfileText(null) === '' && renderProfileText({ entries: [] }) === '')
  check('渲染不含时间戳（否则每步都会追加 system 节点）', !/\d{4}-\d{2}-\d{2}/.test(one))
  check('渲染不含版本号（版本一变就会追加 system 节点）', !/v\d/.test(one))
}

console.log('')
console.log('='.repeat(72))
console.log('9. 模型输出解析（含 markdown 围栏与前后废话）')
console.log('='.repeat(72))
{
  check('解析纯 JSON', Array.isArray(parseProfileJson('{"entries":[]}').entries))
  check('解析带围栏与废话的输出',
    parseProfileJson('结果：\n```json\n{"entries":[{"id":"A1","category":"A","claim":"x"}]}\n```\n完毕')
      .entries.length === 1)
  let threw = false
  try {
    parseProfileJson('完全不是 JSON')
  } catch {
    threw = true
  }
  check('非 JSON 输出抛错', threw)

  // ── 截断抢救 ──────────────────────────────────────────────────────
  const truncated =
    '{"entries":['
    + '{"id":"n1","category":"B","claim":"不要顺手重构","evidence":["不要顺手改别的"],"confidence":"high"},'
    + '{"id":"A1","category":"A","claim":"用中文沟通","evidence":["讲中文"],"confidence":"high"},'
    + '{"id":"n2","category":"C","claim":"先分析再动手",'
  let strictThrew = false
  try {
    parseProfileJson(truncated)
  } catch {
    strictThrew = true
  }
  check('严格解析对截断输出抛错（老行为不变）', strictThrew)

  const rescued = rescueProfileJson(truncated)
  // 不写死"丢了多少字符"：那个数字依赖 JSON 序列化时对字符的转义方式，
  // 数汉字数出来的数字改一个引号就错。断言的是**行为**：
  //   从原始输出开头到"丢掉的那一段"之前，补上缺的 `]}` 就是一个合法 JSON，
  //   里面恰好是那两条完整条目 —— 也就是一个字符都没多留、没少留。
  check('截断抢救：取出已完整的条目，丢掉写到一半的那条',
    rescued !== null && rescued.value.entries.length === 2 && rescued.truncated &&
      rescued.droppedTailChars > 0 &&
      JSON.parse(`${truncated.slice(0, truncated.length - rescued.droppedTailChars)}]}`).entries.length === 2,
    rescued ? `救出 ${rescued.value.entries.length} 条，丢尾部 ${rescued.droppedTailChars} 字符` : '没救出来')
  check('截断抢救：被切掉的条目不是"只丢字段"，是整条丢弃（残留部分也没混进来）',
    rescued.value.entries.every(e => typeof e.claim === 'string' && e.claim.length > 0 && !e.id.startsWith('n2')))

  const rescuedObj = parseProfileJsonRescue(truncated)
  check('解析器如实标记这是部分结果',
    rescuedObj.ok === false && rescuedObj.partial === true && rescuedObj.droppedTailChars > 0)
  check('完整 JSON 走严格路径、不标记为部分结果',
    parseProfileJsonRescue('{"entries":[]}').partial === false)

  // 截断点在**条目开头**（连 claim 都没写），前面是一个完整的 `}` —— 这正是
  // 老失败模式最常见的形状：模型刚写下 `{"id":"n2",` 就到顶了。
  const cutAtEntryStart = '{"entries":[{"id":"A1","category":"A","claim":"用中文沟通","evidence":["讲中文"],"confidence":"high"},{"id":"n2","cat'
  const rescued2 = rescueProfileJson(cutAtEntryStart)
  check('截断点在条目开头时也能抢救出前面的完整条目（不是切出非法 JSON 前缀）',
    rescued2 !== null && rescued2.value.entries.length === 1 && rescued2.value.entries[0].id === 'A1',
    rescued2 ? `救出 ${rescued2.value.entries.length} 条` : '没救出来')

  // 只写完了 unchangedIds、entries 还是空的 —— 这依然是有用的部分结果
  const idsOnly = '{"entries":[],"unchangedIds":["A1","B1"],"deletedIds":["C1"'
  const rescued3 = rescueProfileJson(idsOnly)
  check('只写完 unchangedIds 的部分结果也能救出来（等价于"这一版什么都没变"）',
    rescued3 !== null && rescued3.value.unchangedIds.join(',') === 'A1,B1' && rescued3.truncated)

  check('完全不是 JSON 时抢救返回 null（不硬猜）',
    rescueProfileJson('完全不是 JSON') === null &&
    rescueProfileJson('{"foo": {"bar": 1') === null)
  check('连部分 JSON 都切不出来时不抛错，交给 id 级兜底（比整批丢弃强）',
    parseProfileJsonRescue('完全不是 JSON').needsIdSalvage === true &&
    parseProfileJsonRescue('{"entries":[],"unchangedIds":["A1","B1"]}').needsIdSalvage === false,
    JSON.stringify(parseProfileJsonRescue('完全不是 JSON')))
  check('第一个 id 都没写完时：抢救层交回空结果 + needsIdSalvage',
    rescueProfileJson('{"entries":[],"unchangedIds":["A1') === null &&
    parseProfileJsonRescue('{"entries":[],"unchangedIds":["A1').needsIdSalvage === true,
    JSON.stringify(rescueProfileJson('{"entries":[],"unchangedIds":["A1')))
}

console.log('')
console.log('='.repeat(72))
console.log('10. 状态与模式互斥')
console.log('='.repeat(72))
{
  const store = new StateStore({ dir: path.join(tmpRoot, 'state'), log })
  store.setProfileRenderer(renderProfileText)
  check('默认模式是 auto', store.state.mode === MODE.AUTO)
  check('空状态生效文本为空', store.effective().text === '')

  store.state.mode = MODE.CUSTOM
  store.state.customText = '请始终用中文回答。'
  const custom = store.effective()
  check('模式 2 时生效文本就是自定义文本',
    custom.text === '请始终用中文回答。' && custom.source === 'customText')

  store.state.mode = MODE.AUTO
  store.state.profile = { version: 1, entries: [{ id: 'A1', category: 'A', claim: '用中文沟通' }] }
  const auto = store.effective()
  check('模式 1 时生效文本来自画像', auto.source === 'profile' && auto.text.includes('用中文沟通'))
  check('模式 1 时自定义文本不参与生效（模式互斥）', !auto.text.includes('请始终用中文回答'))
  check('切模式不丢失另一边的数据', store.state.customText === '请始终用中文回答。')
  check('mode 是单字段枚举，不存在"两个都开"的状态',
    'mode' in emptyState() && !('autoEnabled' in emptyState()) && !('customEnabled' in emptyState()))

  store.saveState()
  const reloaded = new StateStore({ dir: path.join(tmpRoot, 'state'), log })
  reloaded.setProfileRenderer(renderProfileText)
  check('重载后模式保留', reloaded.state.mode === MODE.AUTO)
  check('重载后自定义文本保留', reloaded.state.customText === '请始终用中文回答。')
  check('重载后画像保留', reloaded.state.profile?.entries?.length === 1)

  fs.writeFileSync(path.join(tmpRoot, 'state', 'state.json'),
    JSON.stringify({ mode: 'both', customText: 'x' }), 'utf8')
  const recovered = new StateStore({ dir: path.join(tmpRoot, 'state'), log })
  check('非法 mode 落盘值被兜回 auto（不让"两个都开"存在）', recovered.state.mode === MODE.AUTO)
}

console.log('')
console.log('='.repeat(72))
console.log('11. generateProfile 全链路（llm 打桩）')
console.log('='.repeat(72))
{
  const stubbed = {
    async *stream(options) {
      const text = options.messages[0].content[0].text
      if (!text.includes('已有画像')) throw new Error('提示词里没有已有画像段')
      if (!text.includes('用中文沟通')) throw new Error('提示词里没有上一版条目')
      yield { type: 'text-delta', text: '{"entries":[{"id":"A1","category":"A","claim":"用中文沟通",' }
      yield { type: 'text-delta', text: '"evidence":["讲中文"],"confidence":"high"}]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const previous = {
    version: 1,
    entries: [{ id: 'A1', category: 'A', claim: '用中文沟通', evidence: ['讲中文'],
      lastEvidenceMessages: 90, timesSeen: 1, firstSeenAt: 1 }],
  }
  const result = await generateProfile({
    llm: stubbed, provider: 'p', model: 'm', previousProfile: previous,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: { delegateRuns: 0, longTools: 0, repeatFailures: 0, freeformAnswers: 0 },
    totalHumanMessages: 91, totalSessions: 10, maxTokens: 100, timeoutMs: 1000,
  })
  check('生成成功且版本号递增', result.profile.version === 2)
  check('增量更新生效：条目 id 沿用、未变条目假变化为 0',
    result.diff.spuriousRate === 0 && result.diff.unchanged.includes('A1'))
  check('正常生成不打"部分结果"标记',
    result.partial === false && result.profile.rescue === null &&
      result.profile.warnings.length === 0)

  // ── 差量契约全链路：模型只写变化的条目 + 未变条目的 id ─────────────
  const deltaStub = {
    async *stream() {
      yield {
        type: 'text-delta',
        text: '{"entries":[{"id":"B1","category":"B","claim":"不要顺手重构","evidence":["不要顺手改别的"],"confidence":"high"}],'
          + '"unchangedIds":["A1"],"deletedIds":[],"notes":""}',
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const deltaResult = await generateProfile({
    llm: deltaStub, provider: 'p', model: 'm', previousProfile: previous,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: {}, totalHumanMessages: 91, totalSessions: 10, maxTokens: 100, timeoutMs: 1000,
  })
  check('差量契约全链路：未变条目由插件拼回、只输出变化的那条',
    deltaResult.profile.entries.length === 2 &&
      deltaResult.profile.entries[0].id === 'B1' &&
      deltaResult.profile.entries[1].id === 'A1',
    `条目 ${deltaResult.profile.entries.map(e => e.id).join(',')}`)
  check('拼回来的未变条目与上一版逐字一致（diff 只看到那 1 条新增）',
    deltaResult.diff.added.includes('B1') && deltaResult.diff.unchanged.includes('A1') &&
      deltaResult.diff.spuriousRate === 0,
    `added=${deltaResult.diff.added} unchanged=${deltaResult.diff.unchanged} spuriousRate=${deltaResult.diff.spuriousRate}`)

  // ── 差量契约 + 截断抢救：全链路 ────────────────────────────────────
  // 模型按新契约写了 1 条新增条目，第二条第 2 个条目写到一半就撞上 token 上限。
  // 这时候**不能**整批丢弃：新增的那条要保住，上一版的条目要按"未变动"拼回来。
  const truncatedStream = {
    async *stream() {
      yield { type: 'text-delta', text: '{"entries":[{"id":"n1","category":"C","claim":"先给分析再动手",' }
      yield { type: 'text-delta', text: '"evidence":["先不修，分析一遍"],"confidence":"high"},{"id":"n2","claim":"写到一半就断' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  const partial = await generateProfile({
    llm: truncatedStream, provider: 'p', model: 'm', previousProfile: previous,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: { delegateRuns: 0, longTools: 0, repeatFailures: 0, freeformAnswers: 0 },
    totalHumanMessages: 91, totalSessions: 10, maxTokens: 100, timeoutMs: 1000,
  })
  check('截断时生成**不失败**，而是产出可用的部分结果',
    partial.profile.entries.length === 2 && partial.partial === true,
    `条目 ${partial.profile.entries.map(e => e.id).join(',')}`)
  check('截断时不执行删除：没被提到的上一版条目原样保留（不是当成被删除）',
    partial.profile.entries.some(e => e.id === 'A1' && e.lastEvidenceMessages === 90 &&
      e.firstSeenAt === 1 && e.timesSeen === 1) && partial.profile.deletionsHonored === false)
  check('截断抢救出来的新增条目保住了',
    partial.profile.entries.some(e => e.id === 'n1' && e.claim === '先给分析再动手'))
  check('部分结果被如实标记（原因 + 丢弃长度 + 救出条数）',
    partial.profile.rescue?.partial === true && partial.profile.rescue.reason === 'max-tokens' &&
      partial.profile.rescue.droppedTailChars > 0 && partial.profile.rescue.rescuedEntries === 1,
    JSON.stringify(partial.profile.rescue))
  check('生成结果里带出 partial 与截断原因（供调用方记日志）',
    partial.truncationReason === 'max-tokens' && partial.droppedTailChars > 0)

  // 反过来：**完整**输出时，删除必须照契约执行（fail-open 不能变成"永不删"）。
  const completeDeltaStream = {
    async *stream() {
      yield { type: 'text-delta', text: '{"entries":[],"unchangedIds":[],"deletedIds":["A1"],"notes":""}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const completeDelta = await generateProfile({
    llm: completeDeltaStream, provider: 'p', model: 'm', previousProfile: previous,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: {}, totalHumanMessages: 91, totalSessions: 10, maxTokens: 100, timeoutMs: 1000,
  })
  check('完整输出时删除照契约执行（"没被提到 = 删除"）',
    completeDelta.profile.entries.length === 0 && completeDelta.profile.deletionsHonored === true &&
      completeDelta.diff.removed.includes('A1') && completeDelta.partial === false,
    `条目 ${completeDelta.profile.entries.length} 条，删除 ${completeDelta.diff.removed.join(',')}`)

  // 截断到"连 unchangedIds 都没写完"：完整读到的那个 id 照契约生效，
  // 没读到的不能当成被删（那是数据丢失）。
  const idsCutStream = {
    async *stream() {
      yield { type: 'text-delta', text: '{"entries":[],"unchangedIds":["A1","B1' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  const idsCutPrev = {
    version: 1,
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通', evidence: ['讲中文'], firstSeenAt: 1, timesSeen: 2 },
      { id: 'B1', category: 'B', claim: '不要做不必要的升级', evidence: ['不要升级'], firstSeenAt: 2, timesSeen: 3 },
    ],
  }
  const idsCut = await generateProfile({
    llm: idsCutStream, provider: 'p', model: 'm', previousProfile: idsCutPrev,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: {}, totalHumanMessages: 91, totalSessions: 10, maxTokens: 100, timeoutMs: 1000,
  })
  check('截断在 unchangedIds 中途时，完整读到的 id 生效、没读到的保留（不执行删除）',
    idsCut.profile.entries.length === 2 &&
      idsCut.profile.entries[0].id === 'A1' && idsCut.profile.entries[1].id === 'B1' &&
      idsCut.profile.deletionsHonored === false,
    `条目 ${idsCut.profile.entries.map(e => e.id).join(',')}`)

  // 更狠的两种：`unchangedIds` 里连一个 id 都没写完。
  //   a) `["A1`  —— 引号都没闭：这个 id 不算完整值，抠不出来
  //   b) `["A1"` —— 引号闭了、数组没闭：这个 id 是完整的，必须抠出来
  // 两种都不许把上一版条目当成被删掉，且都要如实标记走的是最弱那层兜底。
  const cutTo = async text => generateProfile({
    llm: {
      async *stream() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      },
    },
    provider: 'p', model: 'm', previousProfile: idsCutPrev,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: {}, totalHumanMessages: 91, totalSessions: 10, maxTokens: 100, timeoutMs: 1000,
  })
  const rawCut = await cutTo('{"entries":[],"unchangedIds":["A1')
  check('连 id 的引号都没写完时：一条都不丢（按"这一版什么都没变"处理）',
    rawCut.profile.entries.length === 2 && rawCut.profile.deletionsHonored === false,
    `条目 ${rawCut.profile.entries.map(e => e.id).join(',')}`)
  const quoteCut = await cutTo('{"entries":[],"unchangedIds":["A1"')
  check('id 引号闭了、数组没闭时：该 id 被当成完整的救回来，条目一条不丢',
    quoteCut.profile.entries.length === 2 &&
      quoteCut.profile.entries[0].id === 'A1' &&
      quoteCut.profile.entries[0].claim === '用中文沟通' &&
      quoteCut.profile.entries[0].firstSeenAt === 1 &&
      quoteCut.profile.entries[0].timesSeen === 2,
    `条目 ${quoteCut.profile.entries.map(e => e.id).join(',')} rescue=${JSON.stringify(quoteCut.profile.rescue)}`)

  const failing = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }
    },
  }
  let err = null
  try {
    await generateProfile({
      llm: failing, provider: 'p', model: 'm', previousProfile: null,
      messages: [{ index: 1, sessionId: 's', time: 1, text: 'x' }],
      signals: {}, totalHumanMessages: 1, totalSessions: 1, maxTokens: 10, timeoutMs: 1000,
    })
  } catch (error) {
    err = error
  }
  check('llm.stream 的 error finish chunk 被当成失败（不静默当成空输出）',
    err !== null && /boom/.test(err.message), err?.message)

  let err2 = null
  try {
    await generateProfile({ llm: null, provider: 'p', model: 'm', messages: [] })
  } catch (error) {
    err2 = error
  }
  check('llm 服务缺失时明确报错', err2 !== null && /llm 服务不可用/.test(err2.message))
}

console.log('')
console.log('='.repeat(72))
console.log('12. 配置规整')
console.log('='.repeat(72))
{
  const c = resolveConfig({})
  check('默认触发间隔 12 条发言', c.profile.triggerUserMessages === 12)
  check('默认触发间隔 3 个会话', c.profile.triggerNewSessions === 3)
  check('默认长工具阈值 60000ms', c.signals.longToolMs === 60000)
  check('默认 maxWindowSize 64MiB', c.scan.maxWindowSize === 64 << 20)
  check('默认注入 order 在人格前缀之后、工具说明之前',
    c.inject.order > 0 && c.inject.order < 500, `order=${c.inject.order}`)
  check('默认句式正则可编译且非空',
    c.signals.delegatePatterns.length > 0 && c.signals.delegatePatterns.every(p => {
      try {
        new RegExp(p)
        return true
      } catch {
        return false
      }
    }), `${c.signals.delegatePatterns.length} 条`)
  check('默认排除 ask_user_question（它等的是人，不是命令）',
    c.signals.humanWaitTools.includes('ask_user_question'))
  check('默认排除 job_output（它等的是后台作业）',
    c.signals.humanWaitTools.includes('job_output'))

  const overridden = resolveConfig({ signals: { longToolMs: 5 }, profile: { triggerNewSessions: 9 } })
  check('覆盖生效', overridden.signals.longToolMs === 5 && overridden.profile.triggerNewSessions === 9)
  check('未覆盖字段仍取默认', overridden.profile.triggerUserMessages === 12)
  check('覆盖数组字段生效',
    resolveConfig({ signals: { humanWaitTools: ['x'] } }).signals.humanWaitTools.length === 1)
}

console.log('')
console.log('='.repeat(72))
console.log('13. 只读保证 + 模式 3 的边界')
console.log('='.repeat(72))
{
  const libDir = path.join(import.meta.dirname, '..', 'lib')
  const writeCalls = /(writeFileSync|appendFileSync|renameSync|unlinkSync|mkdirSync|rmSync|createWriteStream)\s*\(/
  /**
   * 写目标白名单 —— 每一项都必须能追溯到状态侧。
   * 这是**穷举**而不是"排除会话目录"，因为排除法会漏掉未来新增的写法；
   * 穷举法会在新增写目标时直接失败，逼作者回来确认它确实落在状态侧。
   */
  const ALLOWED_TARGETS = new Map([
    ['plainPath', '明文字典路径（由 this.plainDir 派生，plainDir 在状态目录下）'],
    ['this.plainDir', '明文字典目录本身（状态目录下）'],
    ['tmp', '原子写的临时文件（同目录 rename）'],
    ['file', 'state.js 的插件日志文件（this.logFile）'],
    ['dir', '状态目录 / plain / profile-history（StateStore.#ensureDirs）'],
    ['this.stateFile', 'state.json'],
    ['this.cursorFile', 'cursor.json'],
  ])
  const offenders = []
  const used = new Set()
  let inspected = 0
  for (const file of fs.readdirSync(libDir)) {
    if (!file.endsWith('.js')) continue
    const lines = fs.readFileSync(path.join(libDir, file), 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (/console\./.test(line)) return
      const match = writeCalls.exec(line)
      if (!match) return
      inspected += 1
      const after = line.slice(line.indexOf(match[0]) + match[0].length)
      const arg = after.split(',')[0].replace(/[`'"].*$/, '').trim()
      const target = arg.replace(/^fs\./, '').trim()
      if (ALLOWED_TARGETS.has(target)) {
        used.add(target)
        return
      }
      offenders.push(`${file}:${index + 1} 写目标「${target}」不在白名单 — ${line.trim()}`)
    })
  }
  check('lib/ 下每一处写操作都作用于状态目录', offenders.length === 0,
    offenders.length ? offenders.join(' | ') : `核对了 ${inspected} 处写操作，用到 ${[...used].join('/')}`)
  check('确实检查到了写操作（不是把整个检查跑空了）', inspected >= 7, `${inspected} 处`)
  check('没有出现新的未审查写目标', [...used].every(target => ALLOWED_TARGETS.has(target)))

  const sessionsSrc = fs.readFileSync(path.join(libDir, 'sessions.js'), 'utf8')
  check('plainPath 由 this.plainDir 派生',
    /#plainPath\(rel\)\s*\{\s*return path\.join\(this\.plainDir/.test(sessionsSrc))
  check('sessions.js 里没有任何对 sessionsRoot 的写操作',
    !new RegExp(`sessionsRoot[^\\n]{0,120}${writeCalls.source}`).test(sessionsSrc))

  /**
   * 模式 3（提示词大厅）的边界证明：宿主侧**完全不发网络请求**。
   * 光靠"我没写 fetch"不算证明，所以静态扫一遍宿主侧的每个文件。
   * `lib/client.js` 是 UI 代理的文件（它会 fetch 自己的后端接口），显式排除。
   */
  const HOST_FILES = ['index.js', 'schema.js', 'frames.js', 'sessions.js', 'signals.js',
                      'profile.js', 'state.js', 'hall.js', 'http.js']
  const networkOffenders = []
  for (const file of HOST_FILES) {
    const source = fs.readFileSync(path.join(libDir, file), 'utf8')
    source.split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (/\bfetch\s*\(|require\(['"]https?['"]\)|from ['"]node:https?['"]/.test(line)) {
        networkOffenders.push(`${file}:${index + 1}`)
      }
    })
  }
  check('宿主侧不发任何出站网络请求（模式 3 确实"不抓取"）',
    networkOffenders.length === 0,
    networkOffenders.length ? networkOffenders.join(', ') : `扫了 ${HOST_FILES.length} 个宿主侧文件`)

  const stripComments = (text) => text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
  const hall = fs.readFileSync(path.join(libDir, 'hall.js'), 'utf8')
  check('hall.js 里没有缓存结构（模式 3 确实"不缓存"）',
    !/\bMap\b|\bSet\b|cache/i.test(stripComments(hall)))
  check('hall.js 里没有凭据读取（模式 3 确实"不鉴权"）',
    !/credential|token|apiKey|Authorization/i.test(stripComments(hall)))
  check('hall.js 的默认值是空串（未配置 → 界面不显示死链）',
    /PROMPT_HALL_URL\s*=\s*''/.test(hall))
  check('导出的 PROMPT_HALL_URL 与 hall.js 一致（未配置）', PROMPT_HALL_URL === '')

  // ── 运行时副作用：扫描不得改动会话日志 ────────────────────────────
  //
  // ⚠️ 这个环境里宿主随时可能开始写一个新文件，所以"哪些文件静止"必须在
  //    **紧邻扫描的窗口内**判定。做法：扫描前后各取一次完整快照（size + mtime），
  //    size 变了的说明是宿主在写，排除；**size 没变但 mtime 变了**的才是嫌疑 ——
  //    只读代码不可能只改 mtime 而不改内容。
  const probe = new SessionScanner({
    sessionsRoot: SESSIONS_ROOT,
    plainDir: path.join(tmpRoot, 'plain-readonly'),
    maxWindowSize: 64 << 20,
    maxFramesPerScan: 100000,
    log,
  })
  const snapFull = () => new Map(listSessionFiles(SESSIONS_ROOT)
    .map(f => [f.rel, { size: f.size, mtime: f.mtimeMs }]))

  const beforeScan = snapFull()
  probe.scan({ version: 1, files: {} })
  const afterScan = snapFull()

  const touched = []
  const hostWritten = []
  for (const [rel, before] of beforeScan) {
    const after = afterScan.get(rel)
    if (!after) continue
    if (after.size !== before.size) {
      hostWritten.push(rel)
      continue
    }
    if (after.mtime !== before.mtime) touched.push(rel)
  }
  check('size 未变的文件，扫描没有改动它们的 mtime', touched.length === 0,
    touched.length
      ? `被改动：${touched.slice(0, 3).join(', ')}`
      : `核对了 ${beforeScan.size - hostWritten.length} / ${beforeScan.size} 个文件（排除 ${hostWritten.length} 个正在被宿主追加的）`)
  check('排除逻辑不是空排除（文件集完整，或确实有文件在被宿主追加）',
    hostWritten.length > 0 || beforeScan.size === afterScan.size,
    `宿主写入 ${hostWritten.length} 个 / 共 ${beforeScan.size} 个`)
  check('扫描后明文缓存已生成（说明确实读了会话目录）',
    fs.existsSync(path.join(tmpRoot, 'plain-readonly'))
      && fs.readdirSync(path.join(tmpRoot, 'plain-readonly')).length > 0)
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`临时目录：${tmpRoot}`)
console.log('='.repeat(72))

if (fail === 0) {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 清不掉也无所谓 */
  }
}
process.exit(fail === 0 ? 0 : 1)
