/**
 * 会话日志的**增量**读取层。
 *
 * ## 只读承诺
 *
 * 本模块对 `$DSH_HOME/sessions/` 只做 `readdir` / `stat` / `open`+`read`（只读游标
 * 之后那一段）/ `readFile`（全量兜底）。全部代码里没有对该目录的
 * `write*` / `rename*` / `mkdir*` / `unlink*` / `rm*` 调用 —— 明文缓存的回收
 * （`rmSync`）只作用于**状态目录**下的 `plain/`。
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
 * 外加一个顶层字段 `cursor.rotor`（上一轮的轮转起点，见下面"位置性饥饿"）。
 *
 * 每轮对每个文件：
 *
 *   1. `size = statSync(file).size`
 *   2. `size === offset` → **零新字节，直接 continue**（绝大多数文件走这条）
 *   3. `size < offset` → 文件被截断/轮转，游标作废，从 0 全量重来
 *   4. 否则 `openSync` + `readSync` 只读 `[offset, size)` 这一段 →
 *      `scanZstdFrames(segment, 还需要的新帧数, offset)` 只做**结构扫描**
 *      （不解压任何 block，只按 block header 跳过 payload）→ 对新帧逐帧
 *      `zstdDecompressSync(slice, {maxWindowSize, maxOutputLength})`
 *
 * **每一个帧只会被解压一次**：新帧的明文**追加**到明文缓存文件，游标前进。
 * 需要"该文件完整事件集"时读明文缓存即可，不需要回头重解历史帧 ——
 * 这就是把 `plain` 落盘的全部理由（换掉"每次全量重解"）。
 *
 * ## 为什么可以从游标处开始扫（第 4 步只读尾巴）
 *
 * 改动前是 `readFileSync` 整个文件 + `scanZstdFrames(buffer)`（默认
 * `maxFrames=Infinity`）把全部 block header 走一遍，再用
 * `frames.filter(f => f.end > offset)` 把前面的帧全丢掉。文件几 MB、几万帧时，
 * 这是**每轮（默认 120 秒一次）一次的纯浪费**。
 *
 * 现在只读游标之后那一段：**每帧自带 magic，所以段首就是帧边界**，
 * 从段起点扫与"全文件扫完再过滤"逐帧等价（`test/scan-tail.mjs` 逐帧断言过）。
 * 代价是 `offset` 必须真的是帧边界 —— 所以对段首 magic 做了显式复核，
 * 不是就退回全量扫并记 warn（见 `#decode`，**不猜**）。
 *
 * 帧区间与错误信息里的字节偏移**始终是整文件偏移**：`scanZstdFrames()` 的
 * `baseOffset` 参数负责把段内偏移换算回去（`decompressFrame()` 的第四个参数
 * 负责换回来），否则游标水位、warn 文案、宿主 parity 三者的坐标系会互相矛盾。
 *
 * ## 位置性饥饿与轮转起点（`cursor.rotor`）
 *
 * 每轮的帧预算（默认 400）是按文件顺序消费的，预算耗尽时排在后面的文件
 * 一个帧都读不到。作者实测：216 个会话文件里一度有 100 个 `offset=0`，
 * 按每轮 400 帧要 130 轮以上才能轮到它们 —— 在那之前这些文件的事件
 * **完全不在**信号里，而外观与"没有新数据"一模一样。
 *
 * 所以每轮把"本轮第一个**完全没被读到**的文件"记进 `cursor.rotor`（字符串 rel），
 * 下一轮从它开始（绕回表头）。这样每轮起点都前移，每个文件最多等一轮
 * 就能拿到一次预算，而不是等前面所有文件跑完。同一份输入得到同一个顺序。
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
import { scanZstdFrames, decompressFrame, parseJsonlFrame, ZSTD_MAGIC } from './frames.js'

/** 一个会话日志文件的相对路径 → 明文缓存文件名。 */
function plainName(rel) {
  return `${crypto.createHash('sha1').update(rel).digest('hex')}.jsonl`
}

/**
 * 只读 `[position, position + length)` 这一段字节。
 *
 * 为什么不用 `readFileSync`：会话日志是 MB 级、几千到几万帧，而每轮真正要读的
 * 只有游标之后那几百 KB。`readFileSync` 会把游标之前那几 MB 一起读进内存再丢掉
 * （`#decode` 的 `frames.filter(f => f.end > from)` 就是这个"丢掉"）。
 *
 * `readSync` 允许短读：文件可能在被宿主追加（读得比预期多没问题，我们只读
 * `length`），也可能在读的瞬间被截断/轮转（读得比预期少）。所以循环读到读满
 * 或 EOF 为止，返回值**可能短于** `length`，由调用方按实际长度判断。
 *
 * @param {string} file 绝对路径
 * @param {number} position 起始字节（整文件偏移）
 * @param {number} length 想读多少字节
 * @returns {Buffer} 实际读到的字节（长度 ≤ length）
 */
function readRange(file, position, length) {
  const out = Buffer.allocUnsafe(length)
  const fd = fs.openSync(file, 'r')
  try {
    let filled = 0
    while (filled < length) {
      const bytes = fs.readSync(fd, out, filled, length - filled, position + filled)
      if (bytes <= 0) break // EOF：文件比 statSync 时看到的短了
      filled += bytes
    }
    return filled === length ? out : out.subarray(0, filled)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 把文件列表旋转到本轮起点 `rotor`（上一轮第一个没被读到的文件）。
 *
 * `rotor` 找不到（首次扫描；或那个文件已经消失、游标条目已被退休）时原样返回 ——
 * 起点退回表头，顺序仍然是确定的。返回新数组，不改调用方的列表。
 */
function rotateFrom(files, rotor) {
  if (!rotor) return files
  const index = files.findIndex(info => info.rel === rotor)
  if (index <= 0) return files
  return files.slice(index).concat(files.slice(0, index))
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

  /**
   * 冷启动：从明文缓存重建 `byFile`，不碰会话目录、不解压任何帧。
   *
   * 同步版**保留**（测试与降级路径用）。实现委托给 `#warmEntry()`，
   * 与 `warmFromCacheAsync()` 共用同一份逻辑 —— 两份实现漂移过一次就够了。
   */
  warmFromCache(cursor) {
    if (!cursor?.files) return
    for (const [rel, entry] of Object.entries(cursor.files)) {
      this.#warmEntry(rel, entry)
    }
  }

  /**
   * `warmFromCache` 的异步版：语义**完全一致**（同样的 warn、同样的"缓存缺失就
   * 作废该文件游标"、同样的条数不一致告警），只是每处理 `yieldEvery` 个文件
   * `await` 一次 `setImmediate` 让出事件循环。
   *
   * 为什么需要：调用点在宿主 `apply()` 里（`lib/index.js`），而语料大时这里是
   * 一串同步 `readFileSync` + 逐行 `JSON.parse`，会把宿主启动卡住秒级。
   * 同步版留着是因为单测与降级路径需要"调用完就绪"的语义。
   *
   * @param {object} cursor 可变的持久化游标
   * @param {{yieldEvery?:number}} [options] `yieldEvery <= 0` 表示不让出（等价同步）
   */
  async warmFromCacheAsync(cursor, { yieldEvery = 8 } = {}) {
    if (!cursor?.files) return
    const entries = Object.entries(cursor.files)
    for (let index = 0; index < entries.length; index += 1) {
      // 先让出再处理：第一个文件之前让出没有意义（调用方紧接着就在等这个 Promise）
      if (index > 0 && yieldEvery > 0 && index % yieldEvery === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
      const [rel, entry] = entries[index]
      this.#warmEntry(rel, entry)
    }
  }

  /**
   * 重建**一个文件**的 `byFile` 条目（`warmFromCache` 与 `warmFromCacheAsync`
   * 的唯一实现）。
   *
   * @returns {boolean} 是否成功从缓存还原（false = 缓存缺失/读不到，游标已作废）
   */
  #warmEntry(rel, entry) {
    if (!entry?.plain) return false
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
      return false
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
    return true
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
    // 会话目录里已经消失的文件：连游标一起退休，避免无限增长
    const seen = new Set(files.map(f => f.rel))
    for (const rel of Object.keys(cursor.files)) {
      if (seen.has(rel)) continue
      // 列举失败会返回不完整的列表。只有文件**真的不在磁盘上**才退休：
      // 否则一次权限抖动就会把整个游标清空，下次扫描要从零重解全部帧
      // （实测 216 个文件 / 6.4 万帧，按每轮 400 帧的预算要 130 轮以上）。
      if (fs.existsSync(path.join(this.sessionsRoot, rel))) continue
      const entry = cursor.files[rel]
      delete cursor.files[rel]
      this.byFile.delete(rel)
      // 游标退休了，磁盘上的明文缓存就成了**永久孤儿**：以前只删游标条目，
      // `plain/<sha1(rel)>.jsonl` 一直留着，会话目录删得越多泄漏越多。
      // best-effort 回收：删不掉（句柄被占、目录只读、本来就没了）不是错误路径，
      // 退化成改动前的行为，只留一条 debug。
      //
      // 只删"已经没有任何游标条目还引用"的那一份 —— 缓存名取游标自己记下的
      // `entry.plain`（可能是 null，那就回退到由 rel 推出来的确定性名字）。
      const name = entry?.plain ?? plainName(rel)
      if (!Object.values(cursor.files).some(other => other?.plain === name)) {
        // ⚠️ 变量必须叫 plainPath 且保持第二个实参：selftest 第 13 节按
        // **第一个实参的字面量**穷举写目标白名单，`plainPath` 就是白名单里
        // "明文字典路径（由 this.plainDir 派生）"那一项。写目标本身没变，
        // 仍然是状态目录下的明文缓存。
        const plainPath = path.join(this.plainDir, name)
        // 游标是磁盘上的 JSON（外部可写），所以删之前先确认名字没把路径带出
        // `plain/`：一个被改坏的 `plain: "../../x"` 不该让删除动作跑到目录外面。
        if (path.dirname(path.resolve(plainPath)) !== path.resolve(this.plainDir)) {
          this.log.debug(`[scan] 明文缓存名不在 plain/ 之下，拒绝回收 ${name}`)
        } else {
          try {
            // force: 文件已经不在时静默（缓存本来就可能被别的东西清掉过）
            fs.rmSync(plainPath, { force: true })
          } catch (error) {
            this.log.debug(`[scan] 回收明文缓存失败（忽略） ${plainPath}: ${error?.message ?? error}`)
          }
        }
      }
    }

    // ── 轮转起点（位置性饥饿的修复，见文件头"位置性饥饿与轮转起点"）──
    // 从上一轮第一个**完全没被读到**的文件开始、绕回表头。不这么做的话，
    // 预算每轮都从 0 号文件开始花，排在后面的文件要等前面全部读完才轮得到。
    // 用 rel（而不是下标）做锚点：文件增删后下标会漂，rel 不会。
    let rotor = null
    let budget = this.maxFramesPerScan
    for (const info of rotateFrom(files, cursor.rotor)) {
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
      if (decoded.skipped) {
        stats.skipped += 1
        // 第一个"整轮一个帧都没解"的文件就是下一轮的起点：轮到它时预算已经花光，
        // 所以它（以及它后面的所有文件）本轮什么都没读到。
        if (rotor === null) rotor = info.rel
      }
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
    // 本轮全部读完了（没有任何文件被跳过）→ 起点归零，下一轮重新从头扫一遍。
    // 留着上一个 rotor 也"没错"，但它会让下一轮的顺序取决于历史，调试时更难读。
    cursor.rotor = rotor
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
   * @param {number} budget 本轮还剩多少帧可以解压（`Infinity` = 不限）
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

    // ── 只读游标之后的那一段（见文件头"为什么可以从游标处开始扫"）──
    // `base` 是这个 buffer 对应的整文件起点：帧区间由 scanZstdFrames 换算成
    // 整文件偏移，decompressFrame 再用它把偏移换回 buffer 下标。
    let buffer
    let base = 0
    // 是否"只读了尾巴"。它决定扫描能不能按预算截断：截断扫描看到的是段的
    // 末尾（torn），而全量扫描看到的老帧要先用 `end > from` 丢掉，截断会漏帧。
    let tailOnly = false
    if (from === 0) {
      buffer = fs.readFileSync(info.file)
    } else {
      const segment = readRange(info.file, from, info.size - from)
      if (segment.length >= 4 && segment.readUInt32LE(0) !== ZSTD_MAGIC) {
        // 段首不是 magic → `from` 不是帧边界：老版本游标语义、外部动过文件、
        // 或者游标被别的东西写过。**不猜**（猜错会把中间那一帧的明文永久漏掉），
        // 退回从 0 全量扫，语义与改动前完全一致，代价只是多读一次盘 + 一条 warn。
        this.log.warn(`[scan] 游标位置不是帧边界（offset=${from}），退回全量扫描 ${info.rel}`)
        buffer = fs.readFileSync(info.file)
      } else {
        // 段首就是帧边界（正常情况下必然）。不足 4 字节的尾巴不在这里判错 ——
        // 交给 scanZstdFrames 判成 tornStart，那才是"正在写入"的正常形态。
        buffer = segment
        base = from
        tailOnly = true
      }
    }

    // 结构扫描的**上界 = 本轮还需要的新帧数**。改动前不传 maxFrames（默认
    // Infinity），预算用尽时仍然把整个文件的 block header 走一遍，只为拿到
    // 后面那个 `fresh.slice(0, remaining)`。
    //   - `remaining === 0` 时仍然要扫 1 帧：必须区分「这个文件确实有新帧但本轮
    //     没预算」（要记 skipped，否则会给没读过的文件落游标）与「只有 torn 尾巴
    //     在长」（offset 不前进）。
    //   - 全量扫 + 需要丢老帧（兜底路径）时不能截断：老帧的个数未知，而过滤发生
    //     在 scanZstdFrames 之后，截断会把真正的新帧一起漏掉。
    const scanLimit = Number.isFinite(remaining) ? Math.max(1, remaining) : Number.POSITIVE_INFINITY
    const filtering = !tailOnly && from > 0
    const { frames, tornStart } = scanZstdFrames(
      buffer,
      filtering ? Number.POSITIVE_INFINITY : scanLimit,
      base,
    )
    if (tornStart !== undefined) {
      // ⚠️ 被 scanLimit 截断时 scanZstdFrames 直接返回 `{frames}`、**不返回**
      // tornStart（它没走到文件尾，本来就不知道尾巴什么样）。所以这条日志只会
      // **漏报**、不会误报 —— 它只是 debug 信息，任何判断都不许依赖它。
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

    // `take` 是本轮**真正解压**的帧：扫描被预算截断时它比 `fresh` 短，所以
    // 水位（下面的 `take[take.length-1].end`）只会推进到最后一个解压过的帧末尾，
    // 而不是"扫描到的最后一帧"、更不是文件末尾 —— 水位必须是"明文缓存写到哪了"
    // 的诚实反映，否则下一轮会跳过中间那几帧。
    const take = fresh.slice(0, remaining)
    const plainPath = this.#plainPath(info.rel)
    fs.mkdirSync(this.plainDir, { recursive: true })

    let records = []
    let newEvents = 0
    if (rebuild) {
      // 全量重来：缓存整体重写（既是截断恢复，也是"内存集丢了"的恢复）
      const parts = []
      for (const frame of take) {
        const text = decompressFrame(buffer, frame, this.maxWindowSize, base)
        parts.push(text)
        normalizeInto(records, this.#parseFrame(text, info.rel, frame.start), info.sessionId, frame.start)
      }
      fs.writeFileSync(plainPath, parts.join(''), 'utf8')
      newEvents = records.length
    } else {
      // 增量追加：只解压新帧，只追加写
      const parts = []
      for (const frame of take) {
        const text = decompressFrame(buffer, frame, this.maxWindowSize, base)
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
   * ## 位置性地补 turn（`user/message` 没有 `data.turn`）
   *
   * 实测：`turn/start` / `tool/call` / `assistant/message` 的 `data.turn` 都在，
   * 但 `user/message` 的**顶层只有** `type/seq/time/data/surfaceOp`，`data` 就是
   * message 本身（`content/source/role/id`），**没有 turn**。于是
   * `normalizeInto()` 出来的 `user/message` 记录 turn 恒为 null，而 signals.js
   * 的 `freeformAnswers` 有一条位置约束要靠 `candidate.turn` 判断"提问轮与下一条
   * 真人发言之间跨没跨回合"（signals.js:465）—— 恒为 null 让那条约束**永远不成立**，
   * 用户换个话题也照样计数（作者在真机语料上核对过：计 2 次，而生成器自己说
   * 材料里找不到对应发言）。
   *
   * 修法：**在排序之后**沿事件流维护 `currentTurn`，把 `turn === null` 的记录
   * 贴上"当前所处的回合"。⚠️ **不能只在单帧内推**：`turn/start` 可能在更早的
   * 帧里（不同 frame、甚至同会话的另一个明文缓存文件）—— 单帧内推会漏掉绝大多数
   * `user/message`。这正是必须放在 `bySession()`（跨文件聚合＋排序之后）的原因。
   *
   * 幂等性：贴过 turn 的记录再进来时只会把 `currentTurn` 重置成同一个值，
   * 所以反复调用 `bySession()` 结果不变（除非底层事件集真的变了）。
   *
   * @returns {Map<string, object[]>} sessionId → 事件（按 seq 升序）
   */
  /**
   * @param {{humanOnly?: boolean}} [options] `humanOnly` = 只聚合同一个会话里
   *   `session` 事件没有标 `origin: 'subagent'` 的那些。默认 `false`（保持旧行为：
   *   界面点开单个会话、排障脚本都要能看到子代理会话）。
   *   判据只看**会话头**，不看事件内容 —— 子代理会话里的委派 prompt 也是
   *   `source.kind === 'user'`，靠消息本身没法区分（这正是要过滤的原因）。
   */
  bySession(options = {}) {
    const humanOnly = options?.humanOnly === true
    // 来源是**会话级**属性，不是文件级：同一个 sessionId 可能同时有 v3/v4 两个
    // 日志文件，而 session 头只出现在其中一个里（实测当前语料 18 个多文件会话）。
    // 先按 sessionId 聚合"这个会话是不是子代理"，再决定整个会话进不进主集合；
    // 按文件判会让"子代理会话的无头伴生文件"整个漏进主集合。
    const subagentSessions = new Set()
    if (humanOnly) {
      for (const [rel, records] of this.byFile) {
        const sessionId = rel.split(path.sep).at(-2) ?? rel
        const header = records.find(record => record.type === 'session')
        // `parentSession` 有值也按子代理处理：那是"被派生出来的会话"的硬证据，
        // 比 origin 更不容易缺失（origin 缺失的旧文件仍能被它兜住）。
        if (header && (header.origin === 'subagent' || header.parentSession)) {
          subagentSessions.add(sessionId)
        }
      }
    }
    /** @type {Map<string, {byKey: Map<string, object>, list: object[]}>} */
    const grouped = new Map()
    for (const [rel, records] of this.byFile) {
      const sessionId = rel.split(path.sep).at(-2) ?? rel
      if (humanOnly && subagentSessions.has(sessionId)) continue
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
      // 位置性地补 turn（上面"位置性地补 turn"一节）：`turn/start` 与任何
      // `data.turn` 非空的事件都会把 currentTurn 推到新回合，之后 turn 为 null 的
      // 记录（现实里就是全部 `user/message`）落在哪个回合就贴哪个回合。
      // 流的最前面若还没有任何回合标记，就保持 null —— 不许凭空造一个 turn 出来。
      let currentTurn = null
      for (const record of list) {
        if (record.turn !== null) currentTurn = record.turn
        else if (currentTurn !== null) record.turn = currentTurn
      }
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
 * 4. **记住会话来源**：`session` 事件的 `origin` / `parentSession` / `delegationDepth`
 *    在事件顶层（不在 `data` 里），原来被整条丢掉 —— 于是子代理会话里的委派 prompt
 *    被当成人说的话计入画像材料与触发计数（实测 235 个会话文件里 179 个是子代理，
 *    188 条“真人消息”其实是父代理写的 prompt）。这里只保留判断来源所需的最小集合。
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
    // 会话头（`type === 'session'`）的来源字段在**事件顶层**，不在 `data` 里。
    // 实测形状：`{type:'session', id, createdAt, cwd, parentSession, origin:'subagent', delegationDepth}`
    // 只留判断来源需要的三个，不复制 `cwd` 等其他字段。
    if (type === 'session') {
      record.origin = typeof event.origin === 'string' ? event.origin : null
      record.parentSession = typeof event.parentSession === 'string' ? event.parentSession : null
      record.delegationDepth = typeof event.delegationDepth === 'number' ? event.delegationDepth : null
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
