/**
 * 会话日志的**增量**读取层。
 *
 * ## 只读承诺
 *
 * 本模块对 `$DSH_HOME/sessions/` 只做 `readdir` / `stat` / `readFile`。
 * 全部代码里没有对该目录的 `write*` / `rename*` / `mkdir*` / `unlink*` 调用。
 * 派生出的明文缓存写在**状态目录**（默认 `$DSH_HOME/prompt-adapt/`），不写会话目录。
 *
 * ## 目录布局（实测）
 *
 *   <sessionsRoot>/<projectKey>/<sessionId>/session[.vN].jsonl.zstd
 *
 * `projectKey` 是 cwd 的可读转写（`R:\working zone` → `--R-working~0020zone--`）。
 * 同一个 `<sessionId>` 目录下**可能有多个版本文件**（本机实测 2df609d4 同时只有
 * v3、其余是 v4；规范里 `parseGenerationLogFilename` 也允许多代共存），
 * 所以这里做的是**同一 sessionId 取并集**：按文件名排序逐个文件读，
 * 事件全部归到同一个会话上，绝不"任选一份"。
 *
 * ## 增量是怎么做的（核心）
 *
 * 游标 `cursor.files[rel]` 三个字段：
 *
 *   | 字段 | 含义 |
 *   |---|---|
 *   | `offset` | **已解压完的最后一个完整帧的结束字节**（就是 EOF 水位线） |
 *   | `plain`  | 已解压明文的落盘文件名（`plain/<sha1(rel)>.jsonl`） |
 *   | `events` | 该文件上次贡献的事件条数（用于按区间替换） |
 *
 * 每轮对每个文件：
 *
 *   1. `size = statSync(file).size`
 *   2. `size === offset` → **零新字节，直接 continue**（绝大多数文件走这条）
 *   3. `size < offset` → 文件被截断/轮转，游标作废，从 0 全量重来
 *   4. 否则 `readFileSync` 全文件 → `scanZstdFrames()` 只做**结构扫描**
 *      （不解压任何 block，只按 block header 跳过 payload）→ 对
 *      `frame.end > offset` 的帧逐帧 `zstdDecompressSync(slice, {maxWindowSize})`
 *
 * **每一个帧只会被解压一次**：新帧的明文**追加**到明文缓存文件，游标前进。
 * 需要"该文件完整事件集"时读明文缓存即可，不需要回头重解历史帧 ——
 * 这就是把 `plain` 落盘的全部理由（换掉"每次全量重解"）。
 *
 * 第 4 步读的是整个文件，但那是读盘 + 结构扫描，不是解压。
 * 会话日志都是 MB 级，这个代价可接受，换来的是不必维护"部分帧续读"状态。
 *
 * ## 为什么可以按文件追加而不是按会话
 *
 * 帧的压缩是**独立**的（每帧自带 header/字典/校验），所以
 * `明文(帧1..n) === 明文(帧1..k) + 明文(帧k+1..n)` —— 直接拼接即可，
 * 不需要保留帧边界。这让"追加写明文"在语义上是无损的。
 *
 * ## 断点跨重启
 *
 * 游标落盘在 `cursor.json`，明文缓存落盘在 `plain/`，所以重启后
 * `size === offset` 这条快路径直接命中，一个帧都不会重解。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { scanZstdFrames, decompressFrame, parseJsonlFrame } from './frames.js'

/** 一个会话日志文件的相对路径 → 明文缓存文件名。 */
function plainName(rel) {
  return `${crypto.createHash('sha1').update(rel).digest('hex')}.jsonl`
}

/**
 * 列出 `<sessionsRoot>` 下全部会话日志文件。
 *
 * ⚠️ 列举失败（根目录不存在、权限抖动、句柄耗尽）**不会抛错**，只交回调，
 * 返回值可能是不完整的列表。调用方必须把"没列到"与"已删除"分开处理：
 * `scan()` 用 `existsSync` 复核后才退休游标条目。
 *
 * @param {string} sessionsRoot
 * @param {(message:string)=>void} [onError] 列举失败时的回调（每个失败目录一次）
 * @returns {Array<{sessionId:string, file:string, rel:string, size:number, mtimeMs:number}>}
 */
export function listSessionFiles(sessionsRoot, onError) {
  const out = []
  let projects
  try {
    projects = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    onError?.(`${sessionsRoot}: ${error?.message ?? error}`)
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(sessionsRoot, project.name)
    let sessions
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true })
    } catch (error) {
      onError?.(`${projectDir}: ${error?.message ?? error}`)
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = path.join(projectDir, session.name)
      let names
      try {
        names = fs.readdirSync(sessionDir)
      } catch (error) {
        onError?.(`${sessionDir}: ${error?.message ?? error}`)
        continue
      }
      // 同一 sessionId 的所有版本文件都读（并集，不任选）；排序保证确定性
      for (const name of names.sort()) {
        if (!name.endsWith('.jsonl.zstd')) continue
        const file = path.join(sessionDir, name)
        let stat
        try {
          stat = fs.statSync(file)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        out.push({
          sessionId: session.name,
          file,
          rel: path.relative(sessionsRoot, file),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
    }
  }
  return out
}

/**
 * 增量扫描器。
 */
export class SessionScanner {
  /**
   * @param {object} opts
   * @param {string} opts.sessionsRoot
   * @param {string} opts.plainDir 明文缓存目录（状态目录下）
   * @param {number} opts.maxWindowSize
   * @param {number} opts.maxFramesPerScan
   * @param {{debug:Function,info:Function,warn:Function,error:Function}} opts.log
   */
  constructor({ sessionsRoot, plainDir, maxWindowSize, maxFramesPerScan, log }) {
    this.sessionsRoot = sessionsRoot
    this.plainDir = plainDir
    this.maxWindowSize = maxWindowSize
    this.maxFramesPerScan = maxFramesPerScan
    this.log = log
    /** @type {Map<string, object[]>} rel → 该文件当前完整事件集（内存中的活跃副本） */
    this.byFile = new Map()
  }

  #plainPath(rel) {
    return path.join(this.plainDir, plainName(rel))
  }

  /** 冷启动：从明文缓存重建 `byFile`，不碰会话目录、不解压任何帧。 */
  warmFromCache(cursor) {
    if (!cursor?.files) return
    for (const [rel, entry] of Object.entries(cursor.files)) {
      if (!entry?.plain) continue
      const file = this.#plainPath(rel)
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        // 缓存丢了：把游标作废，下次扫描会全量重建这个文件
        this.log.warn(`[scan] 明文缓存缺失，将全量重建 ${rel}`)
        entry.offset = 0
        entry.plain = null
        entry.events = 0
        continue
      }
      const sessionId = rel.split(path.sep).at(-2) ?? rel
      const records = []
      normalizeInto(records, this.#parseFrame(text, rel, 0), sessionId, 0)
      // 明文缓存的条数应当等于上次落盘时记下的条数。不等说明上一轮的
      // 「追加明文 → 存游标」之间被打断过：缓存里会带重复事件（去重层会吸收），
      // 或者缓存被别的东西截短过（这时是真丢数据，必须报出来）。
      if (typeof entry.events === 'number' && entry.events !== records.length) {
        this.log.warn(
          `[scan] 明文缓存条数(${records.length})与游标水位记录的条数(${entry.events})不一致 ${rel}`,
        )
      }
      this.byFile.set(rel, records)
    }
  }

  /**
   * 解析一帧明文，坏行**报出来**再跳过。
   * 坏行的唯一现实来源是写到一半的行，静默丢掉会变成"这条事件从没发生过"。
   */
  #parseFrame(text, rel, frameStart) {
    return parseJsonlFrame(text, (error, line) => {
      this.log.warn(
        `[scan] 明文里有无法解析的 JSONL 行（已跳过） ${rel} frame@${frameStart} ` +
          `行长=${line.length}: ${error?.message ?? error}`,
      )
    })
  }

  /**
   * 扫描一轮。
   *
   * @param {object} cursor 可变的持久化游标 `{ version, files: {} }`
   * @returns {{scanned:number, changed:number, newFrames:number, newEvents:number, errors:number, skipped:number}}
   */
  scan(cursor) {
    const stats = { scanned: 0, changed: 0, newFrames: 0, newEvents: 0, errors: 0, skipped: 0 }
    if (!cursor || typeof cursor !== 'object') cursor = { version: 1, files: {} }
    if (!cursor.files || typeof cursor.files !== 'object') cursor.files = {}

    const files = listSessionFiles(this.sessionsRoot, message => {
      this.log.warn(`[scan] 目录列举失败（≠ 文件已删除）: ${message}`)
    })
    let budget = this.maxFramesPerScan
    // 会话目录里已经消失的文件：连游标一起退休，避免无限增长
    const seen = new Set(files.map(f => f.rel))
    for (const rel of Object.keys(cursor.files)) {
      if (seen.has(rel)) continue
      // 列举失败会返回不完整的列表。只有文件**真的不在磁盘上**才退休：
      // 否则一次权限抖动就会把整个游标清空，下次扫描要从零重解全部帧
      // （实测 216 个文件 / 6.4 万帧，按每轮 400 帧的预算要 130 轮以上）。
      if (fs.existsSync(path.join(this.sessionsRoot, rel))) continue
      delete cursor.files[rel]
      this.byFile.delete(rel)
    }

    for (const info of files) {
      stats.scanned += 1
      const entry = cursor.files[info.rel] ?? { offset: 0, plain: null, events: 0 }

      // ── 快路径：字节数没变 → 没有任何新帧，一个字节都不用读 ──
      if (info.size === entry.offset && this.byFile.has(info.rel)) continue

      let decoded
      try {
        decoded = this.#decode(info, entry, budget)
      } catch (error) {
        stats.errors += 1
        this.log.warn(`[scan] 读取失败 ${info.rel}: ${error?.message ?? error}`)
        continue
      }
      budget -= decoded.newFrames
      stats.newFrames += decoded.newFrames
      stats.newEvents += decoded.newEvents
      if (decoded.skipped) stats.skipped += 1
      if (decoded.changed) {
        stats.changed += 1
        cursor.files[info.rel] = {
          offset: decoded.offset,
          plain: entry.plain ?? plainName(info.rel),
          events: decoded.count,
        }
      } else if (!cursor.files[info.rel]) {
        cursor.files[info.rel] = entry
      }
    }
    // 预算耗尽会让排在后面的文件一轮又一轮地读不到（位置性饥饿）。
    // 这必须报出来：否则"信号只覆盖了一部分语料"在外观上与"没有新数据"完全一样。
    // 注意判据是 budget 用尽而不是 skipped>0 —— 预算恰好耗尽在某文件中间时
    // 没有任何文件被"整个跳过"，但这一轮同样没读全。
    if (stats.skipped > 0 || budget <= 0) {
      this.log.warn(
        `[scan] 帧预算(${this.maxFramesPerScan})已用尽：本轮 ${stats.skipped} 个文件完全未读，` +
          `仍有文件没读全（游标已按实际读到的位置前进，下一轮继续）`,
      )
    }
    return stats
  }

  /**
   * 读一个文件，把**新帧**解压后追加进明文缓存与内存事件集。
   * @returns {{changed:boolean,skipped?:boolean,newFrames:number,newEvents:number,offset:number,count:number}}
   */
  #decode(info, entry, budget) {
    // 预算可能被上一批文件用完（甚至为负）；undefined/NaN 视为无限
    const remaining = Number.isFinite(budget) ? Math.max(0, budget) : Number.POSITIVE_INFINITY
    // 「内存里这个文件的事件集没了」必须当成全量重来，不能当成"没有新帧"：
    // 游标说 offset=X，但内存里没有 X 之前的事件，说明这一段的明文既不在内存
    // 也没进过 bySession —— 只看 end > offset 的帧会让这个文件的事件**永远缺席**，
    // 而快路径还会一直跳过它（"没读到"被当成"没有新数据"）。
    const lostMemory = !this.byFile.has(info.rel)
    const truncated = info.size < entry.offset
    const rebuild = truncated || lostMemory
    const from = rebuild ? 0 : entry.offset

    const buffer = fs.readFileSync(info.file)
    const { frames, tornStart } = scanZstdFrames(buffer)
    if (tornStart !== undefined) {
      this.log.debug(`[scan] ${info.rel} 末尾有未完成帧 @${tornStart}（正常：正在写入）`)
    }

    const fresh = frames.filter(frame => frame.end > from)
    if (fresh.length === 0 && !rebuild) {
      // 只有 torn 尾巴在增长，没有完整新帧：记录 offset 不动，等下一轮
      return { changed: false, newFrames: 0, newEvents: 0, offset: entry.offset, count: entry.events ?? 0 }
    }

    if (remaining === 0 && fresh.length > 0) {
      // 预算耗尽：这个文件本轮一个帧都没解。绝不能报 changed ——
      // 那会让 scan() 给一个**没读过的文件**落下游标（写出一条 offset=0、
      // plain 指向并不存在的缓存文件的记录），并在截断场景下把明文缓存
      // 整体清空。什么都不做，下一轮再说。
      return {
        changed: false,
        skipped: true,
        newFrames: 0,
        newEvents: 0,
        offset: entry.offset,
        count: entry.events ?? 0,
      }
    }

    const take = fresh.slice(0, remaining)
    const plainPath = this.#plainPath(info.rel)
    fs.mkdirSync(this.plainDir, { recursive: true })

    let records = []
    let newEvents = 0
    if (rebuild) {
      // 全量重来：缓存整体重写（既是截断恢复，也是"内存集丢了"的恢复）
      const parts = []
      for (const frame of take) {
        const text = decompressFrame(buffer, frame, this.maxWindowSize)
        parts.push(text)
        normalizeInto(records, this.#parseFrame(text, info.rel, frame.start), info.sessionId, frame.start)
      }
      fs.writeFileSync(plainPath, parts.join(''), 'utf8')
      newEvents = records.length
    } else {
      // 增量追加：只解压新帧，只追加写
      const parts = []
      for (const frame of take) {
        const text = decompressFrame(buffer, frame, this.maxWindowSize)
        parts.push(text)
        normalizeInto(records, this.#parseFrame(text, info.rel, frame.start), info.sessionId, frame.start)
      }
      if (parts.length > 0) fs.appendFileSync(plainPath, parts.join(''), 'utf8')
      // 完整事件集 = 内存里的旧集 + 本次新集
      const previous = this.byFile.get(info.rel) ?? []
      records = previous.concat(records)
      newEvents = records.length - previous.length
    }

    this.byFile.set(info.rel, records)
    const offset = take.length > 0 ? take[take.length - 1].end : from
    return {
      changed: true,
      newFrames: take.length,
      newEvents,
      offset,
      count: records.length,
    }
  }

  /**
   * 取当前全部事件，按会话聚合（同一 sessionId 的多个版本文件取并集）。
   *
   * ## 去重策略（宁可保留也不静默丢）
   *
   * 同一 `<sessionId>` 目录下可能同时存在 v3 与 v4 两代日志。规范上它们是
   * **不同代际**、事件不重叠；但万一有重叠（迁移中途），也不能让事件翻倍。
   *
   * 去重键分两级：
   *   1. `seq` 存在 → 用 `seq`
   *   2. `seq` 缺失 → 用 `${type}@${time}`
   *
   * ⚠️ 关键：同键**只有在内容也相同**时才丢弃。若同键但内容不同
   * （不同代际里 seq 语义不同、或同毫秒内两条同类事件），一律**两条都保留**，
   * 并把键让给后来者。这样最坏情况是少量重复，而不是静默丢数据 ——
   * 「少算一条真人发言」会直接让画像少一块证据，比多算一条严重得多。
   *
   * @returns {Map<string, object[]>} sessionId → 事件（按 seq 升序）
   */
  bySession() {
    /** @type {Map<string, {byKey: Map<string, object>, list: object[]}>} */
    const grouped = new Map()
    for (const [rel, records] of this.byFile) {
      const sessionId = rel.split(path.sep).at(-2) ?? rel
      let bucket = grouped.get(sessionId)
      if (!bucket) {
        bucket = { byKey: new Map(), list: [] }
        grouped.set(sessionId, bucket)
      }
      for (const record of records) {
        const key = record.seq !== null ? `s${record.seq}` : `${record.type}@${record.time}`
        const existing = bucket.byKey.get(key)
        if (existing === undefined) {
          bucket.byKey.set(key, record)
          bucket.list.push(record)
          continue
        }
        // 同键：内容一致才算重复（丢弃）；否则保留两条
        if (sameEventContent(existing, record)) continue
        bucket.list.push(record)
      }
    }
    const out = new Map()
    for (const [sessionId, bucket] of grouped) {
      const list = bucket.list
      list.sort((a, b) => {
        if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq - b.seq
        return (a.time ?? 0) - (b.time ?? 0)
      })
      out.set(sessionId, list)
    }
    return out
  }
}

/**
 * 两条归一化事件是否"内容相同"（用于跨代际去重时确认是真重复）。
 *
 * 比较 JSON 序列化：事件体量小（最大的 tool/result 也就几十 KB），
 * 而且只在**键相撞**时才会走到这里，所以代价可以忽略。
 * 序列化失败（循环引用等，正常不会发生）时判为**不同**，宁可保留。
 */
function sameEventContent(a, b) {
  if (a.type !== b.type) return false
  try {
    return JSON.stringify(a.data) === JSON.stringify(b.data)
  } catch {
    return false
  }
}

/**
 * 把一帧解析出的事件归一化成可跨版本处理的事件记录。
 *
 * 归一化做三件事：
 *
 * 1. **补 sessionId**：会话日志的行里没有 sessionId，只有目录名有。
 * 2. **拍平 message 位置差异**：实测 `user/message` 的 `data` **就是** message
 *    本身（含 `role`/`content`/`source`），而 `assistant/message` 与
 *    `tool/result` 是 `data.message`。这个不一致是真实存在的，不拍平后面每处都要判两次。
 * 3. **取出 tool/result 的 callId**：它在 `data.message.source.callId`，
 *    **不在** `data.toolCallId`（后者实测不存在）。这个坑会让按
 *    top-level `toolCallId` 配对的做法永远配不上任何一条。
 */
export function normalizeInto(out, events, sessionId, frameStart) {
  for (const event of events) {
    const type = event?.type
    if (typeof type !== 'string') continue
    const data = event.data ?? {}
    const record = {
      type,
      seq: typeof event.seq === 'number' ? event.seq : null,
      time: typeof event.time === 'number' ? event.time : null,
      sessionId,
      frameStart,
      turn: typeof data.turn === 'number' ? data.turn : null,
      step: typeof data.step === 'number' ? data.step : null,
      data,
      message: null,
    }
    if (type === 'user/message') {
      record.message = data
    } else if (data.message && typeof data.message === 'object') {
      record.message = data.message
    }
    if (type === 'tool/result') {
      record.callId = data.message?.source?.callId ?? null
      record.isError = data.message?.isError === true || data.error !== undefined
      record.errorCode = data.error?.code ?? null
    }
    if (type === 'tool/call') {
      record.callId = data.callId ?? null
      record.toolName = data.name ?? null
    }
    out.push(record)
  }
}
