/**
 * 输出量对比：**同一份画像、同一组变化**下，老契约（全量重打）与新契约
 * （只输出变化 + 未变条目 id）分别需要模型输出多少。
 *
 * ⚠️ 这是**静态估算**，不是真实 LLM 调用：它算的是"契约要求模型写出来的
 * 那段 JSON 有多长"，不含模型的自由发挥（真实输出只会更长）。token 数用
 * UTF-8 字节数折算，CJK 约 1 token/字、ASCII 约 1 token/4 字节 —— 量级够用。
 *
 * 运行：node tools/delta-size.mjs
 */
import { buildProfilePrompt, normalizeProfile, diffProfiles } from '../lib/profile.js'

/** 一份"条目已经长起来"的画像：24 条，每条 2-3 处引文。 */
function makeProfile(count) {
  const categories = ['A', 'B', 'C', 'D']
  const claims = [
    '用中文沟通，不要中英夹杂',
    '不要在他没要求时做升级或重构',
    '先给分析再动手，不要直接改代码',
    '长任务要边做边报进度，不能静默停住',
    '结论要具体可核对，要引用原文原句',
    '不要写赞美式总结或"总的来说不错"这类评价',
    '实现类任务里不要重新讨论需求',
    '不确定的地方要说"不确定"，不要硬猜',
    '偏好结构化模板：先定角色，再列纪律，再规定输出格式',
    '短祈使句直接下达指令，不要寒暄和背景铺垫',
    '对算力成本敏感，愿意为此接受少量数据损失',
    '希望 AI 直接产出成品，不要反问确认',
    '路径与文件名要给出可点击的链接',
    '代码改动只做最小必要修改，不要顺手改别的',
    '不要在 PowerShell 里用 Get-Content/Set-Content 往返读写中文文件',
    '不要用关键词统计或正则替代 LLM 做语义判断',
    '评审类任务要明确指定 AI 站的角色视角',
    '要求贴出测试的实际输出行，不要只说"通过了"',
    '给出的量化基线是硬线，不得回归',
    '不要把"更详细/更结构化"这类整体印象当结论',
    '希望进度可见：长时间执行时要汇报，不要静默',
    '对"整体印象式"的表述明确排斥',
    '偏好用 Markdown 输出，篇幅要"不要太长也不要太短"',
    '希望关键判断能追溯到一手来源',
  ]
  const entries = []
  for (let i = 0; i < count; i++) {
    entries.push({
      id: `${categories[i % 4]}${i + 1}`,
      category: categories[i % 4],
      claim: claims[i % claims.length],
      evidence: [
        `「${claims[i % claims.length].slice(0, 10)}……」——第 ${i * 7 + 3} 条发言`,
        `「${claims[(i + 3) % claims.length].slice(0, 8)}……」——第 ${i * 11 + 5} 条发言`,
        ...(i % 3 === 0 ? [`第 ${i * 13 + 9} 条发言`] : []),
      ],
      confidence: i % 5 === 0 ? 'high' : 'medium',
      evidenceQuoteCount: i % 3 === 0 ? 3 : 2,
      lastEvidenceMessages: 300 + i,
      firstSeenAt: 1700000000000 + i * 1000,
      lastSeenAt: 1700000000000 + i * 2000,
      timesSeen: 3 + (i % 4),
    })
  }
  return { version: 7, entries }
}

/** 老契约：`entries` 含**全部**条目，未变动的逐字照抄；`unchangedIds` 空。 */
function oldContractOutput(prev, changedIds) {
  return JSON.stringify({
    entries: prev.entries.map(entry => ({
      id: entry.id,
      category: entry.category,
      claim: changedIds.includes(entry.id) ? `${entry.claim}（这一条被改写了）` : entry.claim,
      evidence: entry.evidence,
      confidence: entry.confidence,
    })),
    unchangedIds: [],
    notes: '',
  })
}

/** 新契约：`entries` 只放变化的条目；未变的只列 id。 */
function newContractOutput(prev, changedIds) {
  return JSON.stringify({
    entries: prev.entries
      .filter(entry => changedIds.includes(entry.id))
      .map(entry => ({
        id: entry.id,
        category: entry.category,
        claim: `${entry.claim}（这一条被改写了）`,
        evidence: entry.evidence,
        confidence: entry.confidence,
      })),
    unchangedIds: prev.entries.filter(entry => !changedIds.includes(entry.id)).map(entry => entry.id),
    deletedIds: [],
    notes: '',
  })
}

/** 粗略 token 估算：CJK 1 token/字；ASCII 1 token/4 字节（业界常用口径）。 */
function estimateTokens(text) {
  const chars = [...text]
  const cjk = chars.filter(ch => /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(ch)).length
  const ascii = Buffer.byteLength(text, 'utf8') - cjk * 3
  return Math.ceil(cjk + ascii / 4)
}

console.log('='.repeat(78))
console.log('输出量对比：全量契约 vs 差量契约（同一份画像、同一组变化）')
console.log('='.repeat(78))
console.log('')

const rows = []
for (const count of [8, 12, 16, 20, 24]) {
  for (const changed of [1, 2]) {
    const prev = makeProfile(count)
    const changedIds = prev.entries.slice(0, changed).map(entry => entry.id)
    const oldText = oldContractOutput(prev, changedIds)
    const newText = newContractOutput(prev, changedIds)
    const oldTokens = estimateTokens(oldText)
    const newTokens = estimateTokens(newText)
    rows.push({
      count,
      changed,
      oldBytes: Buffer.byteLength(oldText, 'utf8'),
      newBytes: Buffer.byteLength(newText, 'utf8'),
      oldTokens,
      newTokens,
      ratio: newTokens / oldTokens,
    })
  }
}

const pad = (value, width) => String(value).padStart(width)
console.log('条目数  变化数 | 全量契约 token | 差量契约 token | 差量/全量 | 省下')
console.log('-'.repeat(78))
for (const row of rows) {
  console.log(
    `${pad(row.count, 4)}   ${pad(row.changed, 4)}  | ${pad(row.oldTokens, 12)}   | ${pad(row.newTokens, 12)}   | ` +
      `${pad((row.ratio * 100).toFixed(1) + '%', 8)}  | ${pad((100 - row.ratio * 100).toFixed(1) + '%', 6)}`,
  )
}
console.log('')

// ── 等价性自检：差量契约必须给出与全量契约完全相同的画像 ─────────────
const prev = makeProfile(20)
const changedIds = [prev.entries[0].id, prev.entries[3].id]
const parsedNew = JSON.parse(newContractOutput(prev, changedIds))
const parsedOld = JSON.parse(oldContractOutput(prev, changedIds))
const fromDelta = normalizeProfile(parsedNew, {
  version: 8, evidenceMessages: 400, now: 1, previous: prev, provider: 'p', model: 'm', raw: '',
})
const fromFull = normalizeProfile(parsedOld, {
  version: 8, evidenceMessages: 400, now: 1, previous: prev, provider: 'p', model: 'm', raw: '',
})
const sortById = list => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)))
const equal = JSON.stringify(sortById(fromDelta.entries)) === JSON.stringify(sortById(fromFull.entries))
const diffA = diffProfiles(prev, fromDelta)
const diffB = diffProfiles(prev, fromFull)
console.log('等价性自检（20 条、2 条变化）：')
console.log(`  差量拼装 == 全量输出 : ${equal ? '是' : '否'}`)
console.log(`  diff 完全一致        : ${JSON.stringify(diffA) === JSON.stringify(diffB) ? '是' : '否'}` +
  `（modified=${diffA.modified.length} unchanged=${diffA.unchanged.length} spuriousRate=${diffA.spuriousRate.toFixed(3)}）`)

// ── 提示词侧：新增契约文字带来的输入增量 ──────────────────────────────
const promptText = buildProfilePrompt({
  previousProfile: prev,
  messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
  signals: { delegateRuns: 1, longTools: 2, repeatFailures: 0, freeformAnswers: 3 },
  totalHumanMessages: 400,
  totalSessions: 40,
})
console.log('')
console.log(`提示词总长（含上一版 20 条画像）：${promptText.length} 字符`)
console.log(`  其中"输出格式"小节：${
  (promptText.split('## 输出格式')[1] ?? '').split('## ')[0].length
} 字符（两边都要写，不是新增成本）`)
console.log(`  差量契约新增的说明文字：约 ${estimateTokens('⚠️ 这是差量输出：不要在 entries 里重打未变动条目的正文') * 3} token 量级`)
console.log('')
console.log('⚠️ 以上全部是**静态估算**：算的是"契约要求模型写出的 JSON 有多长"，')
console.log('   不含模型的自由发挥，也没有真实 LLM 调用的计费口径。')
