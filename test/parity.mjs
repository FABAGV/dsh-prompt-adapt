/**
 * 差分校验：把本插件的 `scanZstdFrames()` 与**宿主自己的同名实现**逐帧比对。
 *
 * 为什么值得单独做一个测试：
 *   本插件的切帧逻辑是复刻 `@deepseek-ai/dsh-session-persistence-jsonl` 的
 *   `scanZstdFrames()`（该包只 `export default JsonlSessionPersistence`，
 *   `scanZstdFrames` **没有从入口导出**，所以插件无法 import，只能复刻）。
 *   复刻就有走样的风险，而"帧切错"会静默丢事件 —— 必须用宿主的实现当标尺。
 *
 * 输入是**全部真实会话日志**，不是构造样本。
 * 运行：
 *   node test/parity.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scanZstdFrames as mine, decompressFrame } from '../lib/frames.js'
import { listSessionFiles } from '../lib/sessions.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')

/**
 * 从宿主的实现里把 `scanZstdFrames()` 抠出来当标尺。
 *
 * 该包只 `export default JsonlSessionPersistence`，`scanZstdFrames` 不在导出表里，
 * 所以只能取源码。做法：花括号配对取出函数体，并把宿主自己那个
 * `ZSTD_MAGIC` 常量的**字面量**一并取出来注入 —— 否则函数体里引用的是模块作用域的
 * 常量，脱离模块就 `ReferenceError`。
 *
 * 任何一步失败都返回 null，由调用方**判为失败**（不是跳过）：
 * 标尺取不到就不该声称"比对通过"。
 */
function loadCanonical() {
  // 路径**不能写死**：标尺包的位置随 profile 名与安装方式而变，写死会让别人 clone
  // 下来直接判失败。按优先级探：显式环境变量 → 各 profile 的 node_modules。
  const REL = '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
  const candidates = []
  if (process.env.DSH_CANONICAL_SESSION_PKG) candidates.push(process.env.DSH_CANONICAL_SESSION_PKG)
  const profilesRoot = path.join(DSH_HOME, 'profiles')
  if (fs.existsSync(profilesRoot)) {
    // profiles/<name>/node_modules/... 与 profiles/node_modules/... 两种布局都试
    candidates.push(path.join(profilesRoot, 'node_modules', REL))
    for (const name of fs.readdirSync(profilesRoot)) {
      candidates.push(path.join(profilesRoot, name, 'node_modules', REL))
    }
  }
  // 最后兜底：本插件自己的 node_modules（README 里的 junction 方案）
  candidates.push(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'node_modules', REL))
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const source = fs.readFileSync(file, 'utf8')

    const start = source.indexOf('function scanZstdFrames(')
    if (start < 0) return { error: `${file}: 找不到 function scanZstdFrames(` }

    // 花括号配对找函数结尾
    let depth = 0
    let index = source.indexOf('{', start)
    for (; index < source.length; index++) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (depth !== 0) return { error: `${file}: 花括号配对失败` }
    const body = source.slice(start, index + 1)

    // 取出宿主的 ZSTD_MAGIC 字面量
    const magicMatch = source.match(/const ZSTD_MAGIC\s*=\s*([0-9a-fA-Fx_]+)\s*;?/)
    if (!magicMatch) return { error: `${file}: 找不到 ZSTD_MAGIC 常量` }
    const magicValue = Number(magicMatch[1].replace(/_/g, ''))
    if (!Number.isFinite(magicValue)) return { error: `${file}: ZSTD_MAGIC 字面量无法解析` }

    let fn
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function(`const ZSTD_MAGIC = ${magicValue}; ${body}; return scanZstdFrames;`)()
    } catch (error) {
      return { error: `${file}: 求值失败 ${error.message}` }
    }

    // 自证可用：拿一个真文件试跑，抛错就当标尺不可用
    try {
      const probeFile = findAnySessionFile(SESSIONS_ROOT)
      if (!probeFile) return { error: `${file}: 找不到用于试跑的会话日志` }
      const probeResult = fn(fs.readFileSync(probeFile))
      if (!Array.isArray(probeResult.frames) || probeResult.frames.length === 0) {
        return { error: `${file}: 标尺试跑没返回任何帧` }
      }
    } catch (error) {
      return { error: `${file}: 标尺试跑失败 ${error.message}` }
    }

    return { file, fn, magicValue }
  }
  return { error: '候选路径都不存在' }
}

/** 递归找一个会话日志文件（只为标尺试跑用）。 */
function findAnySessionFile(root) {
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    for (const session of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = path.join(projectDir, session.name)
      const name = fs.readdirSync(sessionDir).find(entry => entry.endsWith('.jsonl.zstd'))
      if (name) return path.join(sessionDir, name)
    }
  }
  return null
}

const canonical = loadCanonical()

console.log('='.repeat(72))
console.log('帧扫描差分校验（本插件 vs 宿主实现）')
console.log('='.repeat(72))

if (canonical.error) {
  // ⚠️ 标尺取不到 = 无法证明一致 → 判为失败，而不是"跳过"。
  // 一个 0 比对的 PASS 比 FAIL 危险得多。
  console.log(`  FAIL 标尺不可用：${canonical.error}`)
  console.log('='.repeat(72))
  console.log('结果：FAIL —— 无法与宿主实现比对')
  console.log('='.repeat(72))
  process.exit(1)
}
console.log(`  标尺来源：${canonical.file}（ZSTD_MAGIC=${canonical.magicValue}）`)
console.log(`  标尺自证：试跑返回了帧`)
console.log('')

const files = listSessionFiles(SESSIONS_ROOT)
console.log(`  真实会话日志：${files.length} 个`)

let frameMismatch = 0
let tornMismatch = 0
let magicMismatch = 0
let totalFrames = 0
let totalTorn = 0
let plainMismatch = 0
let filesWithTorn = 0
let compared = 0
let canonicalErrors = 0
const problems = []

for (const info of files) {
  const buffer = fs.readFileSync(info.file)

  let a
  let b
  try {
    a = mine(buffer)
  } catch (error) {
    problems.push(`${info.rel}: 本插件扫描抛错 ${error.message}`)
    continue
  }
  try {
    b = canonical.fn(buffer)
  } catch (error) {
    // 标尺抛错必须显式计数：这是"比对没做成"，不是"比对通过"
    canonicalErrors += 1
    problems.push(`${info.rel}: 宿主标尺抛错 ${error.message}`)
    continue
  }
  compared += 1

  totalFrames += a.frames.length
  if (a.tornStart !== undefined) {
    totalTorn += 1
    filesWithTorn += 1
  }

  if (a.frames.length !== b.frames.length) {
    frameMismatch += 1
    problems.push(`${info.rel}: 帧数 ${a.frames.length} vs ${b.frames.length}`)
    continue
  }
  for (let i = 0; i < a.frames.length; i++) {
    if (a.frames[i].start !== b.frames[i].start || a.frames[i].end !== b.frames[i].end) {
      frameMismatch += 1
      problems.push(
        `${info.rel}: 第 ${i} 帧区间 ${a.frames[i].start}-${a.frames[i].end} vs ${b.frames[i].start}-${b.frames[i].end}`,
      )
      break
    }
  }
  if ((a.tornStart ?? null) !== (b.tornStart ?? null)) {
    tornMismatch += 1
    problems.push(`${info.rel}: tornStart ${a.tornStart} vs ${b.tornStart}`)
  }

  // magic 自检：每个帧的起点都必须真的是 magic
  for (const frame of a.frames) {
    if (buffer.readUInt32LE(frame.start) !== 0xfd2fb528) {
      magicMismatch += 1
      problems.push(`${info.rel}: 帧起点 ${frame.start} 不是 magic`)
      break
    }
  }

  // 明文一致性：与"整帧直接解压"逐字节比对
  for (const frame of a.frames.slice(0, 3)) {
    const viaHelper = decompressFrame(buffer, frame, 64 << 20)
    const zlib = await import('node:zlib')
    const direct = zlib.default
      .zstdDecompressSync(buffer.subarray(frame.start, frame.end), { maxWindowSize: 64 << 20 })
      .toString('utf8')
    if (viaHelper !== direct) {
      plainMismatch += 1
      problems.push(`${info.rel}: 帧 ${frame.start} 明文不一致`)
      break
    }
  }
}

console.log(`  参与比对的文件：${compared} / ${files.length}`)
console.log(`  总帧数：${totalFrames}`)
console.log(`  带未完成末帧的文件：${filesWithTorn}（正常 —— 正在被写入的会话）`)
console.log('')
console.log(`  帧区间不一致：${frameMismatch}`)
console.log(`  tornStart 不一致：${tornMismatch}`)
console.log(`  magic 自检失败：${magicMismatch}`)
console.log(`  明文不一致：${plainMismatch}`)
console.log(`  标尺抛错（= 比对没做成）：${canonicalErrors}`)

if (problems.length) {
  console.log('')
  console.log('  问题明细（前 10 条）：')
  for (const problem of problems.slice(0, 10)) console.log(`    - ${problem}`)
}

const ok =
  frameMismatch === 0 &&
  tornMismatch === 0 &&
  magicMismatch === 0 &&
  plainMismatch === 0 &&
  canonicalErrors === 0 &&
  compared > 0 &&
  totalFrames > 0
console.log('')
console.log('='.repeat(72))
console.log(ok
  ? `结果：PASS —— ${compared} 个文件 / ${totalFrames} 帧与宿主实现逐帧一致`
  : `结果：FAIL —— compared=${compared} frames=${totalFrames} canonicalErrors=${canonicalErrors}`)
console.log('='.repeat(72))
process.exit(ok ? 0 : 1)
