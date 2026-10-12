/**
 * 注入计划的**记忆化**（`planProfileInjection()`）与材料预算
 * （`collectHumanMessages()` 的 `maxMaterialChars`）的回归测试。
 *
 * ## 为什么这些断言必须存在
 *
 * 1. **为什么能记忆化**：`renderProfileInjectionText()` 就是
 *    `planProfileInjection(...).text`，而它每个 agent step、每次 `GET /state`
 *    （设置页 3 秒一次、每轮还算两遍）都会被求值一遍。内容没变就不该重算。
 * 2. **为什么 key 必须是内容签名**：`lib/index.js` 的 `markEntry()` 用
 *    `entries.splice()` **原地改** `profile.entries` —— 对象身份不变、内容变了。
 *    用身份当 key 就会把"用户刚封印/刚恢复的那一条"用旧计划渲染出去。
 *    所以 (b) / (c) 三组断言钉的是**不串味**，不是性能。
 * 3. **为什么必须返回同一个对象**：宿主按"字符串恒等"决定要不要追加 system
 *    节点（`dsh-agent-loop/lib/index.js:277-281`），见 `lib/index.js` 的
 *    `sectionCacheKey` 注释。(a) / (d) 钉它。
 * 4. 材料预算（e）是给"发言很多的老用户"的成本刹车：只从**最旧**的丢，
 *    最新一条永不丢，`since` 语义不变，返回形状仍是数组。
 *
 * 运行：node test/plan-cache.mjs
 */
import {
  planProfileInjection,
  renderProfileInjectionText,
  collectHumanMessages,
  estimateTokens,
  profileEntryScore,
  upsertMark,
  DEFAULT_MAX_MATERIAL_CHARS,
  MARK_STATUS,
  PINNED_LINE_PREFIX,
} from '../lib/profile.js'

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

/** 与真实画像同量级的 claim（约 50 个宽字符 ≈ 50 个估算单位）。 */
const CLAIM = id =>
  `${id}：这个用户在类似场景下的一贯做法，用来把条目正文撑到与真实画像相同的量级，好让预算真的被吃紧。`

function entry(id, category, extra = {}) {
  return {
    id,
    category,
    claim: CLAIM(id),
    evidence: ['依据一'],
    confidence: 'medium',
    evidenceQuoteCount: 1,
    timesSeen: 1,
    ...extra,
  }
}

/** 5 条的小画像：A×2（会注入）、B×1、C×1（会注入）、D×1（永不注入）。 */
function smallProfile(version) {
  return {
    version,
    entries: [entry('A1', 'A'), entry('A2', 'A'), entry('B1', 'B'), entry('C1', 'C'), entry('D1', 'D')],
  }
}

/* ====================================================================== *
 * (a) 同样输入连续两次 → 同一个 plan 对象
 * ====================================================================== */
section('a. 同样输入连续两次 → 返回同一个 plan 对象（宿主靠它避免反复追加 system 节点）')
{
  const profile = smallProfile(7)
  const options = { budgetTokens: 1500, entryMarks: [] }
  const first = planProfileInjection(profile, options)
  const second = planProfileInjection(profile, options)
  check('★ 两次调用返回同一个对象（`===`）', first === second)
  check('★ `plan.text` 是同一个字符串实例', first.text === second.text)
  check('字段完全一致（逐字段序列化相等）', JSON.stringify(first) === JSON.stringify(second))
  check('这一份确实有内容可注入（不是空计划蒙对了）',
    first.injectedEntries === 4 && first.totalEntries === 5,
    `注入 ${first.injectedEntries}/${first.totalEntries}`)

  // key 是**内容签名**，不是对象身份：等价副本（对象不同、内容逐字相同）也必须命中。
  const clone = JSON.parse(JSON.stringify(profile))
  const clonePlan = planProfileInjection(clone, { budgetTokens: 1500, entryMarks: [] })
  check('★ 内容相同、对象不同的等价副本 → 照样命中（就不是按对象身份取的）', clonePlan === first)

  // 反向验证"上面真的是缓存命中"：用 10 个不同预算把缓存挤出去（容量 4~8 都挤得动），
  // 再算一次同一签名 —— 这时必须是一个**新对象**，且与首次逐字段完全一致。
  for (let index = 0; index < 10; index += 1) {
    planProfileInjection(profile, { budgetTokens: 1000 + index })
  }
  const cold = planProfileInjection(profile, { budgetTokens: 1500 })
  check('★ 缓存被挤出后重算 → 是新对象（反证上面不是"每次都返回入参"）', cold !== first)
  check('★ 重算结果与首次逐字段完全一致', JSON.stringify(cold) === JSON.stringify(first))
  check('★ 重算文本与首次逐字相同', cold.text === first.text)
}

/* ====================================================================== *
 * (b) 三种"内容变了"的情形都必须未命中（防串味的核心）
 * ====================================================================== */
section('b. 内容变了 → 必须未命中（宁可少命中，不可串味）')
{
  // —— b1：原地改某一条的 claim ——
  const profile = smallProfile(11)
  const base = planProfileInjection(profile, { budgetTokens: 1500, entryMarks: [] })
  const changed = '改过的结论：这一条的正文与刚才完全不同，长度也变了，好让 token 开销跟着一起变。'
  profile.entries[0].claim = changed
  const afterClaim = planProfileInjection(profile, { budgetTokens: 1500, entryMarks: [] })
  check('★ 原地改了一条 claim → 不命中旧缓存', afterClaim !== base)
  check('★ 新文本里是改后的结论', afterClaim.text.includes(changed))
  check('★ 旧文本里的旧结论没有留在新计划里', !afterClaim.text.includes(CLAIM('A1')))

  // —— b2：换 budgetTokens ——
  const budgetProfile = smallProfile(12)
  const wide = planProfileInjection(budgetProfile, { budgetTokens: 1500, entryMarks: [] })
  const narrow = planProfileInjection(budgetProfile, { budgetTokens: 900, entryMarks: [] })
  const tight = planProfileInjection(budgetProfile, { budgetTokens: 120, entryMarks: [] })
  check('★ 换 budgetTokens → 不命中', narrow !== wide)
  check('★ 新计划的 `budgetTokens` 就是新值', narrow.budgetTokens === 900, String(narrow.budgetTokens))
  check('★ 预算真的决定取舍：预算 120 时一条都装不下', tight.injectedEntries === 0,
    `注入 ${tight.injectedEntries}`)
  check('★ 而且这是另一个缓存条目（不是窄预算那份）', tight !== narrow && tight.budgetTokens === 120)

  // —— b3：换一组 entryMarks（置顶；以及同一条 pin→封印）——
  const markProfile = smallProfile(13)
  const noMark = planProfileInjection(markProfile, { budgetTokens: 1500, entryMarks: [] })
  const pinnedMarks = upsertMark([], markProfile.entries[0], MARK_STATUS.PINNED, 1).marks
  const withPin = planProfileInjection(markProfile, { budgetTokens: 1500, entryMarks: pinnedMarks })
  check('★ 换一组 entryMarks（加一条置顶）→ 不命中', withPin !== noMark)
  check('★ 置顶真的生效（文本里带【置顶】前缀）',
    withPin.text.includes(PINNED_LINE_PREFIX + markProfile.entries[0].claim))
  check('★ 置顶条数被如实报出', withPin.pinnedEntries === 1, String(withPin.pinnedEntries))

  // 同一条的**结论文本一个字都没变**，只是状态从 pin 变成封印 —— 签名里必须有状态。
  const sealedMarks = upsertMark(pinnedMarks, markProfile.entries[0], MARK_STATUS.SEALED, 2).marks
  const withSeal = planProfileInjection(markProfile, { budgetTokens: 1500, entryMarks: sealedMarks })
  check('★ 同一条 pin→封印（归一化文本一字未变）→ 不命中', withSeal !== withPin)
  check('★ 封印后那条不再进文本', !withSeal.text.includes(CLAIM('A1')))
  check('归一化文本确实没变（证明上面靠的是 status 而不是文本差异）',
    sealedMarks[0].key === pinnedMarks[0].key)

  // —— b4：JSON 的 NaN/null 坑（两者对排序分的含义不同，签名不许撞）——
  const nanEntry = entry('A1', 'A', { evidenceQuoteCount: NaN, evidence: ['a', 'b', 'c'] })
  const nullEntry = entry('A1', 'A', { evidenceQuoteCount: null, evidence: ['a', 'b', 'c'] })
  check('这两条的分值确实不同（撞签名才是真 bug）',
    profileEntryScore(nanEntry) !== profileEntryScore(nullEntry),
    `${profileEntryScore(nanEntry)} vs ${profileEntryScore(nullEntry)}`)
  const nanPlan = planProfileInjection({ version: 21, entries: [nanEntry] }, { budgetTokens: 1500 })
  const nullPlan = planProfileInjection({ version: 21, entries: [nullEntry] }, { budgetTokens: 1500 })
  check('★ `evidenceQuoteCount: NaN` 与 `null` 不撞签名（`JSON.stringify` 会把两者都写成 null）',
    nanPlan !== nullPlan)
}

/* ====================================================================== *
 * (c) 原地 splice（模拟 lib/index.js 的 markEntry）
 * ====================================================================== */
section('c. 原地 splice 掉一条（模拟 markEntry）→ 必须未命中')
{
  const profile = smallProfile(14)
  const options = { budgetTokens: 1500, entryMarks: [] }
  const before = planProfileInjection(profile, options)
  const totalBefore = before.totalEntries
  const removed = profile.entries.splice(2, 1)[0] // 就是 lib/index.js 的 markEntry() 里那一句
  const after = planProfileInjection(profile, options)
  check('★ 原地 splice 后 → 不命中（对象身份没变、内容变了）', after !== before)
  check('★ `totalEntries` 跟着少一条', after.totalEntries === totalBefore - 1,
    `${after.totalEntries} = ${totalBefore} - 1`)
  check('★ 被摘掉那条的结论不在新文本里', !after.text.includes(removed.claim))
  check('★ 已返回的旧计划对象没有被这次 splice 改写',
    before.totalEntries === totalBefore && before.text.includes(removed.claim))
  // 再把那条**原样放回去**：内容回到原样 → 必须命中最初那一份（缓存按内容键，不按对象身份）
  profile.entries.splice(2, 0, removed)
  const restored = planProfileInjection(profile, options)
  check('★ 内容放回原样后 → 命中最初那份（同一对象、同一文本）', restored === before)
  check('★ 而且文本与最初逐字相同', restored.text === before.text)
}

/* ====================================================================== *
 * (d) 命中缓存时文本逐字相同（两个入口都走同一份缓存）
 * ====================================================================== */
section('d. 命中缓存时 `plan.text` 与首次逐字相同')
{
  const profile = smallProfile(15)
  const options = { budgetTokens: 1500, entryMarks: [] }
  const plan = planProfileInjection(profile, options)
  const viaRenderer = renderProfileInjectionText(profile, options)
  const again = planProfileInjection(profile, options)
  check('★ `renderProfileInjectionText()` 拿到的就是缓存里那份 text（同一实例）',
    viaRenderer === plan.text)
  check('★ 再次 `planProfileInjection()` 仍是同一个对象', again === plan)
  check('★ 文本长度与内容都没漂', again.text.length === plan.text.length && again.text === plan.text,
    `${plan.text.length} 字符`)
  // 逐字复核：把渲染出来的每个分类标题与条目行都在文本里找到（防"文本被换了个版本"）
  check('★ 渲染出来的条目行确实在里面',
    plan.text.includes(`- ${CLAIM('A1')}`) && plan.text.includes(`- ${CLAIM('B1')}`))
}

/* ====================================================================== *
 * (T2) 一次计划内的 token 估算记忆化：数值必须零变化
 * ====================================================================== */
section('T2. 计划内逐条 token 估算记忆化：数值与分段累加不变量零变化')
{
  // 两条条目正文**逐字相同**（分类不同）：按 claim 记忆后，它们仍各自被正确计费。
  const shared = '这一条在两个分类里都出现，正文逐字相同，用来钉住"按 claim 记忆开销"的正确性。'
  const profile = {
    version: 20,
    entries: [
      entry('A1', 'A', { claim: shared }),
      entry('B1', 'B', { claim: shared }),
      entry('D1', 'D'),
    ],
  }
  const plan = planProfileInjection(profile, { budgetTokens: 1500 })
  check('同正文的两条都注入了', plan.injectedEntries === 2, `注入 ${plan.injectedEntries}`)
  check('★ 记忆化后 `estimatedTokens` 与整段实测一致',
    plan.estimatedTokens === estimateTokens(plan.text),
    `${plan.estimatedTokens} vs ${estimateTokens(plan.text)}`)
  check('★ `accountedTokens` ≥ `estimatedTokens`（分段累加仍是保守量）',
    plan.accountedTokens >= plan.estimatedTokens,
    `${plan.accountedTokens} >= ${plan.estimatedTokens}`)

  // 置顶会额外走 pinnedCost()（分类标题 + 条目行 + 前缀行都过同一套记忆）
  const pinnedMarks = upsertMark([], profile.entries[0], MARK_STATUS.PINNED, 1).marks
  const pinnedPlan = planProfileInjection(profile, { budgetTokens: 1500, entryMarks: pinnedMarks })
  check('★ 有置顶时同一条不变量仍成立（pinnedCost 走同一份记忆）',
    pinnedPlan.accountedTokens >= pinnedPlan.estimatedTokens,
    `${pinnedPlan.accountedTokens} >= ${pinnedPlan.estimatedTokens}`)
  check('★ 置顶后 `estimatedTokens` 仍与整段实测一致',
    pinnedPlan.estimatedTokens === estimateTokens(pinnedPlan.text))
}

/* ====================================================================== *
 * (e) 材料预算：collectHumanMessages() 的 maxMaterialChars
 * ====================================================================== */
section('e. 材料预算：从最旧开始丢、最新一条永不丢、stats 自洽、since 不变')
{
  const COUNT = 12
  const texts = Array.from(
    { length: COUNT },
    (_, index) => `第${index + 1}条真人发言：` + '材料内容'.repeat(12),
  )
  function humanEvent(time, text) {
    return {
      type: 'user/message',
      time,
      message: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    }
  }
  const events = texts.map((text, index) => humanEvent(1000 + index, text))
  // 一条**不是真人发言**的事件（source.kind 不是 user）：必须照旧被筛掉，不进 stats.total
  events.push({
    type: 'user/message',
    time: 5000,
    message: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '系统注入' }] },
  })
  const bySession = new Map([['s1', events]])
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0)

  // —— e1：不传 maxMaterialChars（材料远小于默认上限）→ 与现在一致：一条都不丢 ——
  const plain = collectHumanMessages(bySession, { maxMessageChars: 500 })
  check('★ 不传 `maxMaterialChars` 时行为与现在一致（不丢）',
    plain.length === COUNT && plain[0].text === texts[0] &&
      plain[COUNT - 1].text === texts[COUNT - 1],
    `保留 ${plain.length}/${COUNT} 条`)
  check('返回值形状仍是数组（调用方依赖 `messages.length` / `slice(-N)`）', Array.isArray(plain))
  check('不传 `stats` 也不崩', plain.length === COUNT)
  check(`默认上限就是导出的常量（${DEFAULT_MAX_MATERIAL_CHARS}）`,
    DEFAULT_MAX_MATERIAL_CHARS === 80000, String(DEFAULT_MAX_MATERIAL_CHARS))
  check(`本次材料总量 ${totalChars} 字符远小于默认上限（所以"不丢"是真实结论）`,
    totalChars < DEFAULT_MAX_MATERIAL_CHARS)
  check('显式 `Infinity` = 不限，同样不丢',
    collectHumanMessages(bySession, { maxMessageChars: 500, maxMaterialChars: Infinity }).length === COUNT)

  // —— e2：maxMaterialChars 生效 → 从最旧开始丢 ——
  const BUDGET = 200
  const stats = {}
  const capped = collectHumanMessages(bySession, { maxMessageChars: 500, maxMaterialChars: BUDGET, stats })
  check('★ 超预算时确实丢了（这条夹具真的超预算）', capped.length < COUNT && capped.length > 0,
    `保留 ${capped.length}/${COUNT} 条`)
  check('★ 保留的是原序列的**后缀**（丢的永远是最旧的那几条）',
    capped.map(item => item.text).join('|') === texts.slice(COUNT - capped.length).join('|'))
  check('★ 最新一条永不丢', capped[capped.length - 1].text === texts[COUNT - 1])
  check('★ 已经丢到不能再丢（再多留一条就越过预算）',
    (() => {
      const firstKeptIndex = COUNT - capped.length
      if (firstKeptIndex <= 0) return false
      return stats.chars + texts[firstKeptIndex - 1].length > BUDGET
    })(),
    `再多留一条 = ${stats.chars + texts[COUNT - capped.length - 1].length} > ${BUDGET}`)
  check('★ 落进预算（`stats.chars` ≤ 上限）', stats.chars <= BUDGET, `${stats.chars} <= ${BUDGET}`)
  check('★ 编号不重排（保留的是"全局第 N 条"）',
    capped[0].index === COUNT - capped.length + 1, `index ${capped[0].index}`)

  // —— e3：stats 自洽 ——
  check('★ `stats.total` = 筛掉非真人发言后的候选条数', stats.total === COUNT, String(stats.total))
  check('★ `stats.kept + stats.dropped === stats.total`',
    stats.kept + stats.dropped === stats.total,
    `${stats.kept} + ${stats.dropped} = ${stats.total}`)
  check('★ `stats.kept` 与实际返回条数一致', stats.kept === capped.length, String(stats.kept))
  check('★ `stats.chars` = 返回文本的真实字符总数',
    stats.chars === capped.reduce((sum, item) => sum + item.text.length, 0), String(stats.chars))

  // —— e4：预算比单条还小 → 仍然留下最新一条 ——
  const tinyStats = {}
  const tiny = collectHumanMessages(bySession, { maxMessageChars: 500, maxMaterialChars: 10, stats: tinyStats })
  check('★ 预算比单条还小也留下最新一条', tiny.length === 1 && tiny[0].text === texts[COUNT - 1])
  check('★ tiny 的 stats 同样自洽',
    tinyStats.kept === 1 && tinyStats.dropped === COUNT - 1 &&
      tinyStats.kept + tinyStats.dropped === tinyStats.total,
    JSON.stringify(tinyStats))

  // —— e5：since 语义不变 \
  const sinceStats = {}
  const sinceList = collectHumanMessages(bySession, { maxMessageChars: 500, since: 1000 + 4, stats: sinceStats })
  check('★ `since` 仍然生效（时间 <= since 的照旧被跳过）',
    sinceList.length === COUNT - 5 && sinceList[0].text === texts[5],
    `保留 ${sinceList.length} 条`)
  check('★ `since` 先筛、材料预算只作用于筛剩的那批（两道闸门可叠加）',
    sinceStats.total === COUNT - 5 && sinceList[0].text === texts[5])
  check('`since` 路径的编号照旧从 1 起（现状不变）', sinceList[0].index === 1, String(sinceList[0].index))
  check('组合使用时 stats 仍自洽',
    sinceStats.kept + sinceStats.dropped === sinceStats.total && sinceStats.kept === sinceList.length)

  // —— e6：逐条截断（maxMessageChars）不受影响 ——
  const longText = '很长的发言'.repeat(200)
  const longMap = new Map([['s1', [humanEvent(1, longText)]]])
  const truncated = collectHumanMessages(longMap, { maxMessageChars: 50, maxMaterialChars: 80000 })
  check('★ 逐条截断仍在（`maxMessageChars` 先截，材料预算再算总账）',
    truncated.length === 1 && truncated[0].text.endsWith('…[截断]') &&
      truncated[0].text.length === 50 + '…[截断]'.length,
    `${truncated[0].text.length} 字符`)
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))
process.exit(fail === 0 ? 0 : 1)
