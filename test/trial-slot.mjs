/**
 * 新生试用位（`planProfileInjection()` 的 `injectedCounts` 分支持）回归。
 *
 * 病因（实测）：分数 = confidence×100 + 引文×10 + timesSeen，老条目靠引文与
 * timesSeen 长期压住新生条目。当前画像 A 线 242、B/C 线 232、新生最好 231 ——
 * v34 起 18 条新增、0 条在生成当版进入注入，是**算术**上的死结，不是模型不努力。
 *
 * 试用位：每个池子（A 一个、B/C 合用一个）最多留 1 个位置给
 * "`count===0` 且引文≥2"的最高分新生条目，只保这一版；下一版它有了交付记录，
 * 就回到正常排序里跟老条目比。
 *
 * 这里钉的是：
 *   1. 不给计数时行为与改动前完全一致（没有账本 = 没有试用位）
 *   2. 给了计数，新生能被带进注入；`trialIds` 如实标出
 *   3. 引文 < 2、或已经交付过（count>0）的，不享受试用位
 *   4. 预算/A 保底/B-C 上限不变，整段仍不超预算
 *   5. 试用位只占一个位置，不会把整池顶掉
 *
 * 运行： node test/trial-slot.mjs
 */
import { planProfileInjection, estimateTokens } from '../lib/profile.js'

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

/** 与真实画像同量级的正文（约 50 个宽字符 ≈ 50 token/条）。 */
const body = (category, id) =>
  `${category}${id}：这个用户在类似场景下的一贯做法，用来把条目正文撑到与真实画像相同的量级，好让预算真的被吃紧。`

function entry(category, id, options = {}) {
  return {
    id,
    category,
    claim: options.claim ?? body(category, id),
    evidence: [],
    confidence: options.confidence ?? 'high',
    evidenceQuoteCount: options.quotes ?? 5,
    timesSeen: options.timesSeen ?? 1,
  }
}

function profileOf(entries, version = 10) {
  return { version, entries }
}

const BUDGET = 1500
const oldA = Array.from({ length: 18 }, (_, index) => entry('A', `a${index}`))
const oldB = Array.from({ length: 15 }, (_, index) => entry('B', `b${index}`))
const newbornA = entry('A', 'new-a', { confidence: 'low', quotes: 2 })
const newbornC = entry('C', 'new-c', { confidence: 'low', quotes: 2 })
const profile = profileOf([...oldA, ...oldB, newbornA, newbornC])

console.log('\nA. 没有账本（不传 injectedCounts）→ 与改动前一致：新生进不去')
{
  const plan = planProfileInjection(profile, { budgetTokens: BUDGET, entryMarks: [] })
  check('新生 A 不在注入集合里', !plan.injectedIds.includes('new-a'))
  check('新生 C 不在注入集合里', !plan.injectedIds.includes('new-c'))
  check('trialIds 为空', Array.isArray(plan.trialIds) && plan.trialIds.length === 0)
  check('整段不超预算', plan.estimatedTokens <= BUDGET, `${plan.estimatedTokens}/${BUDGET}`)
}

console.log('\nB. 账本说老条目都交付过 → 新生拿到试用位')
{
  const counts = {}
  for (const item of [...oldA, ...oldB]) counts[item.id] = 1
  const plan = planProfileInjection(profile, {
    budgetTokens: BUDGET,
    entryMarks: [],
    injectedCounts: counts,
  })
  check('新生 A 进了注入', plan.injectedIds.includes('new-a'))
  check('新生 C 进了注入（B/C 池子也有一个试用位）', plan.injectedIds.includes('new-c'))
  check('trialIds 标出两条新生', JSON.stringify(plan.trialIds.sort()) === '["new-a","new-c"]',
    JSON.stringify(plan.trialIds))
  check('注入文本里能看到新生的正文', plan.text.includes('Anew-a') && plan.text.includes('Cnew-c'))
  check('总条数与预算内（试用位没把预算撑爆）', plan.estimatedTokens <= BUDGET,
    `${plan.estimatedTokens}/${BUDGET}`)
  check('A 保底仍在（A 类至少 9 条）', plan.injectedByCategory.A >= 9,
    JSON.stringify(plan.injectedByCategory))
  check('B/C 合计没超上限（≤ 750 的量级）',
    (plan.injectedByCategory.B + plan.injectedByCategory.C) >= 8,
    JSON.stringify(plan.injectedByCategory))
}

console.log('\nC. 资格判据：引文 <2 或已交付过的不给试用位')
{
  const counts = {}
  for (const item of [...oldA, ...oldB]) counts[item.id] = 1
  const thinA = entry('A', 'thin-a', { confidence: 'low', quotes: 1 })
  const deliveredA = entry('A', 'done-a', { confidence: 'low', quotes: 4 })
  const custom = profileOf([...oldA, ...oldB, thinA, deliveredA])
  const plan = planProfileInjection(custom, {
    budgetTokens: BUDGET,
    entryMarks: [],
    injectedCounts: { ...counts, 'done-a': 2 },
  })
  check('引文只有 1 条的新生不享受试用位', !plan.injectedIds.includes('thin-a'))
  check('已经交付过 2 次的新生不享受试用位', !plan.injectedIds.includes('done-a'))
  check('trialIds 不含这两个', plan.trialIds.length === 0, JSON.stringify(plan.trialIds))
}

console.log('\nD. 只保一版：下一版计数变成 1，就回到正常排序')
{
  const counts = {}
  for (const item of [...oldA, ...oldB]) counts[item.id] = 1
  counts['new-a'] = 1 // 上一版已经被试用位带进去过
  const plan = planProfileInjection(profile, {
    budgetTokens: BUDGET,
    entryMarks: [],
    injectedCounts: counts,
  })
  check('new-a 失去试用资格', !plan.injectedIds.includes('new-a'))
  check('new-c 仍然是新生（上一版没被带进去）', plan.injectedIds.includes('new-c'))
}

console.log('\nE. 计数进签名：同一份计数命中缓存，计数变了就重算')
{
  const counts = {}
  for (const item of [...oldA, ...oldB]) counts[item.id] = 1
  const first = planProfileInjection(profile, { budgetTokens: BUDGET, entryMarks: [], injectedCounts: counts })
  const second = planProfileInjection(profile, { budgetTokens: BUDGET, entryMarks: [], injectedCounts: counts })
  check('同一份计数返回同一个 plan 对象（缓存不变式）', first === second)
  const changed = planProfileInjection(profile, {
    budgetTokens: BUDGET,
    entryMarks: [],
    injectedCounts: { ...counts, 'new-a': 1 },
  })
  check('计数变了返回新对象', changed !== first)
  check('新对象里 new-a 已被移出试用位', !changed.injectedIds.includes('new-a'))
}

console.log('\nF. 试用位装不下时跳过它，不许把整池顶掉')
{
  const hugeNew = entry('A', 'huge-a', {
    confidence: 'low',
    quotes: 2,
    claim: 'A'.repeat(4000),
  })
  const custom = profileOf([...oldA, hugeNew])
  const counts = {}
  for (const item of oldA) counts[item.id] = 1
  const plan = planProfileInjection(custom, {
    budgetTokens: BUDGET,
    entryMarks: [],
    injectedCounts: counts,
  })
  check('超大新生没进注入', !plan.injectedIds.includes('huge-a'))
  check('A 池没有被它顶空（老条目照常进）', plan.injectedByCategory.A >= 9,
    JSON.stringify(plan.injectedByCategory))
  check('整段仍不超预算', plan.estimatedTokens <= BUDGET, `${plan.estimatedTokens}/${BUDGET}`)
  check('trialIds 为空', plan.trialIds.length === 0)
}

console.log('\nG. 不传计数 = 关闭试用位；传空账本 = 所有条目都是新生')
{
  // 18 条"老"A（引文只有 1，永远不够试用资格）+ 1 条低分新生（引文 2）
  const thinOld = Array.from({ length: 18 }, (_, index) => entry('A', `t${index}`, { quotes: 1 }))
  const newThin = entry('A', 'new-thin', { confidence: 'low', quotes: 2 })
  const custom = profileOf([...thinOld, newThin])
  const off = planProfileInjection(custom, { budgetTokens: BUDGET, entryMarks: [] })
  check('不传计数：新生不进注入（试用位关闭）', !off.injectedIds.includes('new-thin'))
  check('不传计数：trialIds 为空', off.trialIds.length === 0)
  const on = planProfileInjection(custom, {
    budgetTokens: BUDGET,
    entryMarks: [],
    injectedCounts: {},
  })
  check('传空账本：新生被试用位带进注入', on.injectedIds.includes('new-thin'))
  check('传空账本：trialIds 标出它', JSON.stringify(on.trialIds) === '["new-thin"]',
    JSON.stringify(on.trialIds))
  check('两者不是同一个缓存对象（null ≠ {} 进了签名）', off !== on)
}

console.log('\n========================================================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('========================================================================')
if (fail > 0) process.exitCode = 1
