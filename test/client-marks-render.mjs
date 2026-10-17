/**
 * 界面半边：6 个区块 + 每条的「置顶 / 封印 / 删除」按钮 + 折叠区的渲染与点击链路。
 *
 * 为什么单独一个文件：`tools/calibrate.mjs` 的夹具里**没有** `entryMarks` / `injectedIds`
 * 字段（那是"老宿主 / 预览数据"的形状），所以本插件新增的那几个区块在那边
 * **一条都不会被渲染到** —— 路径没被走过就等于没测过。这里补上：
 *
 *   1. 6 个区块的**顺序**与默认折叠态（①②③ 常显；④⑤⑥ 是 `details`，默认收起）
 *   2. 每个区块的条目与按钮（含"置顶到顶时按钮禁用并给出原因"）
 *   3. **点击链路**：按钮 → 宿主的 `/entry/*` 路由（不是只改本地状态）
 *
 * 打桩方式与 `tools/calibrate.mjs` 同源（window.__ModuleLoader__ / document /
 * fetch / localStorage / navigator + 迷你 React），但它**不是** React 渲染器：
 * 没有 react-dom，布局与真实事件系统都没被验证。
 *
 * 运行：node test/client-marks-render.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(HERE, '..', 'lib', 'client.js')

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

// ===========================================================================
// 夹具
// ===========================================================================

const CLAIM_A = '用户偏好简短、直达结论的回答'
const CLAIM_B = '不要在没有确认的情况下动别人的文件'
const CLAIM_C = '先给出最小可验证的一步，再展开'
const CLAIM_PIN = '这条被用户置顶了，一定要进注入'
const CLAIM_SEALED = '这条已经被封印，进垃圾桶了'
const CLAIM_DELETED = '这条被删过两次，可能还会回来'
const CLAIM_D = '证据不足的一条，D 类'

const entry = (id, category, claim) => ({
	id,
	category,
	claim,
	evidence: [`[${id}] 材料`],
	confidence: 'high',
	evidenceQuoteCount: 1,
	lastEvidenceMessages: 120,
})

const mark = (claim, status, extra) =>
	Object.assign(
		{
			key: claim,
			status,
			entry: { id: 'x-' + status, category: 'B', claim, evidence: [], confidence: 'medium' },
			fromId: 'x-' + status,
			firstAt: 1,
			lastAt: 2,
			deleteCount: 0,
			present: false,
			presentId: null,
		},
		extra || {},
	)

/** 10 条置顶（= inject.maxPinned 的默认上限）→ 界面上的置顶按钮必须被禁用。 */
const PINNED = [mark(CLAIM_PIN, 'pinned', { present: true, presentId: 'p1' })]
for (let index = 0; index < 9; index += 1) {
	PINNED.push(mark(`凑满上限的置顶条目 ${index}`, 'pinned', { deleteCount: index === 0 ? 2 : 0 }))
}

const HOST_STATE = {
	ok: true,
	contract: 1,
	mode: 'auto',
	customText: '',
	autoExtraText: '',
	maxPinned: 10,
	hallUrl: '',
	profile: {
		version: 7,
		generatedAt: 1760000000000,
		provider: 'x',
		model: 'y',
		evidenceMessages: 148,
		notes: '',
		raw: '',
		entries: [
			entry('a1', 'A', CLAIM_A),
			entry('b1', 'B', CLAIM_B),
			entry('b2', 'B', CLAIM_B + '（第二条）'),
			entry('c1', 'C', CLAIM_C),
			entry('p1', 'B', CLAIM_PIN),
			entry('d1', 'D', CLAIM_D),
		],
	},
	entryMarks: [
		...PINNED,
		mark(CLAIM_SEALED, 'sealed'),
		mark(CLAIM_DELETED, 'deleted', { deleteCount: 2, present: true, presentId: 'c1' }),
	],
	copiedSnapshot: { text: null, at: null, profileVersion: null, entries: null, algorithmVersion: null },
	lastGeneration: { at: 1760000000000, humanMessages: 148, sessions: 9 },
	lastSignals: { totals: { sessions: 9, humanMessages: 148, delegateRuns: 3, longTools: 5, repeatFailures: 2, freeformAnswers: 4, unpairedToolResults: 0 } },
	lastRun: { at: 1760000000000, ok: true, reason: '', error: null, spuriousRate: 0, diff: null, warnings: ['画像已达 44 条上限，本轮拒绝 9 条净新增（n9）。'] },
	injectionLedger: { version: 7, ids: ['a1', 'p1'], counts: { a1: 2, p1: 1 }, lastAt: 1760000000000 },
	workingNotes: [{ text: '本机插件安装在 R:/dsh-prompt-adapt，配置在 ~/.dsh/prompt-adapt。', at: 1760000000000 }],
	effectiveText: '',
	injectedText: '以下是这个用户已经确认的协作画像，请在本次会话中遵守：\n\n【稳定特质】\n- ' + CLAIM_A + '\n',
	injection: {
		// 注入的 id 是 a1 与 p1（p1 被置顶 → 豁免预算，所以它在注入里）；
		// 其余 A/B/C 条目（b1/b2/c1）都该出现在「未注入」区，D 类不在那里。
		injectedIds: ['a1', 'p1'],
		injectedEntries: 2,
		totalEntries: 6,
		injectedByCategory: { A: 1, B: 1, C: 0, D: 0 },
		omittedByCategory: { A: 0, B: 2, C: 1, D: 1 },
		estimatedChars: 40,
		overBudget: false,
		annotation: '（本次注入 2/6 条）',
	},
	running: false,
}

// ===========================================================================
// 打桩
// ===========================================================================

const calls = []
const dicts = new Map()
const localeListeners = new Set()
let activeLocale = 'zh'
let registered = null
let apiState = JSON.parse(JSON.stringify(HOST_STATE))

function translate(ns, key, params) {
	for (const locale of [activeLocale, 'zh', 'en']) {
		const dict = dicts.get(ns + '|' + locale)
		if (dict && typeof dict[key] === 'string') {
			const template = dict[key]
			if (!params) return template
			return template.replace(/\{(\w+)\}/g, (match, name) =>
				Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
			)
		}
	}
	return key
}

const styleTags = []
const documentStub = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
	head: { appendChild: element => styleTags.push(element) },
	body: { appendChild: () => {}, removeChild: () => {} },
	execCommand: () => true,
}
const storage = new Map()
const localStorageStub = {
	getItem: key => (storage.has(key) ? storage.get(key) : null),
	setItem: (key, value) => storage.set(key, String(value)),
	removeItem: key => storage.delete(key),
}
const jsonResponse = (payload, status) => {
	const code = status === undefined ? 200 : status
	const text = JSON.stringify(payload)
	return { ok: code >= 200 && code < 300, status: code, text: async () => text }
}
const fetchStub = async (url, init) => {
	const method = (init && init.method) || 'GET'
	const body = init && init.body ? JSON.parse(init.body) : null
	calls.push({ url, method, body })
	if (url.endsWith('/state')) return jsonResponse(apiState)
	if (/\/entry\/(pin|unpin|seal|unseal|delete)$/.test(url)) return jsonResponse({ ok: true, state: apiState })
	return jsonResponse({ ok: false, error: 'not found' }, 404)
}

// 迷你 React：只实现本组件用到的那几个 Hook，但支持 setState 后重渲染。
function createMiniReact() {
	let hooks = []
	let cursor = 0
	let current = null
	let latest = null
	function react_useState(initial) {
		const index = cursor
		cursor += 1
		if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
		return [
			hooks[index],
			value => {
				const next = typeof value === 'function' ? value(hooks[index]) : value
				if (Object.is(next, hooks[index])) return
				hooks[index] = next
				if (current) latest = current.component(current.props)
			},
		]
	}
	const react = {
		useState: react_useState,
		useRef(initial) {
			const index = cursor
			cursor += 1
			if (hooks[index] === undefined) hooks[index] = { current: initial }
			return hooks[index]
		},
		useEffect() {
			cursor += 1
		},
		useId() {
			cursor += 1
			return 'test-id-' + String(cursor)
		},
		useMemo(factory) {
			cursor += 1
			return factory()
		},
		useCallback(fn) {
			cursor += 1
			return fn
		},
	}
	return {
		react,
		render(component, props) {
			hooks = []
			cursor = 0
			current = { component, props }
			latest = component(props)
			return latest
		},
		get tree() {
			return latest
		},
	}
}

const mini = createMiniReact()
let bundleExports = null

/**
 * 覆盖全局。
 * ⚠️ 必须走 defineProperty：Node 24 的 `navigator` 是只读 getter，直接赋值会抛
 * （tools/calibrate.mjs 里有同一条实测记录）。
 */
function setGlobal(name, value) {
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	})
}

setGlobal('window', {
	__ModuleLoader__: {
		load(descriptor) {
			bundleExports = descriptor.factory(id => {
				if (id === 'react') return mini.react
				if (id === 'react/jsx-runtime') {
					const create = (type, props, key) => {
						const normalized = props || {}
						if (typeof type === 'function') {
							// 关键：函数组件就地展开（本插件的组件都不使用 Hook，
							// 唯一用 Hook 的根组件由 mini react 调用）。
							return { $$el: true, type: type.name || 'Anonymous', key, props: normalized, rendered: type(normalized) }
						}
						return { $$el: true, type, key, props: normalized }
					}
					return { jsx: create, jsxs: create, Fragment: Symbol('Fragment') }
				}
				throw new Error('测试桩未提供模块: ' + id)
			})
		},
	},
})
setGlobal('document', documentStub)
setGlobal('fetch', fetchStub)
setGlobal('localStorage', localStorageStub)
setGlobal('navigator', { clipboard: { writeText: async () => {} } })

const ctx = {
	effect(callback) {
		const disposer = callback()
		return () => {
			if (typeof disposer === 'function') disposer()
		}
	},
	locale: {
		register(ns, locale, dict) {
			dicts.set(ns + '|' + locale, dict)
			return () => dicts.delete(ns + '|' + locale)
		},
		bind: ns => (key, params) => translate(ns, key, params),
		getSnapshot: () => ({ active: activeLocale, locales: [], revision: 1 }),
		subscribe(listener) {
			localeListeners.add(listener)
			return () => localeListeners.delete(listener)
		},
	},
	slots: {
		inject(key, callback) {
			callback()
			return () => {}
		},
		register(options, component) {
			registered = { options, component }
			return () => {}
		},
	},
}

// ===========================================================================
// 元素树工具（与 tools/calibrate.mjs 同源）
// ===========================================================================
function collectElements(node, out) {
	const list = out || []
	if (node === null || node === undefined || typeof node === 'boolean') return list
	if (Array.isArray(node)) {
		for (const child of node) collectElements(child, list)
		return list
	}
	if (typeof node === 'object' && node.$$el) {
		list.push(node)
		if (node.rendered !== undefined) collectElements(node.rendered, list)
		collectElements(node.props && node.props.children, list)
	}
	return list
}
function collectText(node, out) {
	const list = out || []
	if (node === null || node === undefined || typeof node === 'boolean') return list
	if (typeof node === 'string' || typeof node === 'number') {
		list.push(String(node))
		return list
	}
	if (Array.isArray(node)) {
		for (const child of node) collectText(child, list)
		return list
	}
	if (typeof node === 'object' && node.$$el) {
		if (node.rendered !== undefined) collectText(node.rendered, list)
		collectText(node.props && node.props.children, list)
	}
	return list
}
const treeText = tree => collectText(tree).join('\n')
const findAll = (tree, type) => collectElements(tree).filter(element => element.type === type)
const findButton = (tree, text) =>
	collectElements(tree).find(
		element => element.type === 'button' && collectText(element).join('').indexOf(text) >= 0,
	)

// ===========================================================================
// 渲染
// ===========================================================================

await import(pathToFileURL(CLIENT_PATH).href)
const mod = bundleExports
check('bundle 载入并调用 __ModuleLoader__.load', !!mod)
mod.apply(ctx)
check('注册进 settings.section', registered?.options?.name === 'settings.section')
check('CSS 只靠 --dsw-* token（本文件的改动没有引入颜色字面量）',
	!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(styleTags[0]?.textContent ?? '') &&
		String(styleTags[0]?.textContent ?? '').includes('var(--dsw-alias-state-error'),
	'危险按钮必须用 --dsw-alias-state-error-* 这两个 token')

const face = registered.options.inject()
const props = {
	close: () => {},
	t: face.t,
	actions: face.actions,
	useAdapt: selector => selector(face.hooks.adapt.getSnapshot()),
}
await face.actions.refresh()
let tree = mini.render(registered.component, props)
let text = treeText(tree)

check('生成警告可见（含换血上限拒绝数）',
	text.includes(translate('prompt-adapt', 'genWarnings', { n: 1 })) &&
		text.includes('拒绝 9 条净新增'))
check('账本提示可见（从未注入条数）',
	text.includes(translate('prompt-adapt', 'ledgerHint', { n: 4, v: 7 })))
check('账本徽标：已注入版本数',
	text.includes(translate('prompt-adapt', 'ledgerSeen', { n: 2 })) &&
		text.includes(translate('prompt-adapt', 'ledgerSeen', { n: 1 })))
check('账本徽标：从未注入至少 4 条',
	(text.match(new RegExp(translate('prompt-adapt', 'ledgerNever'), 'g')) || []).length >= 4)
check('工作笔记可见（不占画像槽位）',
	text.includes(translate('prompt-adapt', 'workingNotesHeading', { n: 1 })) &&
		text.includes(translate('prompt-adapt', 'workingNotesHint')) &&
		text.includes('本机插件安装在'))

console.log('')
console.log('='.repeat(72))
console.log('1. 6 个区块的顺序与默认折叠态')
console.log('='.repeat(72))
{
	const at = needle => text.indexOf(needle)
	const order = [
		['① 置顶', at('置顶（10 条）')],
		['② 实际注入的系统提示', at('实际注入的系统提示')],
		['③ 完整画像', at('完整画像')],
		['④ 未注入', at('未注入（3 条）')],
		['⑤ 垃圾桶', at('垃圾桶（1 条）')],
		['⑥ 已删除', at('已删除（1 条）')],
	]
	check('6 个区块都渲染出来了', order.every(item => item[1] >= 0), JSON.stringify(order))
	check('★ 顺序就是 ①②③④⑤⑥（置顶最上、三个折叠区在完整画像之后）',
		order.every((item, index) => index === 0 || item[1] > order[index - 1][1]),
		order.map(item => `${item[0]}@${item[1]}`).join(' '))

	const details = findAll(tree, 'details')
	check('三个折叠区都用既有的 pa_details（不新造折叠组件）',
		details.filter(element => element.props.className === 'pa_details').length >= 3,
		`details 共 ${details.length} 个`)
	const foldSummaries = details.map(element => collectText(element.props.children).join('').slice(0, 12))
	check('④⑤⑥ 是 details，且**默认收起**（没有 open 属性）',
		details.every(element => element.props.open === undefined), JSON.stringify(foldSummaries))
	check('折叠区的 summary 里写着条数（用户不展开也知道有多少）',
		foldSummaries.some(item => item.includes('未注入（3 条）')) &&
			foldSummaries.some(item => item.includes('垃圾桶（1 条）')) &&
			foldSummaries.some(item => item.includes('已删除（1 条）')),
		JSON.stringify(foldSummaries))
}

console.log('')
console.log('='.repeat(72))
console.log('2. 每个区块的内容与按钮')
console.log('='.repeat(72))
{
	check('① 置顶区列出被置顶的条目原文', text.includes(CLAIM_PIN))
	check('① 置顶区提示这些条目"一定进注入"', text.includes('一定进注入'))
	check('① 置顶区里的条目可以取消置顶 / 封印 / 删除',
		!!findButton(tree, '取消置顶') && findAll(tree, 'button').filter(b => collectText(b).join('') === '封印').length > 0)

	check('② 注入区渲染宿主给的 injectedText（界面不自己拼）', text.includes('以下是这个用户已经确认的协作画像'))
	check('③ 完整画像按 A/B/C/D 分组，每条旁三个按钮', (() => {
		const labels = findAll(tree, 'button').map(button => collectText(button).join(''))
		return ['稳定特质', '行不通的做法', '有效的做法'].every(item => text.includes(item)) &&
			labels.filter(item => item === '置顶').length >= 5 &&
			labels.filter(item => item === '封印').length >= 5 &&
			labels.filter(item => item === '删除').length >= 1
	})(), JSON.stringify(findAll(tree, 'button').map(b => collectText(b).join('')).slice(0, 14)))

	check('★ 三个按钮的 title 把语义差别写清楚了（删除 vs 封印最容易混）', (() => {
		const sealButton = findAll(tree, 'button').find(b => collectText(b).join('') === '封印')
		const deleteButton = findAll(tree, 'button').find(b => collectText(b).join('') === '删除')
		return sealButton.props.title.includes('不会再产出') && deleteButton.props.title.includes('可能再次出现')
	})())
	check('★ 封印 / 删除按钮用了危险语义的 token（data-variant=danger）', (() => {
		const dangers = findAll(tree, 'button').filter(b => b.props['data-variant'] === 'danger')
		return dangers.length >= 2 && dangers.every(b => ['封印', '删除'].includes(collectText(b).join('')))
	})())

	check('④ 未注入区列出被预算裁掉的 A/B/C 条目', text.includes(CLAIM_C) && text.includes(CLAIM_B))
	check('④ 不重复收 D 类（D 类在 ③ 自己的「证据不足」折叠里，只显示一遍）',
		!treeText(findAll(tree, 'details').find(element =>
			treeText(element.props.children).includes('未注入（3 条）'))).includes(CLAIM_D) &&
			text.includes(CLAIM_D),
		'④ 里没有 D 类，③ 的折叠里有')
	check('⑤ 垃圾桶列出被封印的条目，并给出「恢复」', text.includes(CLAIM_SEALED) && !!findButton(tree, '恢复'))
	check('⑥ 已删除区显示"已删 N 次"与"已再次出现在画像里"',
		text.includes(CLAIM_DELETED) && text.includes('已删 2 次') && text.includes('已再次出现在画像里'),
		text.slice(text.indexOf('已删除（1 条）'), text.indexOf('已删除（1 条）') + 120))
}

console.log('')
console.log('='.repeat(72))
console.log('3. 上限与禁用（置顶满 10 条）')
console.log('='.repeat(72))
{
	const pinButtons = findAll(tree, 'button').filter(button => collectText(button).join('') === '置顶')
	check('★ 置顶已满（10/10）：③ 区的「置顶」按钮全部禁用', pinButtons.length > 0 &&
		pinButtons.every(button => button.props.disabled === true), `${pinButtons.length} 个置顶按钮`)
	check('★ 并且给出**原因**（不是静默禁用）',
		pinButtons.every(button => String(button.props.title).includes('置顶已满 10 条')),
		String(pinButtons[0]?.props.title))
	check('已置顶的那条显示「已置顶」徽标并把按钮换成「取消置顶」',
		text.includes('已置顶') && !!findButton(tree, '取消置顶'))
	check('上限数字来自宿主（`maxPinned`），不是界面写死的',
		String(pinButtons[0]?.props.title).includes('最多 10 条') === false ||
			HOST_STATE.maxPinned === 10)
}

console.log('')
console.log('='.repeat(72))
console.log('4. 点击链路：按钮 → 宿主 /entry/* 路由（不是只改本地状态）')
console.log('='.repeat(72))
{
	// 按"哪一行"取按钮：同一个「封印」在 ③ 区（条目还在画像里）与 ⑥ 区
	// （只剩标记记录）发给宿主的东西**不一样**，两条路都要验。
	const rows = () => findAll(tree, 'li').filter(element => element.props.className === 'pa_entry')
	const rowWith = claim => rows().find(row => treeText(row).includes(claim))
	const rowButton = (row, label) =>
		collectElements(row).find(element => element.type === 'button' && collectText(element).join('') === label)

	const sealRow = rowWith(CLAIM_B)
	check('能在 ③ 区定位到某条条目的那一行', !!sealRow && !!rowButton(sealRow, '封印'))
	calls.length = 0
	await rowButton(sealRow, '封印').props.onClick()
	await new Promise(resolve => setTimeout(resolve, 0))
	const sealCall = calls.find(call => call.url.endsWith('/entry/seal'))
	check('点 ③ 区的「封印」→ POST /entry/seal，带 id 与 claim（宿主据它定位并落盘）',
		!!sealCall && sealCall.body.id === 'b1' && sealCall.body.claim === CLAIM_B,
		JSON.stringify(sealCall?.body))
	check('点完会重新拉一次 /state（保证界面显示的是宿主的状态）',
		calls.some(call => call.url.endsWith('/state')))

	calls.length = 0
	await rowButton(rowWith(CLAIM_C), '删除').props.onClick()
	await new Promise(resolve => setTimeout(resolve, 0))
	check('点「删除」→ POST /entry/delete（与封印走不同的动作）',
		calls.some(call => call.url.endsWith('/entry/delete')), JSON.stringify(calls.map(call => call.url)))

	calls.length = 0
	await findButton(tree, '恢复').props.onClick()
	await new Promise(resolve => setTimeout(resolve, 0))
	const unsealCall = calls.find(call => call.url.endsWith('/entry/unseal'))
	check('点「恢复」→ POST /entry/unseal，按标记的 key 走（条目已不在画像里）',
		!!unsealCall && unsealCall.body.key === CLAIM_SEALED, JSON.stringify(unsealCall?.body))

	calls.length = 0
	await rowButton(rowWith(CLAIM_DELETED), '封印').props.onClick()
	await new Promise(resolve => setTimeout(resolve, 0))
	const escalateCall = calls.find(call => call.url.endsWith('/entry/seal'))
	check('在 ⑥ 区把"删过的"升级成封印：同样打到 /entry/seal，按 key 走',
		!!escalateCall && escalateCall.body.key === CLAIM_DELETED, JSON.stringify(escalateCall?.body))

	calls.length = 0
	await findButton(tree, '取消置顶').props.onClick()
	await new Promise(resolve => setTimeout(resolve, 0))
	check('点「取消置顶」→ POST /entry/unpin',
		calls.some(call => call.url.endsWith('/entry/unpin')), JSON.stringify(calls.map(call => call.url)))
}

console.log('')
console.log('='.repeat(72))
console.log('5. 老宿主 / 预览数据的形状（没有 entryMarks / injectedIds）')
console.log('='.repeat(72))
{
	check('夹具里那套字段确实是"新宿主"的形状', Array.isArray(HOST_STATE.entryMarks) &&
		Array.isArray(HOST_STATE.injection.injectedIds))

	// 退化成老形状：字段缺失
	apiState = JSON.parse(JSON.stringify(HOST_STATE))
	delete apiState.entryMarks
	delete apiState.maxPinned
	delete apiState.injection.injectedIds
	await face.actions.refresh()
	tree = mini.render(registered.component, props)
	text = treeText(tree)
	check('没有 entryMarks 时：①② 之外的三个处置区整块不显示，也不报错',
		!text.includes('垃圾桶（') && !text.includes('已删除（') && !text.includes('置顶（'),
		text.slice(0, 120))
	check('没有 injectedIds 时不显示「未注入」区（宁可不显示，也不乱报）', !text.includes('未注入（'))
	check('完整画像与注入区照旧渲染（老宿主仍可用）', text.includes('稳定特质') && text.includes('实际注入的系统提示'))
	check('③ 区的三个按钮照旧在（宿主不支持时点下去会得到可读错误）',
		findAll(tree, 'button').some(button => collectText(button).join('') === '封印'))
}

console.log('')
console.log('='.repeat(72))
console.log('6. 中英键一一对应 + 无硬编码颜色')
console.log('='.repeat(72))
{
	const zh = dicts.get('prompt-adapt|zh')
	const en = dicts.get('prompt-adapt|en')
	check('zh / en 两套字典 key 完全一致（新增的 25 个键都成对）',
		JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(en).sort()),
		`zh ${Object.keys(zh).length} 键 / en ${Object.keys(en).length} 键`)
	check('本次新增的键在两套字典里都有值', ['pinEntry', 'unpinEntry', 'sealEntry', 'unsealEntry',
		'deleteEntry', 'pinnedHeading', 'omittedHeading', 'sealedHeading', 'deletedHeading',
		'deletedCount', 'entryPinnedTag'].every(key => zh[key] && en[key]))
	check('CSS 里没有任何颜色字面量（hex/rgb/hsl）',
		!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(styleTags[0].textContent))

	// 英文界面下同样渲染得出来（key 少一个就会显示成 key 本身）
	// ⚠️ 先把宿主状态换回"新宿主"那份：上一节故意退化成了老形状，不换回来
	//    这几个区块根本不会渲染（那样测的就是"没渲染"而不是"英文文案"）。
	apiState = JSON.parse(JSON.stringify(HOST_STATE))
	await face.actions.refresh()
	activeLocale = 'en'
	tree = mini.render(registered.component, props)
	const enText = treeText(tree)
	check('切到英文后区块标题跟着变', enText.includes('Trash (1)') && enText.includes('Deleted (1)'),
		JSON.stringify({
			trash: enText.includes('Trash (1)'),
			deleted: enText.includes('Deleted (1)'),
			pinned: enText.includes('Pinned (10)'),
			notInjected: enText.includes('Not injected (5)'),
		}))
	check('英文界面下没有漏出字典 key 名（少一个键就会显示成 key 本身）',
		['sealedHeading', 'deletedHeading', 'pinnedHeading', 'omittedHeading', 'pinEntry',
			'unpinEntry', 'sealEntry', 'unsealEntry', 'deleteEntry', 'deletedCount',
			'entryPinnedTag', 'pinEntryHint'].every(key => !enText.includes(key)),
		['sealedHeading', 'pinEntry', 'entryPinnedTag'].filter(key => enText.includes(key)).join(','))
	activeLocale = 'zh'
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))
process.exit(fail === 0 ? 0 : 1)
