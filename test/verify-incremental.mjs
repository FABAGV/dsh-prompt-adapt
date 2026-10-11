// verify-incremental.mjs —— 实测增量读取：连跑到追平，再看"追平后"是否零解压
//
// 注意：SessionScanner 构造器不给 maxFramesPerScan / maxWindowSize 兜底，
// 必须与 schema.js 默认值一致（400 / 64<<20），否则 budget=undefined → 取 0 帧。
// 预算 400 是**每次扫描的全局上限**，所以初次要跑很多轮才追平 —— 这是设计，不是 bug。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const { SessionScanner } = await import('file:///R:/dsh-prompt-adapt/lib/sessions.js')

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const tmp = path.join(os.tmpdir(), 'verify-incr-' + Date.now())
const plainDir = path.join(tmp, 'plain')
fs.mkdirSync(plainDir, { recursive: true })

const scanner = new SessionScanner({
  sessionsRoot, plainDir, maxFramesPerScan: 400, maxWindowSize: 64 << 20,
})
const cursor = { version: 1, files: {} }

console.log('=== 阶段 1：连跑到追平（每轮最多 400 帧）===')
let round = 0, totalFrames = 0, totalMs = 0
while (round < 200) {
  round++
  const t0 = Date.now()
  const s = scanner.scan(cursor)
  const ms = Date.now() - t0
  totalFrames += s.newFrames
  totalMs += ms
  if (round <= 3 || s.newFrames === 0) {
    console.log(`  第 ${String(round).padStart(3)} 轮: newFrames=${String(s.newFrames).padStart(4)}  newEvents=${String(s.newEvents).padStart(5)}  ${ms}ms`)
  }
  if (s.newFrames === 0) break
}
console.log(`  追平用了 ${round} 轮，共解压 ${totalFrames} 帧，累计 ${totalMs} ms`)

console.log('\n=== 阶段 2：追平后再扫 3 次（应全部零解压）===')
const after = []
for (let i = 1; i <= 3; i++) {
  const t0 = Date.now()
  const s = scanner.scan(cursor)
  const ms = Date.now() - t0
  after.push({ i, ms, newFrames: s.newFrames })
  console.log(`  第 ${i} 次: newFrames=${s.newFrames}  ${ms}ms`)
}

console.log('\n=== 判定 ===')
const allZero = after.every((a) => a.newFrames === 0)
if (allZero) {
  console.log(`  ✅ 真增量：追平后 ${after.length} 次扫描全部 0 帧`)
  console.log(`     追平期平均 ${(totalMs / round).toFixed(0)} ms/轮；追平后平均 ${(after.reduce((a, b) => a + b.ms, 0) / after.length).toFixed(0)} ms/次`)
} else {
  console.log(`  ❌ 追平后仍有新帧: ${JSON.stringify(after)}`)
}

console.log('\n=== 阶段 3：游标落盘 → 新进程复用（模拟重启）===')
const cursorPath = path.join(tmp, 'cursor.json')
fs.writeFileSync(cursorPath, JSON.stringify(cursor))
const restored = JSON.parse(fs.readFileSync(cursorPath, 'utf8'))
const scanner2 = new SessionScanner({
  sessionsRoot, plainDir, maxFramesPerScan: 400, maxWindowSize: 64 << 20,
})
scanner2.warmFromCache(restored)
const s2 = scanner2.scan(restored)
console.log(`  warmFromCache 后首次扫描: newFrames=${s2.newFrames} newEvents=${s2.newEvents}`)
console.log(s2.newFrames === 0 ? '  ✅ 重启后无需重新解压（明文缓存 + 游标都有效）' : `  🔶 重启后仍需解压 ${s2.newFrames} 帧`)

fs.rmSync(tmp, { recursive: true, force: true })
