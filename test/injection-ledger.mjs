/**
 * 注入落账（`state.injectionLedger`）的回归。
 *
 * 为什么需要这本账：`planProfileInjection()` 的 `injectedIds` 原来只活在单次返回值里，
 * 用完即丢。于是系统不知道"这一条从生成到现在一次都没进过 system prompt"——
 * 实测本机 108 条里 60 条从未交付，而生成器仍按同一套分数继续加条目。
 * 落账之后，"从未交付 / 反复交付"才可查询，下一阶段的新生试用位才有判据。
 *
 * 这里钉四条不变量：
 *   1. 同一版本重复落账不重复计数（apply 补齐 + 生成后落账会各调一次）
 *   2. 换版本时只给**这一版真的注入了的** id 加一，账上旧 id 不清零
 *   3. 落盘后再读回，`counts` 不丢（`state.json` 是唯一的持久层）
 *   4. 坏账形状（ids 不是数组 / counts 是数组）在载入时被修成空账，不让计数变 NaN
 *
 * 运行： node test/injection-ledger.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyState, StateStore } from '../lib/state.js'
import { planProfileInjection } from '../lib/profile.js'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-injection-ledger-'))

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

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }
const plan = ids => ({ injectedIds: ids })

/** 一条能进注入的短条目（claim 短，预算 1500 下 A/B/C 三条都放得下）。 */
function entry(category, id) {
  return {
    id,
    category,
    claim: `${category}${id}：短结论`,
    evidence: [],
    confidence: 'high',
    evidenceQuoteCount: 3,
    timesSeen: 2,
  }
}

console.log('\nA. 空状态有账本，形状固定')
{
  const state = emptyState()
  check('injectionLedger 存在', !!state.injectionLedger)
  check('形状 {version:null, ids:[], counts:{}, lastAt:null}',
    state.injectionLedger.version === null &&
      Array.isArray(state.injectionLedger.ids) &&
      state.injectionLedger.ids.length === 0 &&
      state.injectionLedger.counts &&
      Object.keys(state.injectionLedger.counts).length === 0 &&
      state.injectionLedger.lastAt === null,
    JSON.stringify(state.injectionLedger))
}

console.log('\nB. 同一版本幂等；换版本累加')
{
  const dir = path.join(TMP_ROOT, 'store-b')
  const store = new StateStore({ dir, log: SILENT })
  check('第一次落账返回 true', store.recordInjection(plan(['a', 'b']), 1) === true)
  check('计数 a=1 b=1', store.state.injectionLedger.counts.a === 1 && store.state.injectionLedger.counts.b === 1,
    JSON.stringify(store.state.injectionLedger.counts))
  check('同一版本重复落账返回 false（不重复计数）', store.recordInjection(plan(['a', 'b']), 1) === false)
  check('重复后计数不变', store.state.injectionLedger.counts.a === 1)

  check('换版本返回 true', store.recordInjection(plan(['b', 'c']), 2) === true)
  check('b 累加到 2', store.state.injectionLedger.counts.b === 2)
  check('c 记为 1', store.state.injectionLedger.counts.c === 1)
  check('这一版没注入的 a 保留旧计数（不清零）', store.state.injectionLedger.counts.a === 1)
  check('ids 记录的是这一版的交付集合', JSON.stringify(store.state.injectionLedger.ids) === '["b","c"]')
  check('version 记的是这一版', store.state.injectionLedger.version === 2)
}

console.log('\nC. 落盘后读回，计数不丢')
{
  const dir = path.join(TMP_ROOT, 'store-c')
  const first = new StateStore({ dir, log: SILENT })
  first.recordInjection(plan(['x', 'y']), 3)
  first.saveState()
  const second = new StateStore({ dir, log: SILENT })
  check('重新载入后 counts.x=1', second.state.injectionLedger.counts.x === 1)
  check('重新载入后 version=3', second.state.injectionLedger.version === 3)
  check('重新载入后 ids 还在', JSON.stringify(second.state.injectionLedger.ids) === '["x","y"]')
}

console.log('\nD. 坏账形状在载入时被修好')
{
  const dir = path.join(TMP_ROOT, 'store-d')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    mode: 'auto',
    profile: null,
    injectionLedger: { version: 9, ids: 'nope', counts: ['a'] },
  }), 'utf8')
  const store = new StateStore({ dir, log: SILENT })
  check('ids 被修成空数组', Array.isArray(store.state.injectionLedger.ids) && store.state.injectionLedger.ids.length === 0)
  check('counts 被修成空对象', store.state.injectionLedger.counts &&
    typeof store.state.injectionLedger.counts === 'object' &&
    !Array.isArray(store.state.injectionLedger.counts))
}

console.log('\nE. 与真实计划对接：注入集合就是账本记的集合')
{
  const dir = path.join(TMP_ROOT, 'store-e')
  const store = new StateStore({ dir, log: SILENT })
  const profile = {
    version: 7,
    entries: [entry('A', 'a1'), entry('B', 'b1'), entry('C', 'c1')],
  }
  const injection = planProfileInjection(profile, { budgetTokens: 1500, entryMarks: [] })
  check('三条短条目都进得了预算', injection.injectedIds.length === 3, JSON.stringify(injection.injectedIds))
  store.recordInjection(injection, profile.version)
  const counts = store.state.injectionLedger.counts
  check('落账的 id 与计划的 injectedIds 逐条一致',
    JSON.stringify(store.state.injectionLedger.ids) === JSON.stringify(injection.injectedIds))
  check('三条各记 1 次', injection.injectedIds.every(id => counts[id] === 1), JSON.stringify(counts))
}

console.log('\nF. 版本身份：clearProfile 后版本号重来，不会丢账')
{
  const dir = path.join(TMP_ROOT, 'store-f')
  const store = new StateStore({ dir, log: SILENT })
  check('旧 v1 记一笔', store.recordInjection(plan(['old']), 1, 'gen-A:1') === true)
  check('同一身份重复 → false', store.recordInjection(plan(['old']), 1, 'gen-A:1') === false)
  // 模拟 clearProfile 后重新生成：version 又是 1，但 generatedAt 不同
  check('同版本号、不同身份 → 真的记一笔', store.recordInjection(plan(['new']), 1, 'gen-B:1') === true)
  check('旧 id 的计数保留', store.state.injectionLedger.counts.old === 1)
  check('新 id 记 1', store.state.injectionLedger.counts.new === 1)
  check('账上 version 仍是 1（展示用）', store.state.injectionLedger.version === 1)
  check('身份更新为 gen-B:1', store.state.injectionLedger.identity === 'gen-B:1')
}

console.log('\nG. 同一版本中途补记：只给新进集合的 id 加一，已记过的不重复')
{
  const dir = path.join(TMP_ROOT, 'store-g')
  const store = new StateStore({ dir, log: SILENT })
  store.recordInjection(plan(['a']), 2, 'gen-C:2')
  check('先记 a：a=1', store.state.injectionLedger.counts.a === 1)
  const frozenBefore = { ...store.state.injectionLedger.frozenCounts }
  check('b 不在冻结快照里', store.state.injectionLedger.frozenCounts.b === undefined)
  check('同一版本补进 b → true', store.recordInjection(plan(['a', 'b']), 2, 'gen-C:2') === true)
  check('a 不重复计数（仍 1）', store.state.injectionLedger.counts.a === 1,
    JSON.stringify(store.state.injectionLedger.counts))
  check('b 记 1', store.state.injectionLedger.counts.b === 1)
  check('冻结快照不变（试用位判据不在中途抖动）',
    JSON.stringify(store.state.injectionLedger.frozenCounts) === JSON.stringify(frozenBefore),
    JSON.stringify(store.state.injectionLedger.frozenCounts))
  check('同一集合再记一次 → false', store.recordInjection(plan(['a', 'b']), 2, 'gen-C:2') === false)
}

console.log('\nH. 旧账没有 frozenCounts：载入时用 counts 补，不是空对象')
{
  const dir = path.join(TMP_ROOT, 'store-h')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    mode: 'auto',
    profile: null,
    injectionLedger: { version: 3, ids: ['a'], counts: { a: 2 }, lastAt: 1 },
  }), 'utf8')
  const store = new StateStore({ dir, log: SILENT })
  check('frozenCounts 被补成 {a:2}', store.state.injectionLedger.frozenCounts.a === 2,
    JSON.stringify(store.state.injectionLedger.frozenCounts))

  const dir2 = path.join(TMP_ROOT, 'store-h2')
  fs.mkdirSync(dir2, { recursive: true })
  fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({
    version: 1,
    mode: 'auto',
    profile: null,
    injectionLedger: { version: 3, ids: ['a'], counts: { a: 2 }, frozenCounts: {}, lastAt: 1 },
  }), 'utf8')
  const store2 = new StateStore({ dir: dir2, log: SILENT })
  check('显式的空 frozenCounts 不被误补（首版就是空的）',
    JSON.stringify(store2.state.injectionLedger.frozenCounts) === '{}',
    JSON.stringify(store2.state.injectionLedger.frozenCounts))
}

console.log('\n========================================================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`临时目录：${TMP_ROOT}`)
console.log('========================================================================')
if (fail > 0) process.exitCode = 1
