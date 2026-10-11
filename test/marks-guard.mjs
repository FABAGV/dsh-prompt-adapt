/**
 * 条目处置标记（置顶 / 封印 / 删除）的回归测试。
 *
 * 钉住的是用户明确要的三条语义（原话）：
 *   · 封印「直接拉进垃圾桶，之后更新直接跟着进垃圾桶，永远不参与注入」
 *   · 删除「删除就是单纯删除，下一次总结还会出现」+「删除区的可以显示被删了多少次」
 *   · 置顶「pin 是界面置顶加上保证注入」
 *
 * 以及三件容易在改动中悄悄坏掉的事：
 *   1. **跨版本**：清单按**结论文本**绑定（id 会随版本变），重新生成后仍认得出；
 *   2. **两道防线**：提示词（第一道）+ 代码过滤（第二道，落画像与注入各一次）；
 *   3. **状态 schema 演进**：旧 `state.json` 没有 `entryMarks` 字段时照样读得动，
 *      **绝不清空用户画像**；坏形状兜底后不抛。
 *
 * ⚠️ 只在临时 `DSH_HOME` 下跑（真 `http.Server` 用 0 号端口），不碰用户的 `~/.dsh`。
 * 运行：node test/marks-guard.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-adapt-marks-'))
process.env.DSH_HOME = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true })

const { Context } = await import('@deepseek-ai/cordis')
const mod = await import('../lib/index.js')
const { API_PREFIX } = await import('../lib/http.js')
const {
  MARK_STATUS,
  generateProfile,
  markSimilarity,
  markText,
  marksByStatus,
  partitionMarks,
  planProfileInjection,
  upsertMark,
} = await import('../lib/profile.js')

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
function section(title) {
  console.log('')
  console.log('='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

/** 建一个最小 Context 并 apply 插件（与 test/httptest.mjs 同一套做法）。 */
function buildContext() {
  const root = new Context()
  root.provide('systemPrompt', { section: () => () => {} })
  root.provide('timer', { interval: () => () => {} })
  const registered = []
  root.provide('webServer', {
    register(route) {
      registered.push(route)
      return () => {
        const index = registered.indexOf(route)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  })
  mod.default.apply(root, { logLevel: 'error', scan: { scanOnStart: false } })
  return { root, registered }
}

const { root, registered } = buildContext()
const service = root.get('promptAdapt')
const state = service.host.store.state
const stateFile = path.join(tmpRoot, 'prompt-adapt', 'state.json')

/** 造一条画像条目（与宿主 normalizeProfile 的字段一致）。 */
const entry = (id, category, claim) => ({
  id,
  category,
  claim,
  evidence: [`[${id}] 材料`],
  confidence: 'high',
  evidenceQuoteCount: 1,
  lastEvidenceMessages: 120,
  firstSeenAt: 1,
  lastSeenAt: 2,
  timesSeen: 1,
})

/** 把一份画像放进宿主状态（生成路径本身由 selftest / profile-delta-guard 覆盖）。 */
function seed(entries) {
  state.profile = {
    version: 7,
    generatedAt: 111,
    provider: 'p',
    model: 'm',
    evidenceMessages: 120,
    entries: entries.map(item => ({ ...item })),
    notes: '',
    raw: '',
  }
  state.entryMarks = []
  return state.profile
}

const CLAIM_B = '不要在没有确认的情况下动别人的文件'
const CLAIM_C = '先给出最小可验证的一步，再展开'
const CLAIM_A = '用户偏好简短、直达结论的回答，不喜欢铺垫'

section('1. 三个动作在服务层的行为（真实 StateStore，落盘到临时 DSH_HOME）')
{
  const profile = seed([
    entry('A1', 'A', CLAIM_A),
    entry('B1', 'B', CLAIM_B),
    entry('C1', 'C', CLAIM_C),
  ])

  // —— 封印 ——
  const sealed = service.sealEntry('B1', CLAIM_B)
  check('封印返回 ok，并给出比对键', sealed.ok === true && typeof sealed.key === 'string' && sealed.key.length > 0,
    JSON.stringify(sealed))
  check('封印后这条从画像里移除（界面上立刻不在正文里）',
    profile.entries.length === 2 && !profile.entries.some(item => item.id === 'B1'),
    `entries=${profile.entries.map(item => item.id).join(',')}`)
  check('封印写进了标记清单，状态是 sealed',
    state.entryMarks.length === 1 && state.entryMarks[0].status === MARK_STATUS.SEALED,
    JSON.stringify(state.entryMarks.map(mark => [mark.key, mark.status, mark.deleteCount])))
  check('封印记录里存了**原文整条**（恢复时要原样写回）',
    state.entryMarks[0].entry.claim === CLAIM_B && state.entryMarks[0].entry.category === 'B' &&
      Array.isArray(state.entryMarks[0].entry.evidence))
  check('封印已经落盘（state.json 里读得到，原子写由 state-hardening 覆盖）',
    JSON.parse(fs.readFileSync(stateFile, 'utf8')).entryMarks?.length === 1)

  // —— 删除 ——
  const deleted = service.deleteEntry('C1', CLAIM_C)
  check('删除返回 ok，条目从这一版移除', deleted.ok === true && !profile.entries.some(item => item.id === 'C1'))
  check('删除**不禁止**重新归纳：状态是 deleted（不是 sealed），且计数从 1 开始', (() => {
    const mark = state.entryMarks.find(item => item.status === MARK_STATUS.DELETED)
    return mark && mark.deleteCount === 1 && mark.key === markText(CLAIM_C)
  })(), JSON.stringify(state.entryMarks.map(mark => [mark.status, mark.deleteCount])))

  // 同一条再被模型产出、用户再删一次 → 计数 +1
  profile.entries.push(entry('C9', 'C', CLAIM_C))
  service.deleteEntry('C9', CLAIM_C)
  check('同一条被再次删除时计数 +1（界面「已删 N 次」的依据）', (() => {
    const mark = state.entryMarks.find(item => item.status === MARK_STATUS.DELETED)
    return mark && mark.deleteCount === 2
  })(), `deleteCount=${state.entryMarks.find(item => item.status === MARK_STATUS.DELETED)?.deleteCount}`)

  // —— 置顶 ——
  const pinned = service.pinEntry('A1', CLAIM_A)
  check('置顶返回 ok，并且**不**把条目从画像里移除',
    pinned.ok === true && profile.entries.some(item => item.id === 'A1'),
    `entries=${profile.entries.map(item => item.id).join(',')}`)
  check('置顶记录的 deleteCount 是 0（没删过）', (() => {
    const mark = state.entryMarks.find(item => item.status === MARK_STATUS.PINNED)
    return mark && mark.deleteCount === 0
  })())

  // —— 撤销 ——
  const unpinned = service.unpinEntry(state.entryMarks.find(item => item.status === MARK_STATUS.PINNED).key)
  check('取消置顶把标记删掉，条目仍在画像里',
    unpinned.ok === true && !state.entryMarks.some(item => item.status === MARK_STATUS.PINNED) &&
      profile.entries.some(item => item.id === 'A1'))
  const unsealed = service.unsealEntry(state.entryMarks.find(item => item.status === MARK_STATUS.SEALED).key)
  check('从垃圾桶恢复：标记删掉，条目**原样**写回画像（含证据量/时间戳）', (() => {
    const back = profile.entries.find(item => item.id === 'B1')
    return unsealed.ok === true && unsealed.restored === true && back &&
      back.claim === CLAIM_B && back.category === 'B' && back.lastEvidenceMessages === 120 &&
      back.timesSeen === 1 && !state.entryMarks.some(item => item.status === MARK_STATUS.SEALED)
  })(), `entries=${profile.entries.map(item => item.id).join(',')}`)

  // —— 幂等 / 错误路径 ——
  check('撤销一个不存在的标记：如实报错而不是抛异常',
    service.clearMark('这条根本不存在').ok === false)
  check('处置一个画像里找不到的条目：如实报错（界面会显示出来）',
    service.sealEntry('nope', '这条不在画像里').ok === false)
  check('未知状态被拒', service.markEntry({ status: 'banish', id: 'A1' }).ok === false)
}

section('2. pin 的上限（inject.maxPinned，默认 10）：到顶后按钮该被禁用')
{
  seed([])
  const profile = state.profile
  const results = []
  for (let index = 0; index < 11; index += 1) {
    profile.entries.push(entry(`P${index}`, 'A', `被置顶的第 ${index} 条结论，用来验证上限行为。`))
    results.push(service.pinEntry(`P${index}`, `被置顶的第 ${index} 条结论，用来验证上限行为。`))
  }
  const pinnedCount = marksByStatus(state.entryMarks, MARK_STATUS.PINNED).length
  check('前 10 条置顶成功', results.slice(0, 10).every(item => item.ok === true) && pinnedCount === 10,
    `置顶 ${pinnedCount} 条`)
  check('第 11 条被拒，并说明原因（界面把它显示在按钮 title 里）',
    results[10].ok === false && /10/.test(String(results[10].error)), String(results[10].error))
  check('上限由宿主经 getState().maxPinned 告诉界面（界面不写死数字）',
    service.getState().maxPinned === 10, String(service.getState().maxPinned))
}

section('3. 封印跨版本：提示词 + 落画像过滤 + 注入侧兜底（两道防线）')
{
  // —— 第一道防线：提示词里必须出现封印原文，并明确禁止 ——
  const marks = upsertMark([], entry('B1', 'B', CLAIM_B), MARK_STATUS.SEALED, 5).marks
  const chain = await generateProfile({
    llm: {
      async *stream() {
        // 模型**不听话**：把被封印的那条又产出来了（同一段文字）
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            entries: [{ id: 'B1', category: 'B', claim: CLAIM_B, evidence: ['不要改别的'], confidence: 'high' }],
            unchangedIds: ['A1'],
            deletedIds: [],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    provider: 'p', model: 'm',
    previousProfile: { version: 3, entries: [entry('B1', 'B', CLAIM_B), entry('A1', 'A', CLAIM_A)] },
    messages: [{ index: 1, sessionId: 's', time: 1, text: '继续' }],
    signals: {}, totalHumanMessages: 120, totalSessions: 10, maxTokens: 8000, timeoutMs: 1000,
    entryMarks: marks,
  })
  check('提示词把封印清单原文喂给了模型（第一道防线）',
    chain.prompt.includes(CLAIM_B) && chain.prompt.includes('已被用户封印的结论'))
  check('提示词明确禁止再次产出（含"换个说法"）',
    chain.prompt.includes('一条都不许产出') && chain.prompt.includes('换个说法'))
  check('★ 模型又产出了同一条，但落画像时被剔除（不进 entries）',
    !chain.profile.entries.some(item => item.claim === CLAIM_B),
    `entries=${chain.profile.entries.map(item => item.id).join(',')}`)
  check('★ 剔除被如实记进诊断与告警（不静默）',
    (chain.profile.sealedDemoted ?? []).includes('B1') &&
      (chain.profile.warnings ?? []).some(text => text.includes('封印')),
    JSON.stringify(chain.profile.warnings))
  check('其余条目不受影响（A1 照旧）',
    chain.profile.entries.some(item => item.claim === CLAIM_A))

  // —— 第二道防线的注入侧：entries 里**仍然**有它（外部改过 state.json / 旧画像）——
  const dirty = {
    version: 4,
    entries: [entry('B1', 'B', CLAIM_B), entry('A1', 'A', CLAIM_A)],
  }
  const plan = planProfileInjection(dirty, { budgetTokens: 1500, entryMarks: marks })
  check('★ 注入侧兜底：entries 里还留着它也不注入', !plan.text.includes(CLAIM_B), plan.annotation)
  check('★ 注入侧如实报出"已被封印（不注入）"', plan.annotation.includes('已被封印（不注入）'), plan.annotation)
  check('守恒：注入 + 省略 = 画像条目数（被封印的算省略）',
    plan.injectedEntries + plan.omittedEntries === dirty.entries.length,
    `${plan.injectedEntries} + ${plan.omittedEntries} = ${dirty.entries.length}`)
  check('注入文本里没有它的 id', !plan.injectedIds.includes('B1'), JSON.stringify(plan.injectedIds))

  // —— 已知局限：规范化之后仍然不同的改写**认不出来**（宁可漏认，不要错认）——
  const reworded = '不要顺手重构无关代码'
  const sealedShort = upsertMark([], entry('X1', 'B', '不要顺手重构'), MARK_STATUS.SEALED, 6).marks
  const rewordedPlan = planProfileInjection(
    { version: 1, entries: [entry('X2', 'B', reworded)] },
    { budgetTokens: 1500, entryMarks: sealedShort },
  )
  check('⚠️ 已知局限：改写后的同一结论**不会**被拦（判据是规范化后逐字相等）',
    rewordedPlan.text.includes(reworded),
    `相似度 ${markSimilarity(reworded, '不要顺手重构').toFixed(3)} < 1（逐字相等才算命中）`)
  check('⚠️ 所以不能拿相似度当判据：只差一个数字的两条会被 token bag 判成同一条',
    markSimilarity(
      '不要顺手重构无关代码，第0条，说明为什么要这样做以及用户的期望。',
      '不要顺手重构无关代码，第1条，说明为什么要这样做以及用户的期望。',
    ) === 1,
    '相似度 = 1.0（数字被 token 化丢掉）')
}

section('4. 删除 vs 封印：行为差异用测试钉住')
{
  // 同一条结论，两条不同的处置路径，喂同一份"模型又产出了它"的输出
  const previous = { version: 5, entries: [] }
  const modelOutput = JSON.stringify({
    entries: [{ id: 'C1', category: 'C', claim: CLAIM_C, evidence: ['先不修'], confidence: 'high' }],
    unchangedIds: [],
    deletedIds: [],
  })
  const run = entryMarks => generateProfile({
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: modelOutput }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    provider: 'p', model: 'm', previousProfile: previous,
    messages: [{ index: 1, sessionId: 's', time: 1, text: '继续' }],
    signals: {}, totalHumanMessages: 120, totalSessions: 10, maxTokens: 8000, timeoutMs: 1000,
    entryMarks,
  })

  const deletedRun = await run(upsertMark([], entry('C1', 'C', CLAIM_C), MARK_STATUS.DELETED, 7).marks)
  check('★ 删除后**允许**重新出现（这就是用户要的"下一次总结还会出现"）',
    deletedRun.profile.entries.some(item => item.claim === CLAIM_C),
    `entries=${deletedRun.profile.entries.map(item => item.id).join(',')}`)
  check('删除清单的提示词语义是"不禁止重新归纳"',
    deletedRun.prompt.includes('不禁止') && deletedRun.prompt.includes(CLAIM_C))
  check('删除清单带上了删除次数（喂给模型当参考）',
    deletedRun.prompt.includes('删过 1 次'), deletedRun.prompt.slice(deliveredIndex(deletedRun.prompt), deliveredIndex(deletedRun.prompt) + 80))

  const sealedRun = await run(upsertMark([], entry('C1', 'C', CLAIM_C), MARK_STATUS.SEALED, 7).marks)
  check('★ 封印后**不允许**出现（同一条、同一份模型输出）',
    !sealedRun.profile.entries.some(item => item.claim === CLAIM_C))

  // 计数只由"用户按删除"驱动：模型重新产出不算一次删除
  const marksWithDeleted = upsertMark([], entry('C1', 'C', CLAIM_C), MARK_STATUS.DELETED, 7).marks
  check('模型重新产出**不**增加删除次数（计数回答的是"用户删过几次"）',
    marksWithDeleted[0].deleteCount === 1, `deleteCount=${marksWithDeleted[0].deleteCount}`)
}

/** 在提示词里找"删过 N 次"那段的位置（只在失败时用来打印上下文）。 */
function deliveredIndex(prompt) {
  const at = prompt.indexOf('用户删过的结论')
  return at >= 0 ? at : 0
}

section('5. 三种状态互相冲突：后一次动作覆盖前一次（一份清单，一条记录）')
{
  const base = entry('B1', 'B', CLAIM_B)
  const pinned = upsertMark([], base, MARK_STATUS.PINNED, 10).marks
  const thenSealed = upsertMark(pinned, base, MARK_STATUS.SEALED, 11)
  check('先置顶再封印 → 只剩一条记录，状态是 sealed（不残留在置顶区）',
    thenSealed.marks.length === 1 && thenSealed.marks[0].status === MARK_STATUS.SEALED &&
      thenSealed.previousStatus === MARK_STATUS.PINNED,
    JSON.stringify(thenSealed.marks.map(mark => mark.status)))
  check('firstAt 保留最早那次的时间（"这条我第一次动它"没丢）', thenSealed.marks[0].firstAt === 10)

  const deleted = upsertMark([], base, MARK_STATUS.DELETED, 20).marks
  const deletedTwice = upsertMark(deleted, base, MARK_STATUS.DELETED, 21).marks
  const thenPinned = upsertMark(deletedTwice, base, MARK_STATUS.PINNED, 22)
  check('先删两次再置顶 → 状态变 pinned，但删除次数**保留**（不抹掉用户删过的事实）',
    thenPinned.marks[0].status === MARK_STATUS.PINNED && thenPinned.marks[0].deleteCount === 2,
    `status=${thenPinned.marks[0].status} deleteCount=${thenPinned.marks[0].deleteCount}`)
  check('清单里永远只有一条这个键的记录（界面 6 个区块因此天然不重叠）',
    thenPinned.marks.filter(mark => mark.key === markText(CLAIM_B)).length === 1)
  check('封印清单与删除清单由同一个 status 字段区分（不是两份会打架的清单）',
    marksByStatus(thenPinned.marks, MARK_STATUS.SEALED).length === 0 &&
      marksByStatus(thenPinned.marks, MARK_STATUS.DELETED).length === 0 &&
      marksByStatus(thenPinned.marks, MARK_STATUS.PINNED).length === 1,
    JSON.stringify(thenPinned.marks.map(mark => mark.status)))
}

section('6. pin 的注入语义：豁免预算、一定进注入（带【置顶】标记）')
{
  // B 极多把预算吃满 + 一条**分值最低**的 A 条目被置顶 → 它仍必须进注入文本
  const bigB = []
  for (let index = 0; index < 60; index += 1) {
    bigB.push({
      ...entry(`B${index}`, 'B', `不要顺手重构无关代码（第 ${index} 条），这条用来把注入预算吃满，验证置顶是否真的豁免预算。`),
      evidenceQuoteCount: 9,
      timesSeen: 9,
    })
  }
  // 一批高分 A 条目把 A 的份额占满 + 一条**分值最低**的 A 条目 → 不 pin 时它进不去
  const strongA = []
  for (let index = 0; index < 30; index += 1) {
    strongA.push({
      ...entry(`A${index}`, 'A', `这个用户在类似场景下的一贯做法（第 ${index} 条），用来把 A 的份额占满，验证置顶是否真的豁免预算。`),
      evidenceQuoteCount: 5,
      timesSeen: 5,
    })
  }
  const weakA = { ...entry('A9', 'A', '这条按分值应该排在最后，但它被用户置顶了'), evidenceQuoteCount: 0, timesSeen: 0 }
  const profile = { version: 1, entries: [...strongA, weakA, ...bigB] }
  const withoutPin = planProfileInjection(profile, { budgetTokens: 1500 })
  check('不置顶时它挤不进去（分值最低，被 A 的份额截断）', !withoutPin.text.includes(weakA.claim),
    `A 注入 ${withoutPin.injectedByCategory.A}/31 条`)

  const marks = upsertMark([], weakA, MARK_STATUS.PINNED, 30).marks
  const withPin = planProfileInjection(profile, { budgetTokens: 1500, entryMarks: marks })
  check('★ 置顶后它一定进注入文本（豁免预算）', withPin.text.includes(weakA.claim))
  check('★ 并且带上【置顶】标记（模型知道这是用户标的重要条目）',
    withPin.text.includes('【置顶】' + weakA.claim))
  check('置顶条数如实报进标注行', withPin.annotation.includes('1 条用户置顶（豁免预算，已注入）'),
    withPin.annotation)
  check('置顶不挤压 A 的保底（pin 的开销不参与预算算术）',
    withPin.injectedByCategory.A >= withoutPin.injectedByCategory.A,
    `有 pin ${withPin.injectedByCategory.A} ≥ 无 pin ${withoutPin.injectedByCategory.A}`)
  check('accountedTokens 仍 ≥ estimatedTokens（保守量不被 pin 破坏）',
    withPin.accountedTokens >= withPin.estimatedTokens,
    `${withPin.accountedTokens} ≥ ${withPin.estimatedTokens}`)
  check('置顶条目的 id 在 injectedIds 里（界面「未注入」区靠它算差集）',
    withPin.injectedIds.includes('A9'), JSON.stringify(withPin.injectedIds.slice(0, 3)))

  // pin 不豁免"证据不足"：模型删掉它 → 不恢复，但标记仍在（界面显示"已不在画像"）
  const pinnedMarks = upsertMark([], entry('A9', 'A', weakA.claim), MARK_STATUS.PINNED, 31).marks
  const dropped = await generateProfile({
    llm: {
      async *stream() {
        // 材料里只剩下 B 的依据，A9 没了 —— 模型按契约删掉它
        yield { type: 'text-delta', text: JSON.stringify({ entries: [], unchangedIds: [], deletedIds: ['A9'] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    provider: 'p', model: 'm',
    previousProfile: { version: 2, entries: [entry('A9', 'A', weakA.claim)] },
    messages: [{ index: 1, sessionId: 's', time: 1, text: '继续' }],
    signals: {}, totalHumanMessages: 120, totalSessions: 10, maxTokens: 8000, timeoutMs: 1000,
    entryMarks: pinnedMarks,
  })
  check('pin **不豁免**证据不足：材料里没依据时模型仍可删掉它（画像里不再有）',
    dropped.profile.entries.length === 0)
  check('但 pin 标记本身照旧留着（界面如实显示"当前画像里已没有这条"）',
    pinnedMarks.length === 1 && pinnedMarks[0].status === MARK_STATUS.PINNED)
}

section('7. 状态 schema 演进：旧 state.json 没有 entryMarks 也能读')
{
  const legacyDir = path.join(tmpRoot, 'legacy')
  fs.mkdirSync(legacyDir, { recursive: true })
  const legacy = {
    version: 1,
    mode: 'auto',
    customText: '',
    profile: {
      version: 3,
      entries: [entry('A1', 'A', '旧版本留下的画像条目')],
    },
    autoExtraText: '',
    copiedSnapshot: { text: null, at: null, profileVersion: null },
    lastGeneration: { at: null, humanMessages: 0, sessions: 0 },
    lastSignals: null,
    lastRun: { at: null, ok: null, reason: '', error: null, spuriousRate: null, diff: null },
    updatedAt: 0,
  }
  fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify(legacy, null, 2), 'utf8')

  const { StateStore, createLogger } = await import('../lib/state.js')
  const log = createLogger('test', 'error', null)
  const store = new StateStore({ dir: legacyDir, log })
  check('旧文件（没有 entryMarks 字段）读得动，标记清单退化为空数组',
    Array.isArray(store.state.entryMarks) && store.state.entryMarks.length === 0)
  check('★ 旧文件里的画像**一条都不少**（不清空用户数据）',
    store.state.profile?.entries?.length === 1 &&
      store.state.profile.entries[0].claim === '旧版本留下的画像条目')
  store.saveState()
  const saved = JSON.parse(fs.readFileSync(path.join(legacyDir, 'state.json'), 'utf8'))
  check('回写后画像仍在，且多了 entryMarks 字段（下次读就有）',
    saved.profile.entries.length === 1 && Array.isArray(saved.entryMarks))

  // 坏形状：字符串 / 数组里混了 null 与数字
  const brokenDir = path.join(tmpRoot, 'broken')
  fs.mkdirSync(brokenDir, { recursive: true })
  fs.writeFileSync(
    path.join(brokenDir, 'state.json'),
    JSON.stringify({
      mode: 'auto',
      entryMarks: '这不是数组',
      profile: { version: 1, entries: [entry('A1', 'A', '画像要保住')] },
    }),
    'utf8',
  )
  const store2 = new StateStore({ dir: brokenDir, log })
  check('entryMarks 是字符串时兜底成空数组，且不抛', Array.isArray(store2.state.entryMarks) &&
    store2.state.entryMarks.length === 0)
  check('坏字段不影响画像', store2.state.profile.entries.length === 1)

  const mixedDir = path.join(tmpRoot, 'mixed')
  fs.mkdirSync(mixedDir, { recursive: true })
  fs.writeFileSync(
    path.join(mixedDir, 'state.json'),
    JSON.stringify({
      mode: 'auto',
      entryMarks: [null, 7, { key: 'k', status: 'sealed', entry: { claim: '有效记录' } }],
      profile: { version: 1, entries: [] },
    }),
    'utf8',
  )
  const store3 = new StateStore({ dir: mixedDir, log })
  check('清单里混进的 null / 数字被过滤，合法记录照旧保留',
    store3.state.entryMarks.length === 1 && store3.state.entryMarks[0].entry.claim === '有效记录',
    JSON.stringify(store3.state.entryMarks))
}

section('8. 处置标记比画像活得久：clearProfile() 不清标记')
{
  seed([entry('B1', 'B', CLAIM_B)])
  service.sealEntry('B1', CLAIM_B)
  check('清空前标记在', state.entryMarks.length === 1)
  service.clearProfile()
  check('★ 清空画像后标记仍在（否则"永远不参与注入"会在用户点一次清空后失效）',
    state.entryMarks.length === 1 && state.profile === null)
  state.entryMarks = []
  state.profile = null
}

section('9. HTTP 端到端：五条 /entry/* 路由（真 http.Server + fetch）')
{
  const route = registered[0]
  const server = http.createServer((req, res) => {
    const pathname = String(req.url ?? '').split('?')[0]
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
      void route.handler(req, res)
      return
    }
    res.writeHead(404)
    res.end('not matched')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`
  const post = (p, body) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  try {
    seed([entry('A1', 'A', CLAIM_A), entry('B1', 'B', CLAIM_B)])

    const sealed = await post('/entry/seal', { id: 'B1', claim: CLAIM_B })
    const sealedBody = await sealed.json()
    check('POST /entry/seal 回 200 并带上最新状态（省一次往返）',
      sealed.status === 200 && sealedBody.ok === true && sealedBody.state?.entryMarks?.length === 1,
      `status=${sealed.status}`)
    check('封印后的状态里画像已不含这条',
      !sealedBody.state.profile.entries.some(item => item.id === 'B1'))

    const pin = await post('/entry/pin', { id: 'A1', claim: CLAIM_A })
    const pinBody = await pin.json()
    check('POST /entry/pin 回 200，且 present=true（这条现在还在画像里）', (() => {
      const mark = (pinBody.state?.entryMarks ?? []).find(item => item.status === 'pinned')
      return pin.status === 200 && mark && mark.present === true && mark.presentId === 'A1'
    })(), JSON.stringify(pinBody.state?.entryMarks?.map(mark => [mark.status, mark.present, mark.presentId])))

    const stateRes = await fetch(`${base}/state`)
    const stateJson = await stateRes.json()
    check('GET /state 暴露 maxPinned 与 injection.injectedIds（界面算「未注入」的依据）',
      stateJson.maxPinned === 10 && Array.isArray(stateJson.injection?.injectedIds),
      `maxPinned=${stateJson.maxPinned} injectedIds=${stateJson.injection?.injectedIds?.length}`)
    check('GET /state 的 /state 负载仍不含任何凭据字段',
      !/(apiKey|api_key|token|secret|password)/i.test(JSON.stringify(stateJson)))

    const deleted = await post('/entry/delete', { id: 'A1', claim: CLAIM_A })
    const deletedBody = await deleted.json()
    check('POST /entry/delete 回 200 且记账一次', (() => {
      const mark = (deletedBody.state?.entryMarks ?? []).find(item => item.status === 'deleted')
      return deleted.status === 200 && mark && mark.deleteCount === 1
    })(), JSON.stringify(deletedBody.state?.entryMarks?.map(mark => [mark.status, mark.deleteCount])))

    const unsealKey = (deletedBody.state.entryMarks.find(item => item.status === 'sealed') ?? {}).key
    const unseal = await post('/entry/unseal', { key: unsealKey })
    const unsealBody = await unseal.json()
    check('POST /entry/unseal 回 200，条目原样回到画像',
      unseal.status === 200 && unsealBody.state.profile.entries.some(item => item.claim === CLAIM_B),
      `status=${unseal.status} entries=${unsealBody.state?.profile?.entries?.map(item => item.id).join(',')}`)

    const badBody = await post('/entry/pin', { id: 12345 })
    check('id 不是字符串 → 400（不静默当成空串）', badBody.status === 400, `status=${badBody.status}`)
    const noKey = await post('/entry/unpin', {})
    check('unpin 缺 key → 400 并说明要什么', noKey.status === 400 &&
      String((await noKey.json()).error).includes('key'))
    const missing = await post('/entry/seal', { id: 'ghost', claim: '画像里没有这条' })
    check('找不到条目 → 409 且给出可读原因（不是 500）', missing.status === 409 &&
      typeof (await missing.json()).error === 'string', `status=${missing.status}`)

    const root = await (await fetch(`${base}/`)).json()
    check('前缀根自检列出了 /entry/* 五条路由',
      ['/entry/pin', '/entry/unpin', '/entry/seal', '/entry/unseal', '/entry/delete']
        .every(item => root.endpoints.some(text => text.includes(item))),
      `${root.endpoints.length} 个端点`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

section('10. 不变量：注入侧省略不改画像；标记不改画像内容')
{
  seed([entry('A1', 'A', CLAIM_A), entry('B1', 'B', CLAIM_B)])
  const before = JSON.stringify(state.profile.entries)
  const plan = planProfileInjection(state.profile, { budgetTokens: 1500, entryMarks: state.entryMarks })
  check('注入计划不修改 profile.entries（逐字节比较）', before === JSON.stringify(state.profile.entries))
  check('没有标记时注入文本逐字等于历史版本（没有多余的标记行）',
    !plan.text.includes('【置顶】') && plan.injectedEntries === 2, plan.text.slice(0, 60))
  check('partitionMarks 是纯函数：不改入参数组',
    (() => {
      const entries = [entry('A1', 'A', CLAIM_A)]
      const marks = upsertMark([], entries[0], MARK_STATUS.SEALED, 1).marks
      const snapshotEntries = JSON.stringify(entries)
      const snapshotMarks = JSON.stringify(marks)
      partitionMarks(entries, marks, MARK_STATUS.SEALED)
      return snapshotEntries === JSON.stringify(entries) && snapshotMarks === JSON.stringify(marks)
    })())
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))

if (fail === 0) {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 清不掉也无所谓 */
  }
} else {
  console.log(`临时目录留着看现场：${tmpRoot}`)
}
process.exit(fail === 0 ? 0 : 1)
