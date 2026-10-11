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
 * 本插件额外传 `{ maxWindowSize }`（默认 64MiB）作为防御：
 * 帧头部声明的窗口大小若异常膨胀，解压会直接失败而不是尝试分配巨量内存。
 * 实测本机 Node v24.21.0 接受该选项。
 */
import zlib from 'node:zlib'

/** Zstandard magic number，小端读入后的整数值。 */
export const ZSTD_MAGIC = 0xfd2fb528

/**
 * 定位拼接流里每一个**结构完整**的帧，不解压任何 block。
 *
 * @param {Buffer} buffer 会话日志当前的全部字节
 * @param {number} [maxFrames] 最多返回多少个完整帧
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 *   完整帧范围（文件顺序）＋ 可选的不完整末帧起点
 * @throws {Error} 结构非法（magic 错、保留位、保留 block 类型）时抛
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    // 不足 4 字节：连 magic 都读不全，判为未完成的末帧
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    // Frame_Header_Descriptor
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // 第 3、4 位（0x18）是保留位，必须为 0
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    // contentSizeFlag==0 时：singleSegment 帧仍有 1 字节 content size，非 single 帧没有
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    // 依次走完所有 block，直到 last_block
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      // RLE block 的 payload 只有 1 字节，其余类型是 blockSize 字节
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * 解压一个结构完整的帧。
 * @param {Buffer} buffer 整个文件的字节
 * @param {{start:number,end:number}} frame 帧范围
 * @param {number} maxWindowSize 传给 zstdDecompressSync 的窗口上限
 * @returns {string} 帧的 UTF-8 明文
 */
export function decompressFrame(buffer, frame, maxWindowSize) {
  try {
    // slice（不是 subarray）确保拿到独立 buffer，避免长期持有整个文件的引用
    const slice = buffer.subarray(frame.start, frame.end)
    return zlib.zstdDecompressSync(slice, { maxWindowSize }).toString('utf8')
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
