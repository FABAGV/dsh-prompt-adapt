/**
 * 差量契约 + 截断抢救的删除守卫回归测试（`lib/profile.js`）。
 *
 * 与 `selftest.mjs` 第 7b / 11 节的区别：那边钉的是"正常路径的拼装等价性"与
 * "截断不许整批丢弃"；这里专门钉**删除**这条会丢数据的线：
 *
 *   1. 截断 + 没写出 `unchangedIds` → 上一版条目一条都不许少（fail-open）
 *      —— 包括模型自报 `deletedIds` 的情况：截断时那句自报也不可信
 *   2. 抢救层不许把**写到一半**的条目当成完整条目交出去（否则会伪造
 *      `category: 'D'` / `confidence: 'medium'` / `evidence: []`，
 *      甚至把上一版这条的 evidence 清空、`lastEvidenceMessages` 虚增）
 *   3. `unchangedIds` 写坏了（`[1,2]` / 字符串）→ 不删，并留告警
 *   4. fail-open 不许退化成"永不删"：完整输出下"没被提到 = 删除"照旧生效
 *      （含老契约的"全量新集合"模式，即**根本没有** `unchangedIds` 这个键）
 *   5. `deletedIds` 的告警只报模型真的自相矛盾，不把 fail-open 捞回来的条目算进去
 *
 * 运行：node test/profile-delta-guard.mjs
 */
import { normalizeProfile, diffProfiles, generateProfile } from '../lib/profile.js'

let passed = 0
let failed = 0
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 上一版：3 条，字段齐，便于逐字段核对"没被动过"。 */
const previous = {
  version: 4,
  entries: [
    { id: 'A1', category: 'A', claim: '用中文沟通', evidence: ['讲中文'], confidence: 'high',
      evidenceQuoteCount: 1, lastEvidenceMessages: 100, firstSeenAt: 11, lastSeenAt: 22, timesSeen: 4 },
    { id: 'B1', category: 'B', claim: '不要顺手重构', evidence: ['不要改别的'], confidence: 'high',
      evidenceQuoteCount: 1, lastEvidenceMessages: 100, firstSeenAt: 33, lastSeenAt: 44, timesSeen: 3 },
    { id: 'C1', category: 'C', claim: '先分析再动手有效', evidence: ['先不修'], confidence: 'medium',
      evidenceQuoteCount: 1, lastEvidenceMessages: 90, firstSeenAt: 55, lastSeenAt: 66, timesSeen: 2 },
  ],
}

const ids = profile => profile.entries.map(entry => entry.id).join(',')
const entry = (profile, id) => profile.entries.find(item => item.id === id)

/** 全链路：喂一段"模型的原始输出"，走 generateProfile（含抢救 + 规整）。 */
const run = (text, kind) => generateProfile({
  llm: {
    async *stream() {
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind } }
    },
  },
  provider: 'p', model: 'm', previousProfile: previous,
  messages: [{ index: 1, sessionId: 's', time: 1, text: '继续' }],
  signals: {}, totalHumanMessages: 120, totalSessions: 10, maxTokens: 100, timeoutMs: 1000,
})

/** 只走规整层（自己给 parsed 与上下文）。 */
const normalize = (parsed, extra = {}) => normalizeProfile(parsed, {
  version: 5, evidenceMessages: 120, now: 999, previous, provider: 'p', model: 'm', raw: '', ...extra,
})

console.log('='.repeat(72))
console.log('1. 截断 + 没写出 unchangedIds → 上一版条目一条都不许少')
console.log('='.repeat(72))
{
  // 真实踩到过的形状：模型刚写完 1 条新增条目就撞上 token 上限，未变清单整个没写出来
  const cut = await run(
    '{"entries":[{"id":"n1","category":"C","claim":"先给分析再动手","evidence":["先不修"],"confidence":"high"},'
      + '{"id":"n2","claim":"第二条写到一半就断',
    'max-tokens')
  check('截断那一轮不失败，而是产出可用结果',
    cut.partial === true && cut.profile.rescue?.partial === true,
    `partial=${cut.partial} rescue=${JSON.stringify(cut.profile.rescue)}`)
  check('截断时上一版 3 条一条都不少（fail-open）',
    cut.profile.entries.length === 4 && ['A1', 'B1', 'C1'].every(id => ids(cut.profile).includes(id)),
    `条目 ${ids(cut.profile)}`)
  check('截断时 deletionsHonored 为 false，且 deletedByContract 记下"若不 fail-open 本会删掉的 3 条"',
    cut.profile.deletionsHonored === false &&
      cut.profile.deletedByContract.join(',') === 'A1,B1,C1',
    `deletionsHonored=${cut.profile.deletionsHonored} deletedByContract=${cut.profile.deletedByContract.join(',')}`)
  check('截断时没被提到的条目保留上一版的证据量与出现次数（不是新造的）',
    entry(cut.profile, 'C1').lastEvidenceMessages === 90 &&
      entry(cut.profile, 'C1').timesSeen === 2 &&
      entry(cut.profile, 'C1').firstSeenAt === 55)
  check('抢救出来的新增条目保住了',
    entry(cut.profile, 'n1')?.claim === '先给分析再动手')

  // 模型**自报**了 deletedIds，但输出被截断 —— 自报也不可信，照旧不删
  const selfReported = await run('{"entries":[],"deletedIds":["C1","A1","B1', 'max-tokens')
  check('截断 + 模型自报 deletedIds：依然不执行删除（自报也建立在被截断的输出上）',
    selfReported.profile.entries.length === 3 &&
      selfReported.profile.deletionsHonored === false,
    `条目 ${ids(selfReported.profile)} deletionsHonored=${selfReported.profile.deletionsHonored}`)

  // 切在 entries 数组刚收尾处：后面本该跟 unchangedIds
  const cutAtEntriesEnd = await run(
    '{"entries":[{"id":"n1","category":"A","claim":"新增一条","evidence":["e"],"confidence":"high"}]',
    'max-tokens')
  check('截断在 entries 刚写完处：3 条旧条目 + 1 条新增都在',
    cutAtEntriesEnd.profile.entries.length === 4 &&
      cutAtEntriesEnd.profile.deletionsHonored === false,
    `条目 ${ids(cutAtEntriesEnd.profile)}`)
}

console.log('')
console.log('='.repeat(72))
console.log('2. 抢救层不许交出"写到一半"的条目')
console.log('='.repeat(72))
{
  // 改写 A1，但切点在 claim 字符串之后 —— evidence / confidence 根本没写
  const halfRewrite = await run(
    '{"entries":[{"id":"A1","category":"A","claim":"用中文沟通，且不要中英夹杂"', 'max-tokens')
  const keptA1 = entry(halfRewrite.profile, 'A1')
  check('半截的改写不被收下：A1 仍取上一版整条（证据没被清空）',
    keptA1.evidence.join('|') === '讲中文' && keptA1.evidenceQuoteCount === 1,
    `evidence=${JSON.stringify(keptA1.evidence)} quote=${keptA1.evidenceQuoteCount}`)
  check('半截的改写不虚增证据量 / 出现次数',
    keptA1.lastEvidenceMessages === 100 && keptA1.timesSeen === 4,
    `lastEvidenceMessages=${keptA1.lastEvidenceMessages} timesSeen=${keptA1.timesSeen}`)

  // 新条目只写了 id + claim（category / evidence / confidence 都没写）
  const halfNew = await run('{"entries":[{"id":"n1","claim":"全新结论写到一半"', 'max-tokens')
  check('半截的新条目不被收下（不伪造 category/confidence/evidence）',
    entry(halfNew.profile, 'n1') === undefined &&
      !halfNew.profile.entries.some(item => item.category === 'D' && item.claim === '全新结论写到一半'),
    `条目 ${ids(halfNew.profile)}`)

  // 四个字段都写全了、只差对象收尾的 `}` —— 属于"模型写完了这条"，必须照收
  const fullRewrite = await run(
    '{"entries":[{"id":"A1","category":"A","claim":"用中文沟通，且不要中英夹杂",'
      + '"evidence":["讲中文","别用英文"],"confidence":"high"', 'max-tokens')
  const rewritten = entry(fullRewrite.profile, 'A1')
  check('字段写全的改写照旧生效（抢救不许退化成"什么都不要"）',
    rewritten.claim === '用中文沟通，且不要中英夹杂' &&
      rewritten.evidence.length === 2 &&
      rewritten.lastEvidenceMessages === fullRewrite.profile.evidenceMessages,
    `claim=${rewritten.claim} evidence=${rewritten.evidence.length}` +
      ` lastEvidenceMessages=${rewritten.lastEvidenceMessages}（本轮材料规模=${fullRewrite.profile.evidenceMessages}）`)
}

console.log('')
console.log('='.repeat(72))
console.log('3. unchangedIds 写坏了 → 不删 + 告警')
console.log('='.repeat(72))
{
  const numeric = await run('{"entries":[],"unchangedIds":[1,2],"deletedIds":[],"notes":""}', 'stop')
  check('unchangedIds 写成序号数组（[1,2]）时不执行删除',
    numeric.profile.entries.length === 3 && numeric.profile.deletionsHonored === false,
    `条目 ${ids(numeric.profile)}`)
  check('这种 fail-open 要留下告警（不许静默）',
    (numeric.profile.warnings ?? []).some(w => w.includes('unchangedIds') && w.includes('fail-open')),
    JSON.stringify(numeric.profile.warnings))

  const asString = await run('{"entries":[],"unchangedIds":"A1,B1","deletedIds":[],"notes":""}', 'stop')
  check('unchangedIds 写成字符串时不执行删除 + 告警',
    asString.profile.entries.length === 3 && asString.profile.deletionsHonored === false &&
      (asString.profile.warnings ?? []).length > 0,
    `条目 ${ids(asString.profile)} warnings=${JSON.stringify(asString.profile.warnings)}`)
}

console.log('')
console.log('='.repeat(72))
console.log('4. fail-open 不许退化成"永不删"：完整输出照契约删')
console.log('='.repeat(72))
{
  const explicit = await run(
    '{"entries":[],"unchangedIds":["B1","C1"],"deletedIds":["A1"],"notes":""}', 'stop')
  check('完整输出 + 显式 unchangedIds：A1 被删、B1/C1 原样保留',
    ids(explicit.profile) === 'B1,C1' && explicit.profile.deletionsHonored === true &&
      explicit.diff.removed.join(',') === 'A1',
    `条目 ${ids(explicit.profile)} removed=${explicit.diff.removed.join(',')}`)

  // 老契约的"全量新集合"模式：**没有** unchangedIds 这个键，entries 里提到上一版 id
  const legacyFull = await run(
    '{"entries":[{"id":"A1","category":"A","claim":"用中文沟通","evidence":["讲中文"],"confidence":"high"},'
      + '{"id":"n1","category":"A","claim":"新增一条","evidence":["e"],"confidence":"high"}]}', 'stop')
  check('完整输出 + 没有 unchangedIds 键（全量新集合模式）：没被提到的 B1/C1 照契约删除',
    ids(legacyFull.profile).includes('A1') && ids(legacyFull.profile).includes('n1') &&
      !ids(legacyFull.profile).includes('B1') && !ids(legacyFull.profile).includes('C1') &&
      legacyFull.profile.deletionsHonored === true,
    `条目 ${ids(legacyFull.profile)}`)
  check('全量新集合模式下，逐字照抄的 A1 仍按"未变动"处理（不虚增证据量）',
    entry(legacyFull.profile, 'A1').lastEvidenceMessages === 100 &&
      entry(legacyFull.profile, 'A1').timesSeen === 4)

  // 显式写 `unchangedIds: []` = 模型明说"没有要保留的"（裁定确认的契约语义）
  const wipeAll = await run('{"entries":[],"unchangedIds":[],"deletedIds":[],"notes":""}', 'stop')
  check('显式 unchangedIds:[] 是有效枚举（没有要保留的）→ 按契约全删',
    wipeAll.profile.entries.length === 0 && wipeAll.profile.deletionsHonored === true,
    `条目 【${ids(wipeAll.profile)}】`)
}

console.log('')
console.log('='.repeat(72))
console.log('5. deletedIds 的告警只报模型真的自相矛盾')
console.log('='.repeat(72))
{
  // 截断 + fail-open 把 C1 捞回来：这不是模型自相矛盾，不许报
  const rescued = await run(
    '{"entries":[],"unchangedIds":["A1"],"deletedIds":["C1"],"notes":"截断', 'max-tokens')
  check('截断 + deletedIds 里的条目被 fail-open 捞回：不报"又出现在 entries/unchangedIds 里"',
    entry(rescued.profile, 'C1') !== undefined &&
      !(rescued.profile.warnings ?? []).some(w => w.includes('又出现在 entries/unchangedIds 里')),
    `条目 ${ids(rescued.profile)} warnings=${JSON.stringify(rescued.profile.warnings)}`)

  // 模型真的自相矛盾：A1 同时在 unchangedIds 与 deletedIds 里
  const contradictory = await run(
    '{"entries":[],"unchangedIds":["A1"],"deletedIds":["A1"],"notes":""}', 'stop')
  check('模型真自相矛盾（同一 id 既未变又要删）时，告警照旧触发',
    entry(contradictory.profile, 'A1') !== undefined &&
      (contradictory.profile.warnings ?? []).some(w => w.includes('又出现在 entries/unchangedIds 里')),
    JSON.stringify(contradictory.profile.warnings))
}

console.log('')
console.log('='.repeat(72))
console.log('6. 差量拼装与全量输出逐字段等价（diff 的前提，取一个真实切点复查）')
console.log('='.repeat(72))
{
  const delta = normalize(
    { entries: [{ id: 'A1', category: 'A', claim: '用中文沟通，别英文', evidence: ['讲中文'], confidence: 'high' }],
      unchangedIds: ['B1'], deletedIds: ['C1'] })
  const full = normalize({
    entries: [
      { id: 'A1', category: 'A', claim: '用中文沟通，别英文', evidence: ['讲中文'], confidence: 'high' },
      { id: 'B1', category: 'B', claim: '不要顺手重构', evidence: ['不要改别的'], confidence: 'high' },
    ],
  })
  const sortById = list => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  check('差量拼装 == 全量输出（逐字段、含证据量与时间戳）',
    JSON.stringify(sortById(delta.entries)) === JSON.stringify(sortById(full.entries)),
    `差量 ${ids(delta)} / 全量 ${ids(full)}`)
  check('两种契约下的 diff 完全一致',
    JSON.stringify(diffProfiles(previous, delta)) === JSON.stringify(diffProfiles(previous, full)),
    `差量 ${JSON.stringify(diffProfiles(previous, delta))}`)
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
console.log('='.repeat(72))
process.exit(failed > 0 ? 1 : 0)
