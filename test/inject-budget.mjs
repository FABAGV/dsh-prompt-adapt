/**
 * 注入预算分配的极端场景回归测试（`lib/profile.js` 的 `planProfileInjection()`）。
 *
 * 背景：改造前 B/C **全量注入、不受预算约束**，实测用户真实画像里 B 有 27 条
 * 就把 600 的预算吃光，A 类 38 条一条都进不去
 * （`injectedByCategory: { A: 0, B: 27, ... }`、`overBudget: true`）。
 * 结果注入给模型的只有禁止项，没有任何关于用户的正面描述。
 *
 * 现在的分配（总预算 = `inject.budgetTokens`，默认 1500）：
 *   · A 保底 = 总预算 × 30%（450）—— 不被 B/C 挤死
 *   · B、C **合计**上限 = 总预算 × 50%（750）—— 两类共用一个池子，
 *     超出按 `profileEntryScore()` 全局降序截断（不是"每类各自 750"）
 *   · 剩下 20% 是弹性，谁需要谁用
 *
 * 这里钉的是几种必须确定的行为 + 几条不许破坏的不变量：
 *   1. B 极多 → B 截到上限，**A 仍拿到保底**
 *   2. B 极少 → A 可以用满弹性（最多到上限）
 *   3. 两边都少 → 总量低于预算，**不硬凑**
 *   4. C 类有内容时与 B 同规则（两类共用同一个上限，都按分值降序）
 *   5. 整段文本不许超预算（含开头行与标注行）
 *   6. D 类正文一条都不注入
 *   7. 标注行里不许出现 `token`（`/state` 的防凭据泄漏断言会扫到它）
 *
 * ⚠️ **夹具的条目长度必须接近真实画像**（实测：单条 claim 中位 51 字 ≈ 52
 * 预算单位）。用 10 来个字的短句当夹具会让 60 条 B 只花掉 700 出头，
 * 于是"上限 750"根本碰不到，测试看着过了其实什么都没验证。
 *
 * 运行：node test/inject-budget.mjs
 */
import { planProfileInjection, estimateTokens, profileEntryScore, rankCategoryA } from '../lib/profile.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const BUDGET = 1500
const A_RESERVE = 450
const BC_CAP = 750
const HEADING = { A: '【稳定特质】', B: '【行不通的做法】', C: '【有效的做法】' }
const lineCost = text => estimateTokens(`${text}\n`)

/** 与真实画像同量级的 claim 正文（约 50 个宽字符）。 */
const CLAIM_BODY = (category, id) =>
  `${category}${id}：这个用户在类似场景下的一贯做法，用来把条目正文撑到与真实画像相同的量级，好让预算真的被吃紧。`

/** 造一条条目。分值与 `quotes` / `timesSeen` 一起变化，便于核对截断线。 */
function entry(category, id, options = {}) {
  const quotes = options.quotes ?? 1
  const timesSeen = options.timesSeen ?? 1
  return {
    id,
    category,
    claim: options.claim ?? CLAIM_BODY(category, id),
    evidence: [],
    confidence: options.confidence ?? 'medium',
    evidenceQuoteCount: quotes,
    timesSeen,
  }
}

/** 造 count 条同分类条目：分值随 index 严格递增（越靠后越强）。 */
function batch(category, count, options = {}) {
  const list = []
  for (let index = 0; index < count; index += 1) {
    const step = index % 9
    list.push(entry(category, String(index).padStart(3, '0'), {
      quotes: step + 1,
      timesSeen: step + 1,
      confidence: options.confidence,
      claim: options.claim,
    }))
  }
  return list
}

/** 某个分类实际渲染出来的开销（含分类标题），与实现同一口径。 */
function groupCost(entries, category) {
  const group = entries.filter(item => item.category === category)
  if (group.length === 0) return 0
  return group.reduce((sum, item) => sum + lineCost(`- ${item.claim}`), lineCost(HEADING[category]))
}

/** 与实现同一套排序：分值降序，同分按原始次序。 */
function ranked(entries) {
  return entries
    .map((item, index) => ({ item, index, score: profileEntryScore(item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
}

/**
 * 某分类**实际入选**那批条目的渲染开销（含分类标题）。
 * 入选的是分值最高的那批，不是数组前 N 条 —— 所以先按分值排序再取前 N。
 */
function sumCost(all, taken, category) {
  if (taken <= 0) return 0
  return groupCost(ranked(all).slice(0, taken).map(item => item.item), category)
}

/**
 * 核对某分类的取舍确实是"严格前缀"：入选条目的分值**全部不低于**未入选条目。
 *
 * 不直接拿"按 id 排序的前 N 条"去比 —— 那要求夹具的分值恰好随 id 单调，
 * 一旦夹具改了，断言就会因为夹具而不是实现而红。这里只核对实现必须满足的
 * 性质（排序真的决定了谁进谁不进），与夹具的分值分布无关。
 */
function prefixByScore(all, taken) {
  const scored = ranked(all)
  const kept = scored.slice(0, taken)
  const left = scored.slice(taken)
  const minTaken = kept.length > 0 ? Math.min(...kept.map(item => item.score)) : Infinity
  const maxLeft = left.length > 0 ? Math.max(...left.map(item => item.score)) : -Infinity
  return { ok: minTaken >= maxLeft, minTaken, maxLeft, kept: kept.length, left: left.length }
}

console.log(`（夹具单条 claim 开销：${lineCost(`- ${CLAIM_BODY('A', '000')}`)}，与真实画像中位 52 同量级）`)

console.log('')
console.log('='.repeat(72))
console.log('1. B 极多（60 条）→ B 被截到上限，A 仍拿到保底')
console.log('='.repeat(72))
{
  const aEntries = batch('A', 30)
  const bEntries = batch('B', 60)
  const profile = { version: 1, entries: [...aEntries, ...bEntries] }
  const plan = planProfileInjection(profile, { budgetTokens: BUDGET })

  check('B 有条目被省略（60 条不可能全进）',
    plan.injectedByCategory.B < 60, `B 注入 ${plan.injectedByCategory.B}/60 条`)
  check('B 的渲染开销 ≤ 上限 750',
    sumCost(bEntries, plan.injectedByCategory.B, 'B') <= BC_CAP,
    `B 开销 ${sumCost(bEntries, plan.injectedByCategory.B, 'B')} ≤ ${BC_CAP}`)
  check('B 是**按证据强度降序**截断的（进来的分值都不低于没进来的）',
    prefixByScore(bEntries, plan.injectedByCategory.B).ok,
    JSON.stringify(prefixByScore(bEntries, plan.injectedByCategory.B)))

  const aCost = sumCost(aEntries, plan.injectedByCategory.A, 'A')
  check('★ A 没被 B 挤死：A 注入条数 > 0', plan.injectedByCategory.A > 0,
    `A 注入 ${plan.injectedByCategory.A} 条`)
  check('★ A 拿到的渲染开销达到保底量级（≥ 450 − 单条最大开销）',
    aCost >= A_RESERVE - lineCost(`- ${CLAIM_BODY('A', '000')}`),
    `A 开销 ${aCost}，保底 ${A_RESERVE}`)
  check('A 也是按证据强度降序取的（与 B 同一个分值函数）',
    prefixByScore(aEntries, plan.injectedByCategory.A).ok,
    JSON.stringify(prefixByScore(aEntries, plan.injectedByCategory.A)))
  check('整段文本不超预算（含开头行与标注行）',
    estimateTokens(plan.text) <= BUDGET, `估算 ${estimateTokens(plan.text)} / ${BUDGET}`)
  check('守恒：注入 + 省略 = 总数',
    plan.injectedEntries + plan.omittedEntries === profile.entries.length,
    `${plan.injectedEntries} + ${plan.omittedEntries} = ${profile.entries.length}`)
}

console.log('')
console.log('='.repeat(72))
console.log('2. B 极少（1 条）→ A 可以用满弹性（最多到上限 750）')
console.log('='.repeat(72))
{
  const aEntries = batch('A', 40)
  const bEntries = batch('B', 1)
  const profile = { version: 1, entries: [...aEntries, ...bEntries] }
  const plan = planProfileInjection(profile, { budgetTokens: BUDGET })
  const aCost = sumCost(aEntries, plan.injectedByCategory.A, 'A')
  const singleCost = lineCost(`- ${aEntries[0].claim}`)

  check('B 只有 1 条 → 它全部进注入，不截断',
    plan.injectedByCategory.B === 1 && plan.omittedByCategory.B === 0,
    `B 注入 ${plan.injectedByCategory.B} / 省略 ${plan.omittedByCategory.B}`)
  check('★ A 用到了保底之外的空间（开销明显超过 450）',
    aCost > A_RESERVE, `A 开销 ${aCost} > 保底 ${A_RESERVE}`)
  check('★ A 的上限是 750 —— 不允许超过',
    aCost <= BC_CAP, `A 开销 ${aCost} ≤ 上限 ${BC_CAP}`)
  check('A 拿到的比"只有保底"时至少多一条（弹性真的给了 A）',
    aCost >= A_RESERVE + singleCost,
    `A 开销 ${aCost} ≥ 保底 ${A_RESERVE} + 单条 ${singleCost}`)
  check('A 的上限真的生效了（不是"全量塞进去"）',
    plan.injectedByCategory.A < 40, `A 注入 ${plan.injectedByCategory.A}/40 条`)
  check('整段文本不超预算', estimateTokens(plan.text) <= BUDGET,
    `估算 ${estimateTokens(plan.text)} / ${BUDGET}`)
}

console.log('')
console.log('='.repeat(72))
console.log('3. A 少、B 也少 → 总量低于预算，不硬凑')
console.log('='.repeat(72))
{
  const profile = { version: 1, entries: [...batch('A', 2), ...batch('B', 2)] }
  const plan = planProfileInjection(profile, { budgetTokens: BUDGET })

  check('四条全部注入', plan.injectedEntries === 4, `注入 ${plan.injectedEntries}`)
  check('没有任何条目被省略', plan.omittedEntries === 0, `省略 ${plan.omittedEntries}`)
  check('★ 估算量明显低于预算 —— 没有为了"填满"而硬凑',
    estimateTokens(plan.text) < BUDGET / 2, `估算 ${estimateTokens(plan.text)} / ${BUDGET}`)
  check('★ 没有条目被省略时不产生标注行（零开销，与改造前一致）',
    plan.annotation === '', JSON.stringify(plan.annotation))
  check('各分类条数如实报出',
    JSON.stringify(plan.injectedByCategory) === JSON.stringify({ A: 2, B: 2, C: 0, D: 0 }),
    JSON.stringify(plan.injectedByCategory))
  check('没有省略 ⇒ `truncated` 为 false',
    plan.truncated === false, String(plan.truncated))
}

console.log('')
console.log('='.repeat(72))
console.log('4. C 类有内容时与 B 同规则（共用同一个上限、同样按分值降序）')
console.log('='.repeat(72))
{
  // 4a：C 少、B 少 → C 不被当成特例（既不全量无视预算，也不被无理由丢弃）
  const small = { version: 1, entries: [...batch('A', 2), ...batch('B', 1), ...batch('C', 3)] }
  const smallPlan = planProfileInjection(small, { budgetTokens: BUDGET })
  check('C 少时全部注入（没有"C 类特例"被丢掉）',
    smallPlan.injectedByCategory.C === 3 && smallPlan.omittedByCategory.C === 0,
    JSON.stringify(smallPlan.injectedByCategory))

  // 4b：C 极多 → 与 B 一样被上限截断，并按分值降序
  const cEntries = batch('C', 60)
  const bigC = { version: 1, entries: [...batch('A', 30), ...cEntries] }
  const bigPlan = planProfileInjection(bigC, { budgetTokens: BUDGET })
  check('★ C 极多时被截断（不再"全量注入、不受预算约束"）',
    bigPlan.injectedByCategory.C > 0 && bigPlan.injectedByCategory.C < 60,
    `C 注入 ${bigPlan.injectedByCategory.C}/60 条`)
  check('★ C 的渲染开销 ≤ 上限 750',
    sumCost(cEntries, bigPlan.injectedByCategory.C, 'C') <= BC_CAP,
    `C 开销 ${sumCost(cEntries, bigPlan.injectedByCategory.C, 'C')} ≤ ${BC_CAP}`)
  check('C 也是按证据强度降序截断的（与 A/B 同一个分值函数）',
    prefixByScore(cEntries, bigPlan.injectedByCategory.C).ok,
    JSON.stringify(prefixByScore(cEntries, bigPlan.injectedByCategory.C)))
  check('C 极多时 A 仍然拿到保底', bigPlan.injectedByCategory.A > 0,
    `A ${bigPlan.injectedByCategory.A} 条`)
  check('C 极多时整段仍不超预算', estimateTokens(bigPlan.text) <= BUDGET,
    `估算 ${estimateTokens(bigPlan.text)} / ${BUDGET}`)

  // 4c：B、C 的**合计**上限 750（规格：B+C 累计 ≤ 750，**不是**每类各自 750）。
  //     这正是本次预算改造要防的事：各自 750 时两类都堆满合计 1500 = 全部预算，
  //     A 的 30% 保底形同虚设（实测 `{A:0,B:15,C:13}`）。改成合计之后
  //     "A 拿得到 ≥450"才是真的 —— 这条断言就是那次改造的验收点。
  const aEntriesMix = batch('A', 30)
  const bEntriesMix = batch('B', 40)
  const cEntriesMix = batch('C', 40)
  const mixed = { version: 1, entries: [...aEntriesMix, ...bEntriesMix, ...cEntriesMix] }
  const mixedPlan = planProfileInjection(mixed, { budgetTokens: BUDGET })
  const bCost = sumCost(bEntriesMix, mixedPlan.injectedByCategory.B, 'B')
  const cCost = sumCost(cEntriesMix, mixedPlan.injectedByCategory.C, 'C')
  const aMixCost = sumCost(aEntriesMix, mixedPlan.injectedByCategory.A, 'A')
  check('★ B、C 的渲染开销**合计** ≤ 上限 750（不是各自 750）',
    bCost + cCost <= BC_CAP, `B ${bCost} + C ${cCost} = ${bCost + cCost} ≤ ${BC_CAP}`)
  check('B、C 都进了内容（不是整类被丢）',
    mixedPlan.injectedByCategory.B > 0 && mixedPlan.injectedByCategory.C > 0,
    JSON.stringify(mixedPlan.injectedByCategory))
  check('两类都堆满时整段仍不超预算', estimateTokens(mixedPlan.text) <= BUDGET,
    `估算 ${estimateTokens(mixedPlan.text)} / ${BUDGET}`)
  check('★★ 两类都堆满时 A 仍拿得到保底（≥450）—— 本次改造的核心验收点',
    aMixCost >= A_RESERVE, `A 开销 ${aMixCost} ≥ 保底 ${A_RESERVE}`)
  check('A 超出保底的部分仍按证据强度截断（不是"全量塞进去"）',
    mixedPlan.injectedByCategory.A < 30 && mixedPlan.omittedByCategory.A > 0,
    `A 注入 ${mixedPlan.injectedByCategory.A}/30，省略 ${mixedPlan.omittedByCategory.A}`)
  check('这种情形下标注行仍然说明 A 被截断了（不静默）',
    mixedPlan.annotation.indexOf('A 类按证据强度截断') >= 0, mixedPlan.annotation)
}

console.log('')
console.log('='.repeat(72))
console.log('5. 不变量：D 类不注入 / 标注行不含 token / 标注如实反映新行为')
console.log('='.repeat(72))
{
  const profile = {
    version: 1,
    entries: [...batch('A', 40), ...batch('B', 60), entry('D', 'd1', { claim: '证据不足的一条。' })],
  }
  const plan = planProfileInjection(profile, { budgetTokens: BUDGET })

  check('D 类一条都不注入', plan.injectedByCategory.D === 0, JSON.stringify(plan.injectedByCategory))
  check('D 类条数进标注行', plan.annotation.indexOf('D 类 1 条因证据不足未注入') >= 0, plan.annotation)
  check('★ 标注行不含 `token` 英文词（httptest/loadtest 会扫 /state）',
    !/token/i.test(plan.annotation), plan.annotation)
  check('★ 标注行里也没有 `apiKey`/`secret`/`password`',
    !/(apiKey|api_key|secret|password)/i.test(plan.annotation), plan.annotation)
  check('标注行如实报出"本次注入 N/M 条"',
    plan.annotation.indexOf(`本次注入 ${plan.injectedEntries}/${plan.totalEntries} 条`) >= 0, plan.annotation)
  check('标注行如实报出各分类条数（用户核对 A 不再归零的依据）',
    plan.annotation.indexOf(
      `A 类 ${plan.injectedByCategory.A} 条、B 类 ${plan.injectedByCategory.B} 条、C 类 ${plan.injectedByCategory.C} 条`,
    ) >= 0, plan.annotation)
  check('标注行说明 B/C 已达上限（如实）',
    plan.annotation.indexOf('B、C 类已达上限') >= 0, plan.annotation)
  check('标注行说明 A 按证据强度截断（如实）',
    plan.annotation.indexOf('A 类按证据强度截断') >= 0, plan.annotation)
  check('分类值非法的条目也不注入，且不静默（进标注行）', (() => {
    const weird = planProfileInjection(
      { version: 1, entries: [...batch('A', 1), { id: 'x', category: 'Z', claim: '分类非法' }] },
      { budgetTokens: BUDGET },
    )
    return weird.injectedEntries === 1 && weird.annotation.indexOf('1 条分类无法识别，未注入') >= 0
  })())
}

console.log('')
console.log('='.repeat(72))
console.log('6. 边界：预算 0 / Infinity / 单条超预算 / 空画像')
console.log('='.repeat(72))
{
  const profile = { version: 1, entries: [...batch('A', 5), ...batch('B', 5)] }
  const zero = planProfileInjection(profile, { budgetTokens: 0 })
  check('预算 0 时不崩、不注入正文', zero.injectedEntries === 0 && zero.text.indexOf('- ') < 0,
    `注入 ${zero.injectedEntries}`)
  check('预算 0 时如实标记超预算', zero.overBudget === true, String(zero.overBudget))

  const unlimited = planProfileInjection(profile, { budgetTokens: Infinity })
  check('Infinity = 不限：除 D 类外全量注入',
    unlimited.injectedEntries === 10 && unlimited.truncated === false,
    `注入 ${unlimited.injectedEntries}/${unlimited.totalEntries}`)

  const huge = {
    version: 1,
    entries: [entry('B', 'b1', { claim: '很长的结论。'.repeat(400), confidence: 'high' })],
  }
  const hugePlan = planProfileInjection(huge, { budgetTokens: BUDGET })
  check('单条就超上限时不硬塞（宁可不注入也不超预算）',
    hugePlan.injectedEntries === 0 && estimateTokens(hugePlan.text) <= BUDGET,
    `注入 ${hugePlan.injectedEntries}，估算 ${estimateTokens(hugePlan.text)}`)

  const empty = planProfileInjection({ version: 1, entries: [] }, { budgetTokens: BUDGET })
  check('空画像：零注入、无标注、不崩',
    empty.injectedEntries === 0 && empty.annotation === '' && empty.text === '',
    JSON.stringify(empty.annotation))

  const noProfile = planProfileInjection(null, { budgetTokens: BUDGET })
  check('profile 为 null 时不崩', noProfile.injectedEntries === 0 && noProfile.totalEntries === 0)

  const noOption = planProfileInjection(profile)
  check('不传 budgetTokens 时用默认 1500',
    noOption.budgetTokens === BUDGET, String(noOption.budgetTokens))
}

console.log('')
console.log('='.repeat(72))
console.log('7. 不可破坏的既有不变量：注入侧省略不改画像本身')
console.log('='.repeat(72))
{
  // 用用户**真实画像**跑一遍（存在才跑）：证明注入被裁了，但 entries 一个字段都没动。
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
  let real = null
  try {
    real = JSON.parse(readFileSync(join(home, 'prompt-adapt', 'state.json'), 'utf8')).profile
  } catch {
    real = null
  }
  if (!real || !Array.isArray(real.entries) || real.entries.length === 0) {
    console.log('  （跳过：读不到真实画像，这一节不是必跑项）')
  } else {
    const before = JSON.stringify(real.entries)
    const plan = planProfileInjection(real, { budgetTokens: BUDGET })
    const after = JSON.stringify(real.entries)
    check('真实画像：注入侧确实做了省略', plan.omittedEntries > 0,
      `注入 ${plan.injectedEntries}/${plan.totalEntries}`)
    check('★ `profile.entries` 逐字节未被改动（只在注入侧省略）', before === after)
    check('★ 真实画像里 A 不再归零', plan.injectedByCategory.A > 0,
      `injectedByCategory ${JSON.stringify(plan.injectedByCategory)}`)
    check('★ 真实画像整段不超预算', estimateTokens(plan.text) <= BUDGET,
      `估算 ${estimateTokens(plan.text)} / ${BUDGET}`)
    check('公开口径 `estimatedTokens` 与整段实测一致',
      plan.estimatedTokens === estimateTokens(plan.text),
      `${plan.estimatedTokens} vs ${estimateTokens(plan.text)}`)
    check('`accountedTokens` ≥ `estimatedTokens`（保守量，恒成立）',
      plan.accountedTokens >= plan.estimatedTokens,
      `${plan.accountedTokens} >= ${plan.estimatedTokens}`)
  }
}

console.log('')
console.log(`结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
