/**
 * Zstandard 帧扫描与逐帧解压。
 *
 * ## 为什么必须自己切帧
 *
 * 会话日志是**每行一个独立 zstd 帧**的拼接容器（`session.v4.jsonl.zstd`）。
 * Node 的 `zlib.zstdDecompressSync(buffer)` 遇到多帧时**只解第一帧**，
 * 后面的数据静默丢弃 —— 这是本模块存在的唯一理由。
 *
 * ## 与宿主实现的关系（重要）
 *
 * 宿主自带一个等价且更完整的实现：
 * `@deepseek-ai/dsh-session-persistence-jsonl` 的 `scanZstdFrames()`
 * （`lib/index.js:1300`）。它**没有从包入口导出**（该包只 `export default
 * JsonlSessionPersistence`），所以插件无法 import 它，只能复刻算法。
 *
 * 本文件的 `scanZstdFrames()` 是**逐语句对齐**该实现的复刻：同样的
 * Frame_Header_Descriptor 字段拆分（contentSizeFlag / singleSegment /
 * checksum / dictionaryFlag）、同样的 block header 三字节小端解析、
 * 同样的 `tornStart` 语义（EOF 落在一个未完成帧里时返回该帧起点）。
 * 保留 `tornStart` 很关键：正在被写入的最后一个帧是常态，不是错误。
 *
 * ## 解压参数
 *
 * 宿主自己的 public decoder（`lib/index.js:1265`）用的是
 * `zstdDecompressSync(frame)`，**没有传 maxWindowSize**。
 * 本插件额外传 `{ maxWindowSize, maxOutputLength }` 作为防御，两者防的东西不同：
 *
 *   - `maxWindowSize`（调用方给，默认 64MiB）防的是**帧头里声明的窗口大小**
 *     异常膨胀：解压器会按声明去分配历史窗口，声明一个 4GiB 的窗口就能让一次
 *     解压吃掉 4GiB。实测本机 Node v24.21.0 接受该选项。
 *   - `maxOutputLength`（本文件的 `ZSTD_MAX_OUTPUT_LENGTH`）防的是**解压炸弹**：
 *     帧头合法、窗口也不大，但压缩比极高（几十 KB 压出几 GB 明文）——
 *     窗口上限拦不住它，输出上限才拦得住。超限时 Node 抛
 *     `ERR_BUFFER_TOO_LARGE`，本模块把它包成 "corrupt ... failed validation"。
 *
 * 上界取值有实测依据：改动当时本机全部真实会话日志（14 个文件 / 2840 帧）里，
 * 单帧明文最大 319,317 字节（`session.v4.jsonl.zstd` 的某一帧），
 * 64MiB 是它的 **200 倍以上**，不可能误伤真实日志；而炸弹式的帧一定被拦下。
 */
import zlib from 'node:zlib'

/** Zstandard magic number，小端读入后的整数值。 */
export const ZSTD_MAGIC = 0xfd2fb528

/**
 * 单帧明文长度上限（**防解压炸弹**，取值依据见文件头"解压参数"）。
 *
 * 它和 `maxWindowSize` 是两道不同的闸：那个管帧头声明的窗口大小，
 * 这个管解压出来的总字节数 —— 压缩比极高的帧只有后者拦得住。
 */
export const ZSTD_MAX_OUTPUT_LENGTH = 64 << 20

/**
 * 定位拼接流里每一个**结构完整**的帧，不解压任何 block。
 *
 * @param {Buffer} buffer 会话日志（或它从 `baseOffset` 开始的一段）的字节
 * @param {number} [maxFrames] 最多返回多少个完整帧
 * @param {number} [baseOffset] `buffer[0]` 在**整文件**里的偏移。
 *   调用方只读了文件的一段时会传它：返回的 `start`/`end`/`tornStart` 与抛错
 *   文案里的字节偏移都会换算成整文件偏移，与游标水位、日志保持同一坐标系。
 *   段首必须是帧边界（每帧自带 magic，所以"从段首扫"与"全文件扫完再过滤"
 *   逐帧等价）。默认 0 = buffer 就是整个文件，行为与改动前完全一致。
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 *   完整帧范围（文件顺序）＋ 可选的不完整末帧起点
 * @throws {Error} 结构非法（magic 错、保留位、保留 block 类型）时抛
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY, baseOffset = 0) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    // 不足 4 字节：连 magic 都读不全，判为未完成的末帧
    if (buffer.length - offset < 4) return { frames, tornStart: baseOffset + start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(
        `corrupt Zstandard session log: invalid frame magic at byte ${baseOffset + offset}`,
      )
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: baseOffset + start }
    // Frame_Header_Descriptor
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // 第 3、4 位（0x18）是保留位，必须为 0
    if ((descriptor & 24) !== 0) {
      throw new Error(
        `corrupt Zstandard session log: reserved frame-header bit at byte ${baseOffset + offset - 1}`,
      )
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    // contentSizeFlag==0 时：singleSegment 帧仍有 1 字节 content size，非 single 帧没有
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: baseOffset + start }
    offset += remainingHeaderBytes
    // 依次走完所有 block，直到 last_block
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: baseOffset + start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(
          `corrupt Zstandard session log: reserved block type at byte ${baseOffset + offset - 3}`,
        )
      }
      // RLE block 的 payload 只有 1 字节，其余类型是 blockSize 字节
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: baseOffset + start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: baseOffset + start }
      offset += 4
    }
    frames.push({ start: baseOffset + start, end: baseOffset + offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * 解压一个结构完整的帧。
 * @param {Buffer} buffer 整个文件（或其中一段）的字节
 * @param {{start:number,end:number}} frame 帧范围，**整文件偏移**
 * @param {number} maxWindowSize 传给 zstdDecompressSync 的窗口上限
 * @param {number} [baseOffset] `buffer[0]` 在整文件里的偏移（与 `scanZstdFrames`
 *   的第三个参数同一个值）。只读了尾巴的调用方传它，才能把整文件偏移换回
 *   buffer 下标；默认 0 = buffer 就是整个文件。报错文案里的 `frame.start`
 *   **永远是整文件偏移**，不受这个参数影响。
 * @returns {string} 帧的 UTF-8 明文
 */
export function decompressFrame(buffer, frame, maxWindowSize, baseOffset = 0) {
  try {
    // subarray（**不是** slice）是刻意的**零拷贝**视图：这里不做任何保留，
    // zstdDecompressSync 会立即把输入读完（同步、返回后不再引用它），
    // 所以"避免长期持有整个文件"这个理由不成立，拷贝反而白付一次内存。
    const slice = buffer.subarray(frame.start - baseOffset, frame.end - baseOffset)
    return zlib
      .zstdDecompressSync(slice, { maxWindowSize, maxOutputLength: ZSTD_MAX_OUTPUT_LENGTH })
      .toString('utf8')
  } catch (error) {
    throw new Error(
      `corrupt Zstandard session log: frame at byte ${frame.start} failed validation`,
      { cause: error },
    )
  }
}

/**
 * 把一帧明文按 JSONL 拆成事件对象。坏行**跳过而不是整帧失败**：
 * 会话日志在崩溃/截断场景下可能留半行，不该因此丢掉整帧。
 * @param {string} text 帧明文
 * @param {(err: Error, line: string) => void} [onBadLine] 坏行回调
 * @returns {object[]} 解析出的事件
 */
export function parseJsonlFrame(text, onBadLine) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch (error) {
      if (onBadLine) onBadLine(error, line)
    }
  }
  return out
}
