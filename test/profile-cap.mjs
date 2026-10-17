/**
 * 换血上限（`normalizeProfile()` 的 44 条封顶）回归。
 *
 * 规则：画像到 **44 条**后，新增条数必须 ≤ 本轮删除（含合并）条数 —— 总数不许
 * 再涨；超出的**新条目**按 `profileEntryScore()` 从低到高拒绝。改写沿用旧 id
 * 不受限；旧画像本来就 >44 条时**不强制瘦身**（上限取 max(44, 上一版条数)）。
 *
 * 这里钉的行为：
 *   1. 44 条 + 5 新增 + 0 删除 → 拒绝 5，总数仍 44
 *   2. 44 条 + 5 新增 + 3 删除 → 只放 3 条（净增 0），拒 2 条**最弱的**
 *   3. 44 条 + 2 新增 + 3 删除 → 43 条，不触发上限
 *   4. 首版 50 条 → 直接截到 44
 *   5. 旧画像 50 条 → 上限变 50，不强制瘦身；只要不净增就放行
 *   6. 诊断字段 `capRejected` 与 warning 都在（不许静默拒绝）
 *
 * 运行： node test/profile-cap.mjs
 */
import { normalizeProfile } from '../lib/profile.js'

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

const CATEGORIES = ['A', 'B', 'C']

function previousEntry(index) {
  return {
    id: `p${index}`,
    category: CATEGORIES[index % 3],
    claim: `旧结论 ${index}`,
    evidence: ['e'],
    confidence: 'medium',
    evidenceQuoteCount: 2,
    timesSeen: 2,
    firstSeenAt: 1,
    lastSeenAt: 1,
  }
}

function newEntry(index, options = {}) {
  return {
    id: `n${index}`,
    category: 'A',
    claim: `新结论 ${index}`,
    evidence: ['e'],
    confidence: options.confidence ?? 'medium',
  }
}

/**
 * 跑一次 normalizeProfile。
 * @param {object[]|null} previousEntries null = 首版
 * @param {object[]} newEntries
 * @param {number} deleted 从上一版里删掉几条（不出现在 unchangedIds）
 */
function run(previousEntries, newEntries, deleted = 0) {
  const previous = previousEntries
    ? { version: 1, entries: previousEntries }
    : null
  const carried = (previousEntries ?? []).slice(deleted)
  const parsed = {
    entries: newEntries,
    unchangedIds: carried.map(entry => entry.id),
    deletedIds: [],
    notes: '',
  }
  const profile = normalizeProfile(parsed, {
    version: 2,
    evidenceMessages: 10,
    now: 1000,
    previous,
    provider: 'fake',
    model: 'fake',
    raw: JSON.stringify(parsed),
    partial: false,
    entryMarks: [],
  })
  return { profile, parsed }
}

console.log('\nA. 44 条 + 5 新增 + 0 删除 → 全拒，总数不涨')
{
  const previous = Array.from({ length: 44 }, (_, index) => previousEntry(index))
  const added = Array.from({ length: 5 }, (_, index) => newEntry(index))
  const { profile } = run(previous, added)
  check('总数仍为 44', profile.entries.length === 44, `len=${profile.entries.length}`)
  check('5 条全部被拒', profile.capRejected.length === 5, JSON.stringify(profile.capRejected))
  check('旧条目一条没丢', previous.every(entry => profile.entries.some(item => item.id === entry.id)))
  check('warning 里写明上限与拒绝条数',
    profile.warnings.some(text => text.includes('44 条上限') && text.includes('5 条')),
    JSON.stringify(profile.warnings))
}

console.log('\nB. 44 条 + 5 新增 + 3 删除 → 只放 3 条，拒绝最弱的 2 条')
{
  const previous = Array.from({ length: 44 }, (_, index) => previousEntry(index))
  // n0 是高置信（分数最高），n1..n4 是低置信：被拒的应该是低分那两条
  const added = [
    newEntry(0, { confidence: 'high' }),
    newEntry(1, { confidence: 'low' }),
    newEntry(2, { confidence: 'low' }),
    newEntry(3, { confidence: 'low' }),
    newEntry(4, { confidence: 'low' }),
  ]
  const { profile } = run(previous, added, 3)
  check('总数 = 44（净增 0）', profile.entries.length === 44, `len=${profile.entries.length}`)
  check('拒绝了 2 条', profile.capRejected.length === 2, JSON.stringify(profile.capRejected))
  check('高分新条目 n0 留下了', profile.entries.some(entry => entry.id === 'n0'))
  check('被拒的两条都是低分新条目',
    profile.capRejected.every(id => ['n1', 'n2', 'n3', 'n4'].includes(id)),
    JSON.stringify(profile.capRejected))
  check('删掉的 3 条旧条目确实不在了',
    !profile.entries.some(entry => entry.id === 'p0' || entry.id === 'p1' || entry.id === 'p2'))
}

console.log('\nC. 44 条 + 2 新增 + 3 删除 → 43 条，不触发上限')
{
  const previous = Array.from({ length: 44 }, (_, index) => previousEntry(index))
  const added = [newEntry(0), newEntry(1)]
  const { profile } = run(previous, added, 3)
  check('总数 43', profile.entries.length === 43, `len=${profile.entries.length}`)
  check('没有拒绝任何条目', profile.capRejected.length === 0, JSON.stringify(profile.capRejected))
  check('两条新增都进来了',
    profile.entries.some(entry => entry.id === 'n0') && profile.entries.some(entry => entry.id === 'n1'))
}

console.log('\nD. 首版 50 条 → 截到 44')
{
  const added = Array.from({ length: 50 }, (_, index) => newEntry(index))
  const { profile } = run(null, added)
  check('总数 44', profile.entries.length === 44, `len=${profile.entries.length}`)
  check('拒绝 6 条', profile.capRejected.length === 6, JSON.stringify(profile.capRejected))
}

console.log('\nE. 旧画像 50 条 → 上限 50，不强制瘦身')
{
  const previous = Array.from({ length: 50 }, (_, index) => previousEntry(index))
  const added = [newEntry(0), newEntry(1)]
  const { profile } = run(previous, added)
  check('总数仍是 50（不瘦身）', profile.entries.length === 50, `len=${profile.entries.length}`)
  check('净增被拒（2 条）', profile.capRejected.length === 2, JSON.stringify(profile.capRejected))

  const { profile: withDeletes } = run(previous, added, 2)
  check('删 2 加 2 → 总数 50，全部放行', withDeletes.entries.length === 50 && withDeletes.capRejected.length === 0,
    `len=${withDeletes.entries.length} rejected=${withDeletes.capRejected.length}`)
}

console.log('\nF. 改写沿用旧 id 不受上限影响')
{
  const previous = Array.from({ length: 44 }, (_, index) => previousEntry(index))
  // 把 p0 改写（同 id、新正文），同时加 1 条新的：净增 1 → 新条目被拒，改写保留
  const rewritten = { ...previous[0], claim: '改写后的结论 0' }
  const { profile } = run(previous, [rewritten, newEntry(0)])
  check('改写条目仍在（同 id）', profile.entries.some(entry => entry.id === 'p0' && entry.claim === '改写后的结论 0'))
  check('新条目被拒', profile.capRejected.length === 1 && profile.capRejected[0] === 'n0',
    JSON.stringify(profile.capRejected))
  check('总数仍为 44', profile.entries.length === 44, `len=${profile.entries.length}`)
}

console.log('\n========================================================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('========================================================================')
if (fail > 0) process.exitCode = 1
