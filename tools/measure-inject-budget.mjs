/**
 * 实测对比：用**用户当前真实画像**（$DSH_HOME/prompt-adapt/state.json）跑注入裁剪，
 * 分别用旧参数（600 / B 全量）与新参数（1500 / B≤50% / A≥30%）算出各分类条数与估算量。
 *
 * 这是一次性测量工具（不改状态、不落盘），用于交付时的对比表。
 * 运行：node tools/measure-inject-budget.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { planProfileInjection, estimateTokens, profileEntryScore } from '../lib/profile.js'

const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const statePath = join(home, 'prompt-adapt', 'state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const profile = state.profile

const byCategory = {}
for (const entry of profile?.entries ?? []) {
  byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1
}

console.log('=== 数据来源 ===')
console.log(`文件：${statePath}`)
console.log(`画像版本：v${profile?.version}    条目总数：${profile?.entries?.length}`)
console.log(`分类分布：${JSON.stringify(byCategory)}`)

/** 报告一个 plan 的关键数字。 */
function report(label, plan) {
  console.log(`\n--- ${label} ---`)
  console.log(`  注入条数        ${plan.injectedEntries}/${plan.totalEntries}`)
  console.log(`  injectedByCategory ${JSON.stringify(plan.injectedByCategory)}`)
  console.log(`  omittedByCategory  ${JSON.stringify(plan.omittedByCategory)}`)
  console.log(`  estimatedTokens ${plan.estimatedTokens}   accountedTokens ${plan.accountedTokens}`)
  console.log(`  budgetTokens    ${plan.budgetTokens}   overBudget ${plan.overBudget}`)
  console.log(`  text 字符数     ${plan.text.length}`)
  console.log(`  annotation      ${plan.annotation || '(无)'}`)
}

/**
 * **旧算法**（改造前 `lib/profile.js` 的 `planProfileInjection()`）的忠实复刻，
 * 只用于对比表 —— 现网代码已经不再走这条路。
 *
 * 旧规则：B、C **全量注入、不受预算约束**；A 在"B/C 占完之后剩下的空间"里按
 * 证据强度取前缀；`overBudget` 如实标记"B/C 自己就超了"。
 */
function legacyPlan(profile, budgetTokens) {
  const entries = Array.isArray(profile?.entries) ? profile.entries : []
  const groups = { A: [], B: [], C: [], D: [] }
  const unknown = []
  for (const entry of entries) {
    if (['A', 'B', 'C', 'D'].includes(entry?.category)) groups[entry.category].push(entry)
    else unknown.push(entry)
  }
  const table = { A: '【稳定特质】', B: '【行不通的做法】', C: '【有效的做法】' }
  const lineCost = text => estimateTokens(`${text}\n`)
  const heading = category => table[category]
  const blockCost = category => {
    if (groups[category].length === 0) return 0
    let cost = lineCost(heading(category))
    for (const entry of groups[category]) cost += lineCost(`- ${entry.claim}`)
    return cost
  }

  const headerCost = estimateTokens('以下是这个用户已经确认的协作画像，请在本次会话中遵守：\n\n')
  const bCost = blockCost('B')
  const cCost = blockCost('C')
  const aHeadingCost = groups.A.length > 0 ? lineCost(heading('A')) : 0
  const rankedA = groups.A
    .map((entry, index) => ({ entry, index, score: profileEntryScore(entry) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  let aAllCost = aHeadingCost
  for (const item of rankedA) aAllCost += lineCost(`- ${item.entry.claim}`)

  const fitsAll = headerCost + bCost + cCost + aAllCost <= budgetTokens
  const needsAnnotation = !fitsAll || groups.D.length > 0 || unknown.length > 0
  const bcCount = groups.B.length + groups.C.length
  let accounted = headerCost + bCost + cCost
  let aCost = 0
  const selectedA = []
  for (const item of rankedA) {
    const cost = lineCost(`- ${item.entry.claim}`) + (selectedA.length === 0 ? aHeadingCost : 0)
    if (accounted + cost > budgetTokens) break
    accounted += cost
    aCost += cost
    selectedA.push(item.entry)
  }

  const annotationFor = selected => {
    if (!needsAnnotation) return ''
    const parts = [`本次注入 ${selected.length + bcCount}/${entries.length} 条`]
    if (headerCost + bCost + cCost + aCost > budgetTokens) {
      parts.push(`B、C 为硬约束全量注入，已超出 ${budgetTokens} 的注入预算`)
    }
    const omittedA = groups.A.length - selected.length
    if (omittedA > 0) parts.push(`A 类按证据强度截断，省略 ${omittedA} 条`)
    if (groups.D.length > 0) parts.push(`D 类 ${groups.D.length} 条因证据不足未注入`)
    return `（${parts.join('；')}）`
  }
  let annotation = annotationFor(selectedA)
  while (annotation) {
    if (accounted + estimateTokens(`${annotation}\n\n`) <= budgetTokens) break
    if (selectedA.length === 0) break
    const removed = selectedA.pop()
    const removedCost = lineCost(`- ${removed.claim}`) + (selectedA.length === 0 ? aHeadingCost : 0)
    accounted -= removedCost
    aCost -= removedCost
    annotation = annotationFor(selectedA)
  }

  const lines = ['以下是这个用户已经确认的协作画像，请在本次会话中遵守：', '']
  if (annotation) lines.push(annotation, '')
  const rendered = { A: selectedA, B: groups.B, C: groups.C }
  for (const category of ['A', 'B', 'C']) {
    if (rendered[category].length === 0) continue
    lines.push(heading(category))
    for (const entry of rendered[category]) lines.push(`- ${entry.claim}`)
    lines.push('')
  }
  const text = lines.join('\n').trimEnd()
  const injected = selectedA.length + bcCount
  return {
    text,
    annotation,
    budgetTokens,
    totalEntries: entries.length,
    injectedEntries: injected,
    omittedEntries: entries.length - injected,
    injectedByCategory: { A: selectedA.length, B: groups.B.length, C: groups.C.length, D: 0 },
    omittedByCategory: {
      A: groups.A.length - selectedA.length,
      B: 0,
      C: 0,
      D: groups.D.length + unknown.length,
    },
    estimatedTokens: estimateTokens(text),
    accountedTokens: accounted + (annotation ? estimateTokens(`${annotation}\n\n`) : 0),
    overBudget: headerCost + bCost + cCost + aCost > budgetTokens,
  }
}

console.log('\n=== 注入裁剪实测 ===')
report('旧参数：budgetTokens=600（旧算法：B/C 全量、A 用剩下的）', legacyPlan(profile, 600))
report('新参数：budgetTokens=1500（A≥450 保底、B/C≤750 上限、弹性 300）', planProfileInjection(profile, { budgetTokens: 1500 }))
report('默认（不传 budgetTokens，应等于 DEFAULT_INJECT_BUDGET_TOKENS）', planProfileInjection(profile))

// ---------------------------------------------------------------------------
// 需求点名的 v26 快照（66 条）：用 profile-history 里的那一版重跑同两张表。
// state.json 会随着用户继续用而自增（本次改造期间就从 v26 长到了 v28），
// 所以"点名的那一版"必须从历史快照里取，不能用当前 state.json 冒充。
// ---------------------------------------------------------------------------
const historyPath = join(home, 'prompt-adapt', 'profile-history')
let snapshots = []
try {
  snapshots = readdirSync(historyPath).filter(name => /^v\d+-.*\.json$/.test(name))
} catch {
  snapshots = []
}
if (snapshots.length === 0) {
  console.log('\n（没有 profile-history 快照，跳过历史版本对比）')
} else {
  console.log(`\n\n${'#'.repeat(72)}`)
  console.log(`# 历史快照对比（profile-history/，共 ${snapshots.length} 版）`)
  console.log('#'.repeat(72))
  const rows = []
  for (const name of snapshots) {
    const version = Number(/^v(\d+)-/.exec(name)[1])
    // ⚠️ 快照的形状是 `{ profile, diff }`，不是 state.json 那样把画像摊在顶层。
    const raw = JSON.parse(readFileSync(join(historyPath, name), 'utf8'))
    const snapshot = raw.profile ?? raw
    const oldPlan = legacyPlan(snapshot, 600)
    const newPlan = planProfileInjection(snapshot, { budgetTokens: 1500 })
    const counts = {}
    for (const entry of snapshot.entries ?? []) counts[entry.category] = (counts[entry.category] ?? 0) + 1
    rows.push({ version, declared: snapshot.version, name, total: (snapshot.entries ?? []).length, counts, oldPlan, newPlan })
  }
  rows.sort((left, right) => left.version - right.version)
  const named = rows.find(row => row.version === 26)
  for (const row of rows) {
    const mark = row.version === 26 ? '  ← 需求点名的那一版' : ''
    console.log(
      `v${String(row.version).padStart(2)}  ${String(row.total).padStart(3)} 条 ` +
      `[A${row.counts.A ?? 0} B${row.counts.B ?? 0} C${row.counts.C ?? 0} D${row.counts.D ?? 0}]  ` +
      `旧：注入 ${String(row.oldPlan.injectedEntries).padStart(3)} ` +
      `[A${row.oldPlan.injectedByCategory.A} B${row.oldPlan.injectedByCategory.B}]  ` +
      `新：注入 ${String(row.newPlan.injectedEntries).padStart(3)} ` +
      `[A${row.newPlan.injectedByCategory.A} B${row.newPlan.injectedByCategory.B}]  ` +
      `新估算 ${row.newPlan.estimatedTokens}${mark}`,
    )
  }
  if (named) {
    console.log(`\n--- v26 快照（需求点名：66 条）详细 ---`)
    report('v26 / 旧参数 600（旧算法）', named.oldPlan)
    report('v26 / 新参数 1500（新算法）', named.newPlan)
    console.log(`\n  v26 分类分布：${JSON.stringify(named.counts)}`)
  }
}

// A 类证据强度分布：说明"新参数下进去的是最强的那批，不是随便塞"。
const aEntries = (profile?.entries ?? []).filter(entry => entry.category === 'A')
const ranked = aEntries.map(entry => ({ entry, score: profileEntryScore(entry) }))
  .sort((a, b) => b.score - a.score)
console.log('\n=== A 类证据强度分布（降序，用于核对"进来的是最强的那批"）===')
console.log(`  A 类共 ${aEntries.length} 条；分数区间 ${ranked[ranked.length - 1]?.score} ~ ${ranked[0]?.score}`)
for (const [index, item] of ranked.entries()) {
  console.log(`  #${String(index + 1).padStart(2)}  score=${String(item.score).padStart(3)}  ${item.entry.claim.slice(0, 46)}`)
}

// 文本本身也确认一遍：估算口径下新文本确实更长，但没有超过 1500。
const newPlan = planProfileInjection(profile, { budgetTokens: 1500 })
console.log('\n=== 新参数注入文本的全文（核对 A 类真的进去了）===')
console.log(newPlan.text)
console.log(`\n（文本估算 ${estimateTokens(newPlan.text)}，预算 ${newPlan.budgetTokens}）`)

// ---------------------------------------------------------------------------
// 端到端形状：界面拿到的就是下面这一份（与 index.js 的 summarizeInjection()
// 逐字段同形）。字段名一个字都不许含 `token` —— httptest / loadtest 会拿
// /(apiKey|api_key|token|secret|password)/i 扫整个 /state 负载与落盘文件。
// ---------------------------------------------------------------------------
const injection = {
  budgetChars: newPlan.budgetTokens,
  totalEntries: newPlan.totalEntries,
  injectedEntries: newPlan.injectedEntries,
  omittedEntries: newPlan.omittedEntries,
  injectedByCategory: newPlan.injectedByCategory,
  omittedByCategory: newPlan.omittedByCategory,
  estimatedChars: newPlan.estimatedTokens,
  overBudget: newPlan.overBudget,
  annotation: newPlan.annotation,
}
const payload = JSON.stringify(injection)
console.log('\n=== GET /state 的 injection 负载（界面就是吃这一份）===')
console.log(JSON.stringify(injection, null, 2))
console.log(`\n负载里含 "token" 子串？        ${/token/i.test(payload) ? '是（不合格）' : '否（合格）'}`)
console.log(`负载里含凭据类英文词？        ${/(apiKey|api_key|secret|password)/i.test(payload) ? '是（不合格）' : '否（合格）'}`)
console.log(`injectedByCategory 都是 number？ ${
  ['A', 'B', 'C'].every(key => typeof injection.injectedByCategory[key] === 'number')}`)
console.log(`界面文案参数：A ${injection.injectedByCategory.A} 条 · B ${injection.injectedByCategory.B} 条 · C ${injection.injectedByCategory.C} 条`)
