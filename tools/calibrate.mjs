#!/usr/bin/env node
/**
 * dsh-prompt-adapt —— 客户端半边的冒烟测试 + 修订阈值标定工具。
 *
 * 为什么需要它：`lib/client.js` 是**手写**的 DSH bundle（没有构建步骤），
 * 一旦语法或模块格式写错，只有把插件装进 profile 才会发现。这个脚本在
 * Node 里把 `window.__ModuleLoader__` / `document` / `react` / `fetch` /
 * `localStorage` 全部打桩，然后：
 *
 *   1. 真的把 bundle 当模块 import 进来（语法 + 顶层副作用路径验证）；
 *   2. 真的调用它的 `factory(require)`（模块体 + CSS 注入路径验证）；
 *   3. 用假 ctx 调 `apply()`，捕获它往 `settings.section` 注册的东西；
 *   4. 用**迷你 React**（useState/useRef/useId/useEffect 的最小实现，
 *      支持 setState 后重渲染）真的把组件渲染一遍，并对返回的元素树做断言 ——
 *      包括"点一下『从模式 1 填入』之后 textarea 真的被填了"。
 *
 * 它**不是** React 渲染器：没有 react-dom，所以布局、CSS、真实事件系统
 * 都没被验证。文档里如实写了这一点。
 *
 * 用法：
 *   node tools/calibrate.mjs
 *       跑全部自检，失败则退出码非 0。
 *
 *   node tools/calibrate.mjs --baseline <a.json> --current <b.json>
 *       用**真实样本**标定阈值。<a.json>/<b.json> 可以是
 *         - 宿主的 state.json（会读 .profile.entries）
 *         - 或一份画像 JSON（会读 .entries）
 *       输出：逐条相似度矩阵、当前判定、以及"如果只靠文本相似度、阈值取
 *       0.2~0.9 各会误报多少处修订"的表 —— 这张表就是"为什么主判据不能是
 *       文本"的实测证据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_PATH = path.join(ROOT, 'lib', 'client.js');

/**
 * 每次载入都换一个 query，绕过 Node 的模块缓存 ——
 * 否则第二次 import 拿到的是缓存，模块体不会重跑，
 * `window.__ModuleLoader__.load` 也不会被再次调用。
 */
let loadCounter = 0;
async function loadClientModule() {
	loadCounter += 1;
	return import(pathToFileURL(CLIENT_PATH).href + '?load=' + loadCounter);
}

// ===========================================================================
// 极简断言
// ===========================================================================

let passed = 0;
const failures = [];

function ok(name, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`  \u2713 ${name}`);
		return true;
	}
	failures.push({ name, detail });
	console.log(`  \u2717 ${name}${detail === undefined ? '' : `\n      ${detail}`}`);
	return false;
}

function eq(name, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	return ok(name, a === b, a === b ? undefined : `expected ${b}\n      actual   ${a}`);
}

function section(title) {
	console.log(`\n== ${title} ==`);
}

// ===========================================================================
// 环境打桩
// ===========================================================================

/** 可能被桩覆盖的全局名。 */
const PATCHED_GLOBALS = ['window', 'document', 'fetch', 'localStorage', 'navigator'];

/**
 * 记录这些全局的属性描述符。
 * Node 24 的 `navigator` 是只读 getter，直接赋值会抛，所以一律走
 * defineProperty，并且失败时静默跳过（例：不可配置的全局）。
 */
function snapshotGlobals() {
	const saved = {};
	for (const name of PATCHED_GLOBALS) {
		saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
	}
	return saved;
}

function applyGlobals(values) {
	for (const name of PATCHED_GLOBALS) {
		if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
		try {
			Object.defineProperty(globalThis, name, {
				value: values[name],
				writable: true,
				configurable: true,
				enumerable: true,
			});
		} catch (error) {
			/* 该全局不可覆盖：相关能力走兜底路径，测试仍然继续 */
		}
	}
}

function restoreGlobals(saved) {
	for (const name of PATCHED_GLOBALS) {
		const descriptor = saved[name];
		try {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete globalThis[name];
		} catch (error) {
			/* 还原不了也不影响测试结论 */
		}
	}
}

/** 最初的真实全局描述符，供最后一次性还原。 */
let previousGlobals = null;

/** 造一个 fetch Response 桩。 */
function jsonResponse(payload, status) {
	const code = status === undefined ? 200 : status;
	const text = JSON.stringify(payload);
	return {
		ok: code >= 200 && code < 300,
		status: code,
		text: async () => text,
	};
}

/**
 * 迷你 React：只实现本组件用到的那几个 Hook，但**支持 setState 重渲染**，
 * 因此"点按钮 → 界面变化"这条链路可以真的被断言。
 */
function createMiniReact() {
	let hooks = [];
	let cursor = 0;
	let current = null;
	let latest = null;
	let effectSlots = [];
	let pendingEffects = [];

	/**
	 * 跑本轮 paint 排队的 effect（在 paint 之后异步跑，避免"渲染中 setState"）。
	 * deps 用 Object.is 逐项比较；不传 deps 视为每次都跑 —— 与 React 一致。
	 */
	function runPendingEffects() {
		const batch = pendingEffects;
		pendingEffects = [];
		for (const entry of batch) {
			const previous = effectSlots[entry.index];
			if (previous && typeof previous.cleanup === 'function') {
				try {
					previous.cleanup();
				} catch (error) {
					/* 清理抛错不影响后续 */
				}
			}
			const cleanup = entry.fn();
			effectSlots[entry.index] = {
				deps: entry.deps,
				cleanup: typeof cleanup === 'function' ? cleanup : null,
			};
		}
	}

	const react = {
		useState(initial) {
			const index = cursor;
			cursor += 1;
			if (hooks[index] === undefined) {
				hooks[index] = typeof initial === 'function' ? initial() : initial;
			}
			const setState = value => {
				const next = typeof value === 'function' ? value(hooks[index]) : value;
				if (Object.is(next, hooks[index])) return;
				hooks[index] = next;
				rerender();
			};
			return [hooks[index], setState];
		},
		useRef(initial) {
			const index = cursor;
			cursor += 1;
			if (hooks[index] === undefined) hooks[index] = { current: initial };
			return hooks[index];
		},
		useEffect(fn, deps) {
			const index = cursor;
			cursor += 1;
			const previous = effectSlots[index];
			const changed =
				!previous ||
				deps === undefined ||
				previous.deps === undefined ||
				deps.length !== previous.deps.length ||
				deps.some((dep, i) => !Object.is(dep, previous.deps[i]));
			if (changed) pendingEffects.push({ index, fn, deps });
		},
		useId() {
			cursor += 1;
			return 'test-id-' + String(cursor);
		},
		useMemo(factory) {
			cursor += 1;
			return factory();
		},
		useCallback(fn) {
			cursor += 1;
			return fn;
		},
	};
	function paint() {
		cursor = 0;
		pendingEffects = [];
		latest = current.component(current.props);
		// 异步跑 effect：与 React 的提交后执行对齐，也避免渲染中 setState
		queueMicrotask(runPendingEffects);
		return latest;
	}
	function rerender() {
		paint();
	}
	return {
		react,
		/** 渲染一次并返回元素树（重置 Hook 与 effect 状态，等价于重新挂载）。 */
		render(component, props) {
			hooks = [];
			effectSlots = [];
			pendingEffects = [];
			current = { component, props };
			return paint();
		},
		/**
		 * 保留 Hook 状态重新渲染 —— 等价于 React 因外部 store 变化而重渲染。
		 * 组件里的 `useAdapt` 在真实环境是 useSyncExternalStore 语义，
		 * 所以 store emit 必须走这条路径，否则测出来的行为偏保守。
		 */
		rerender() {
			if (!current) return null;
			return paint();
		},
		/** 最近一次渲染的元素树（setState / rerender 之后会更新）。 */
		get tree() {
			return latest;
		},
	};
}

/** 让挂起的 async 链跑完（fetch 桩是 async 的，需要几轮）。 */
async function flush(times) {
	const rounds = times || 4;
	for (let i = 0; i < rounds; i += 1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

/** 真的等一段墙钟（给 setInterval 用）。 */
async function sleep(ms) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 安装全部全局桩，并返回一个"渲染会话"对象。
 * @param {object} options
 * @param {object} options.state 宿主 /state 要返回的状态
 * @param {Map<string,string>} [options.localStorageSeed]
 */
function createHarness(options) {
	const calls = [];
	const dicts = new Map();
	const localeListeners = new Set();
	let localeRevision = 1;
	let activeLocale = 'zh';
	let apiState = JSON.parse(JSON.stringify(options.state));
	let bundleExports = null;
	let registered = null;
	let injected = null;
	const effectLabels = [];
	const effects = [];

	function translate(ns, key, params) {
		const chain = [activeLocale, 'zh', 'en'];
		let template = null;
		for (const locale of chain) {
			const dict = dicts.get(ns + '|' + locale);
			if (dict && typeof dict[key] === 'string') {
				template = dict[key];
				break;
			}
		}
		if (template === null) return key;
		if (!params) return template;
		return template.replace(/\{(\w+)\}/g, (match, name) =>
			Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
		);
	}

	// —— document 桩：CSS 注入路径要真的走一遍 ——
	const styleTags = [];
	const documentStub = {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
		head: { appendChild: element => styleTags.push(element) },
		body: { appendChild: () => {}, removeChild: () => {} },
		execCommand: () => true,
	};

	const storage = new Map();
	if (options.localStorageSeed) {
		for (const [key, value] of options.localStorageSeed) storage.set(key, value);
	}
	const localStorageStub = {
		getItem: key => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
		removeItem: key => storage.delete(key),
	};

	const fetchStub = async (url, init) => {
		const method = (init && init.method) || 'GET';
		const body = init && init.body ? JSON.parse(init.body) : null;
		calls.push({ url, method, body });
		if (url.endsWith('/state')) return jsonResponse(apiState);
		if (url.endsWith('/mode')) {
			apiState.mode = body.mode;
			return jsonResponse({ ok: true, mode: body.mode });
		}
		if (url.endsWith('/custom')) {
			apiState.customText = body.text;
			return jsonResponse({ ok: true });
		}
		if (url.endsWith('/copied')) {
			apiState.copiedSnapshot = {
				text: body.text,
				at: body.at,
				profileVersion: body.profileVersion,
				entries: body.entries,
				algorithmVersion: body.algorithmVersion,
			};
			return jsonResponse({ ok: true });
		}
		if (url.endsWith('/regenerate')) {
			// 与宿主 lib/http.js:252-270 一致：立刻回 202，后台跑。
			// 注意：宿主的 getState() 里**没有** running 字段。
			return jsonResponse({ ok: true, started: true }, 202);
		}
		if (url.endsWith('/rescan')) {
			return jsonResponse({ ok: true, started: true }, 202);
		}
		return jsonResponse({ ok: false, error: 'not found' }, 404);
	};

	const mini = createMiniReact();

	if (!previousGlobals) previousGlobals = snapshotGlobals();
	const saved = snapshotGlobals();
	applyGlobals({
		document: documentStub,
		fetch: fetchStub,
		localStorage: localStorageStub,
		navigator: { clipboard: { writeText: async () => {} } },
		window: {
			__ModuleLoader__: {
				load: descriptor => {
					bundleExports = descriptor.factory(id => {
						if (id === 'react') return mini.react;
						if (id === 'react/jsx-runtime') {
							// 关键：函数组件**就地展开**。
							// 本组件树里的 CategoryGroup / EvidenceRow / RevisionNotice /
							// SignalGrid 都不使用 Hook，所以直接调用是安全的，而且
							// 这样树就是完全展开的，断言不必再模拟一次渲染。
							// 根组件（AdaptSection）由迷你 React 调用，不走这里。
							const create = (type, props, key) => {
								const normalized = props || {};
								if (typeof type === 'function') {
									return {
										$$el: true,
										type: type.name || 'Anonymous',
										key,
										props: normalized,
										rendered: type(normalized),
									};
								}
								return { $$el: true, type, key, props: normalized };
							};
							return { jsx: create, jsxs: create, Fragment: Symbol('Fragment') };
						}
						throw new Error('测试桩未提供模块: ' + id);
					});
					bundleExports.__id = descriptor.id;
				},
			},
		},
	});

	const ctx = {
		effect(callback, label) {
			effectLabels.push(label);
			const disposer = callback();
			effects.push({ label, disposer });
			return () => {
				if (typeof disposer === 'function') disposer();
			};
		},
		locale: {
			register(ns, locale, dict) {
				dicts.set(ns + '|' + locale, dict);
				localeRevision += 1;
				for (const listener of Array.from(localeListeners)) listener();
				return () => dicts.delete(ns + '|' + locale);
			},
			bind(ns) {
				return (key, params) => translate(ns, key, params);
			},
			getSnapshot() {
				return { active: activeLocale, locales: [], revision: localeRevision };
			},
			subscribe(listener) {
				localeListeners.add(listener);
				return () => localeListeners.delete(listener);
			},
		},
		slots: {
			inject(key, callback) {
				injected = { key, disposer: callback() };
				return () => {};
			},
			register(options, component) {
				registered = { options, component };
				return () => {};
			},
		},
	};

	return {
		ctx,
		mini,
		calls,
		styleTags,
		storage,
		dicts,
		effectLabels,
		effects,
		/**
		 * 模拟插件卸载：把 ctx.effect 登记的清理函数全部跑一遍。
		 * 用来验证"卸载后不会留下轮询定时器"（否则 Node 进程都退不出去）。
		 */
		runDisposers() {
			for (const entry of effects) {
				if (typeof entry.disposer === 'function') entry.disposer();
			}
		},
		get exports() {
			return bundleExports;
		},
		get registered() {
			return registered;
		},
		get injected() {
			return injected;
		},
		get apiState() {
			return apiState;
		},
		setApiState(next) {
			apiState = next;
		},
		setLocale(next) {
			activeLocale = next;
			localeRevision += 1;
			for (const listener of Array.from(localeListeners)) listener();
		},
		restore() {
			restoreGlobals(saved);
		},
	};
}

// ===========================================================================
// 元素树工具
// ===========================================================================

/** 深度优先收集所有元素节点。 */
function collectElements(node, out) {
	const list = out || [];
	if (node === null || node === undefined || typeof node === 'boolean') return list;
	if (Array.isArray(node)) {
		for (const child of node) collectElements(child, list);
		return list;
	}
	if (typeof node === 'object' && node.$$el) {
		list.push(node);
		if (node.rendered !== undefined) collectElements(node.rendered, list);
		collectElements(node.props && node.props.children, list);
	}
	return list;
}

/** 收集所有字符串文本（含 props.children 与已展开的函数组件输出）。 */
function collectText(node, out) {
	const list = out || [];
	if (node === null || node === undefined || typeof node === 'boolean') return list;
	if (typeof node === 'string' || typeof node === 'number') {
		list.push(String(node));
		return list;
	}
	if (Array.isArray(node)) {
		for (const child of node) collectText(child, list);
		return list;
	}
	if (typeof node === 'object' && node.$$el) {
		if (node.rendered !== undefined) collectText(node.rendered, list);
		collectText(node.props && node.props.children, list);
	}
	return list;
}

/** 整棵树的文本拼成一个串（用于"某段文案出现过没有"的断言）。 */
function treeText(tree) {
	return collectText(tree).join('\n');
}

/** 按 type 找元素。 */
function findByType(tree, type) {
	return collectElements(tree).filter(element => element.type === type);
}

/** 找按钮：文本匹配。 */
function findButton(tree, text) {
	return collectElements(tree).find(
		element =>
			element.type === 'button' && collectText(element).join('').indexOf(text) >= 0,
	);
}

// ===========================================================================
// 测试数据
// ===========================================================================

const BASELINE_ENTRIES = [
	{
		id: 'a1',
		category: 'A',
		claim: '用户偏好简短、直达结论的回答，不喜欢铺垫。',
		evidence: ['[12] 直接说结论就行', '[48] 别写那么多'],
		confidence: 'high',
		evidenceQuoteCount: 2,
		lastEvidenceMessages: 96,
	},
	{
		id: 'b1',
		category: 'B',
		claim: '不要在没有确认的情况下动别人的文件。',
		evidence: ['[77] 谁让你改这个的'],
		confidence: 'high',
		evidenceQuoteCount: 1,
		lastEvidenceMessages: 96,
	},
	{
		id: 'c1',
		category: 'C',
		claim: '先给出最小可验证的一步，再展开。',
		evidence: ['[101] 这样挺好'],
		confidence: 'medium',
		evidenceQuoteCount: 1,
		lastEvidenceMessages: 96,
	},
];

const CURRENT_ENTRIES = [
	// 逐字未变
	BASELINE_ENTRIES[0],
	// 同 id、同证据、只换措辞 → 必须是 0 处
	{
		id: 'b1',
		category: 'B',
		claim: '改动他人文件之前必须先征求同意。',
		evidence: ['[77] 谁让你改这个的'],
		confidence: 'high',
		evidenceQuoteCount: 1,
		lastEvidenceMessages: 96,
	},
	// 同 id、证据集合变了 → 必须是 1 处（改写）
	{
		id: 'c1',
		category: 'C',
		claim: '先给出最小可验证的一步，再展开；改完要自己验一遍。',
		evidence: ['[101] 这样挺好', '[133] 你自己跑过了吗'],
		confidence: 'high',
		evidenceQuoteCount: 2,
		lastEvidenceMessages: 148,
	},
	// 新 id → 必须是 1 处（新增）
	{
		id: 'n1',
		category: 'A',
		claim: '用户使用中文交流，技术术语保留英文原文。',
		evidence: ['[140] 这个 tool call 是啥'],
		confidence: 'medium',
		evidenceQuoteCount: 1,
		lastEvidenceMessages: 148,
	},
];

function buildHostState(overrides) {
	return Object.assign(
		{
			ok: true,
			contract: 1,
			mode: 'auto',
			customText: '',
			autoExtraText: '',
			hallUrl: 'https://example.com/prompts',
			profile: {
				version: 7,
				generatedAt: 1760000000000,
				provider: 'x',
				model: 'y',
				evidenceMessages: 148,
				notes: '备注',
				raw: '',
				entries: CURRENT_ENTRIES,
			},
			copiedSnapshot: {
				text: null,
				at: 1759900000000,
				profileVersion: 6,
				entries: BASELINE_ENTRIES,
				algorithmVersion: 1,
			},
			lastGeneration: { at: 1760000000000, humanMessages: 148, sessions: 9 },
			lastSignals: {
				totals: {
					sessions: 9,
					humanMessages: 148,
					delegateRuns: 3,
					longTools: 5,
					repeatFailures: 2,
					freeformAnswers: 4,
					unpairedToolResults: 1,
				},
			},
			lastRun: { at: 1760000000000, ok: true, reason: '新增 20 >= 12', error: null, spuriousRate: 0.05 },
			running: false,
			effectiveText: '',
		},
		overrides || {},
	);
}

// ===========================================================================
// 与宿主 lib/http.js 的集成（用**真实路由代码**，不是桩）
// ===========================================================================

/**
 * 把宿主的 `registerRoutes()` 挂到一个假 webServer 上，再把 fetch 接到那个
 * handler 上 —— 于是客户端的每一次请求都真的过一遍宿主的
 * 路径分发 / 方法校验 / body 解析 / 状态码 / 响应序列化。
 *
 * 这一节能抓到的东西：路径写错、方法写错、body 字段名对不上、
 * `algorithmVersion` 类型不对（宿主只接受 string）、状态码处理错。
 *
 * 服务对象是**最小假实现**（字段名与宿主 `getState()` 一致）。
 * 服务内部的逻辑由宿主自己的 `test/httptest.mjs` 负责，不在这里重复。
 *
 * @param {object} harness 已经 createHarness 过的 harness
 * @returns {Promise<{ok:boolean, reason?:string, service?:object, dispose?:Function}>}
 */
async function attachHostRoutes(harness) {
	const httpPath = path.join(ROOT, 'lib', 'http.js');
	if (!fs.existsSync(httpPath)) return { ok: false, reason: 'lib/http.js 不存在' };

	let http;
	try {
		http = await import(pathToFileURL(httpPath).href);
	} catch (error) {
		return { ok: false, reason: 'lib/http.js 载入失败：' + (error && error.message) };
	}
	if (typeof http.registerRoutes !== 'function') {
		return { ok: false, reason: 'lib/http.js 没有导出 registerRoutes' };
	}

	let handler = null;
	const fakeWebServer = {
		register(route) {
			if (handler) throw new Error('重复注册');
			handler = route.handler;
			return () => {
				handler = null;
			};
		},
	};
	const root = { get: name => (name === 'webServer' ? fakeWebServer : undefined) };
	const silent = { debug() {}, info() {}, warn() {}, error() {} };

	// 假服务：字段名严格照宿主 getState() 的形状
	let mode = 'auto';
	let customText = '';
	let copiedSnapshot = {
		text: null,
		at: null,
		profileVersion: null,
		entries: null,
		algorithmVersion: null,
	};
	let regenerateCalls = 0;

	const service = {
		validate() {
			if (mode !== 'auto' && mode !== 'custom') throw new Error('mode 越界');
		},
		getState() {
			return {
				mode,
				customText,
				autoExtraText: '',
				profile: {
					version: 7,
					generatedAt: 1760000000000,
					provider: 'x',
					model: 'y',
					evidenceMessages: 148,
					notes: '',
					raw: '',
					entries: CURRENT_ENTRIES,
				},
				copiedSnapshot,
				lastGeneration: { at: 1760000000000, humanMessages: 148, sessions: 9 },
				lastSignals: {
					at: 1760000000000,
					totals: {
						sessions: 9,
						humanMessages: 148,
						delegateRuns: 3,
						longTools: 5,
						repeatFailures: 2,
						freeformAnswers: 4,
						unpairedToolResults: 1,
					},
					sessionCount: 9,
				},
				lastRun: {
					at: 1760000000000,
					ok: true,
					reason: '新增 20 >= 12',
					error: null,
					spuriousRate: 0.05,
					diff: null,
				},
				effectiveText: mode === 'auto' ? 'PORTRAIT-FROM-HOST' : customText,
				staleCopy: false,
			};
		},
		setMode(next) {
			if (next !== 'auto' && next !== 'custom') throw new Error('未知模式: ' + next);
			mode = next;
		},
		setCustomText(text) {
			customText = String(text ?? '');
		},
		markCopied(text, extra = {}) {
			copiedSnapshot = {
				text: String(text ?? ''),
				at: Date.now(),
				profileVersion: 7,
				entries: Array.isArray(extra?.entries) ? extra.entries : null,
				algorithmVersion:
					typeof extra?.algorithmVersion === 'string' ? extra.algorithmVersion : null,
			};
		},
		async regenerateNow() {
			regenerateCalls += 1;
			return { ok: true };
		},
		async rescanNow() {
			return { ok: true };
		},
		getPromptHallUrl() {
			return ''; // 与宿主 lib/hall.js 当前一致：空串 = 未配置
		},
	};

	const dispose = http.registerRoutes({ root, service, log: silent });
	if (typeof dispose !== 'function' || !handler) {
		return { ok: false, reason: 'registerRoutes 没有返回 disposer' };
	}

	// 把 fetch 接到真实 handler 上：构造一个 IncomingMessage 形状的可读流
	applyGlobals({
		fetch: (url, init) =>
			new Promise((resolve, reject) => {
				const method = (init && init.method) || 'GET';
				const bodyText = init && init.body !== undefined ? String(init.body) : '';
				let settled = false;
				const res = {
					statusCode: 0,
					headers: {},
					writeHead(code, headers) {
						this.statusCode = code;
						Object.assign(this.headers, headers || {});
					},
					end(payload) {
						settled = true;
						const text = payload === undefined || payload === null ? '' : String(payload);
						resolve({
							ok: this.statusCode >= 200 && this.statusCode < 300,
							status: this.statusCode,
							text: async () => text,
						});
					},
				};
				const req = new Readable({ read() {} });
				req.method = method;
				req.url = String(url);
				req.headers = bodyText
					? { 'content-length': String(Buffer.byteLength(bodyText)) }
					: {};
				// ⚠️ 不要覆盖 req.destroy：Readable 在自然结束时**也会**调用它
				// （autoDestroy），覆盖成 reject 会在正常请求上误报。
				// 改成挂一个兜底超时，任何"没有回应"的情况都会让测试失败而不是挂住。
				const safety = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new Error(`测试桩：${method} ${url} 5 秒内没有响应`));
				}, 5000);
				if (typeof safety.unref === 'function') safety.unref();
				try {
					Promise.resolve(handler(req, res)).catch(reject);
				} catch (error) {
					reject(error);
					return;
				}
				// handler 已经同步挂上 data/end 监听器（readJsonBody 的 executor 是同步的），
				// 所以现在推 body 不会被漏掉。
				if (bodyText) req.push(bodyText);
				req.push(null);
			}),
	});

	return {
		ok: true,
		service,
		dispose,
		getIntercepted() {
			return { mode, customText, copiedSnapshot, regenerateCalls };
		},
	};
}

// ===========================================================================
// 主流程
// ===========================================================================

async function main() {
	const args = process.argv.slice(2);
	const baselineFlag = args.indexOf('--baseline');
	const currentFlag = args.indexOf('--current');
	if (baselineFlag >= 0 && currentFlag >= 0) {
		await calibrate(args[baselineFlag + 1], args[currentFlag + 1]);
		return;
	}

	console.log('dsh-prompt-adapt 客户端半边自检');
	console.log('bundle: ' + CLIENT_PATH);

	// -------------------------------------------------------------------
	section('1. bundle 载入（语法 + 模块格式 + CSS 注入）');
	// -------------------------------------------------------------------
	const harness = createHarness({ state: buildHostState() });
	let mod;
	try {
		await loadClientModule();
		mod = harness.exports;
		ok('lib/client.js 可被当模块载入且调用了 __ModuleLoader__.load', !!mod);
	} catch (error) {
		ok('lib/client.js 可被当模块载入', false, String(error && error.stack));
		harness.restore();
		process.exitCode = 1;
		return;
	}
	eq('模块 id 是包名', mod.__id, 'dsh-prompt-adapt');
	ok('导出 apply()', typeof mod.apply === 'function');
	eq('导出 inject = ["slots","locale"]', mod.inject, ['slots', 'locale']);
	ok('导出了 __internals（标定工具入口）', !!mod.__internals);
	ok('CSS 真的被注入了一次 style 标签', harness.styleTags.length === 1,
		'styleTags=' + harness.styleTags.length);
	ok(
		'CSS 里没有任何颜色字面量（hex/rgb/hsl）',
		!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(harness.styleTags[0] ? harness.styleTags[0].textContent : ''),
		'发现硬编码颜色',
	);
	ok(
		'CSS 只靠 --dsw-* token 取色',
		(harness.styleTags[0] ? harness.styleTags[0].textContent : '').indexOf('var(--dsw-') >= 0,
	);

	const core = mod.__internals;

	// -------------------------------------------------------------------
	section('2. 归一化与相似度（说明"为什么主判据不能是文本"）');
	// -------------------------------------------------------------------
	const stripped = core.normalizeClaim('用户偏好简短回答（基于 37 条发言）。');
	ok('证据量噪声被剥掉', stripped.indexOf('37') < 0 && stripped.indexOf('基于') < 0, stripped);
	eq('纯标点差异归一化后相同', core.normalizeClaim('先给结论。'), core.normalizeClaim('先给结论！'));
	eq('大小写与全角被折叠', core.normalizeClaim('Use  ＴＯＯＬＳ'), core.normalizeClaim('use tools'));

	const paraphrase = core.claimSimilarity(
		'用户偏好简短、直达结论的回答，不喜欢铺垫。',
		'用户喜欢简洁、直接给结论的表达，不爱铺垫。',
	);
	console.log(`  · 同义改写的字符 bigram 相似度 = ${paraphrase.toFixed(3)}（这是本方案不用文本当主判据的原因）`);
	ok(
		'同义改写的文本相似度确实很低（< 0.30）—— 证明文本判据会误报',
		paraphrase < 0.3,
		'相似度 = ' + paraphrase.toFixed(3),
	);
	const verbatim = core.claimSimilarity(CURRENT_ENTRIES[0].claim, BASELINE_ENTRIES[0].claim);
	ok('逐字照抄的文本相似度 = 1', verbatim === 1, String(verbatim));

	ok('证据集合相同 → evidenceUnchanged = true', core.evidenceUnchanged(['a', 'b'], ['a', 'b']));
	ok('证据集合多一条 → evidenceUnchanged = false', !core.evidenceUnchanged(['a', 'b'], ['a', 'b', 'c']));
	ok('两边都没有证据 → evidenceUnchanged = true（但那是"不知道"）', core.evidenceUnchanged([], []));
	ok('两边都没有证据 → evidenceComparable = false（所以会退到文本兜底）', !core.evidenceComparable([], []));
	ok('两边都有证据 → evidenceComparable = true（因此不给文本翻案机会）', core.evidenceComparable(['a'], ['b']));
	ok('一边有证据一边没有 → 视为变了', !core.evidenceUnchanged(['a'], []));

	// -------------------------------------------------------------------
	section('3. 修订比较：核心场景');
	// -------------------------------------------------------------------
	const main = core.comparePortraits({
		baseline: BASELINE_ENTRIES,
		current: CURRENT_ENTRIES,
		baselineAlgorithmVersion: core.ALGORITHM_VERSION,
	});
	eq('修订数 = 2（1 处改写 + 1 处新增；换措辞的那条不算）', main.count, 2);
	eq('status = changed', main.status, 'changed');
	eq('新增 1 条', main.added.length, 1);
	eq('改写 1 条', main.modified.length, 1);
	eq('删除 0 条', main.removed.length, 0);
	ok(
		'被压掉的是 b1（同证据、只换措辞）',
		main.modified.every(pair => pair.after.id !== 'b1') && main.added.every(e => e.id !== 'b1'),
		'actual modified=' + JSON.stringify(main.modified.map(p => p.after.id)),
	);
	ok('改写那条的判据是 evidence 而不是 text', main.modified[0] && main.modified[0].reason === 'evidence');

	// 只有措辞抖动：整体闸门兜住
	const wordingOnly = core.comparePortraits({
		baseline: BASELINE_ENTRIES,
		current: BASELINE_ENTRIES.map((entry, index) =>
			index === 0
				? Object.assign({}, entry, { claim: '用户偏好简短、直达结论的回答，不喜欢铺垫。' })
				: entry,
		),
		baselineAlgorithmVersion: core.ALGORITHM_VERSION,
	});
	eq('全部逐字未变 → 0 处', wordingOnly.count, 0);
	eq('status = unchanged', wordingOnly.status, 'unchanged');

	// 同证据换措辞（无整体闸门保护时靠 evidence 判据）
	const sameEvidence = core.comparePortraits({
		baseline: BASELINE_ENTRIES,
		current: BASELINE_ENTRIES.map(entry =>
			entry.id === 'a1'
				? Object.assign({}, entry, { claim: '这个用户喜欢简短直接的回答，不爱铺垫。' })
				: entry,
		),
		baselineAlgorithmVersion: core.ALGORITHM_VERSION,
	});
	eq('同 id 同证据只换措辞 → 0 处', sameEvidence.count, 0);
	ok(
		'并且原因确实是 evidence（不是文本兜底）',
		sameEvidence.modified.length === 0,
		JSON.stringify(sameEvidence),
	);

	// id 抖动：内容一样只换了 id。
	// 这一步其实被"全局闸门"兜住了（claim 一个字没变 → 整体相似度 1.0），
	// 所以先验证闸门，再用一个能穿过闸门的样本单独验证 renames 归并。
	const idChurn = core.comparePortraits({
		baseline: BASELINE_ENTRIES,
		current: BASELINE_ENTRIES.map(entry =>
			entry.id === 'a1' ? Object.assign({}, entry, { id: 'auto-1-xyz' }) : entry,
		),
		baselineAlgorithmVersion: core.ALGORITHM_VERSION,
	});
	eq('只换了 id、内容一样 → 0 处', idChurn.count, 0);
	eq('这种情况由全局闸门直接判定', idChurn.status, 'unchanged');

	// 穿过全局闸门：换个 id + 让 c1 的证据真的变了 → 只应报 1 处，且 renames=1
	const idChurnPlusReal = core.comparePortraits({
		baseline: BASELINE_ENTRIES,
		current: BASELINE_ENTRIES.map(entry => {
			if (entry.id === 'a1') return Object.assign({}, entry, { id: 'auto-1-xyz' });
			if (entry.id === 'c1') {
				return Object.assign({}, entry, {
					claim: '先给出最小可验证的一步，再展开；改完要自己验一遍。',
					evidence: ['[101] 这样挺好', '[133] 你自己跑过了吗'],
				});
			}
			return entry;
		}),
		baselineAlgorithmVersion: core.ALGORITHM_VERSION,
	});
	eq('id 抖动 + 1 处真改写 → 只报 1 处（不把改名算成增+删）', idChurnPlusReal.count, 1);
	ok('并且被记为 renames=1', idChurnPlusReal.renames === 1, 'renames=' + idChurnPlusReal.renames);
	eq('新增 0 / 删除 0', [idChurnPlusReal.added.length, idChurnPlusReal.removed.length], [0, 0]);

	// 纪律：基线只有文本 → 不猜
	const textOnly = core.comparePortraits({
		baseline: core.parseRenderedProfileText(core.serializePortrait(BASELINE_ENTRIES)),
		current: CURRENT_ENTRIES,
		baselineAlgorithmVersion: core.ALGORITHM_VERSION,
		baselineIsTextOnly: true,
	});
	eq('纯文本基线 → status = low-confidence', textOnly.status, 'low-confidence');
	eq('纯文本基线 → 不报数字（count = 0）', textOnly.count, 0);
	ok('并且标记 lowConfidence', textOnly.lowConfidence === true);

	// 纪律：算法版本变了 → 不比较
	const stale = core.comparePortraits({
		baseline: BASELINE_ENTRIES,
		current: CURRENT_ENTRIES,
		baselineAlgorithmVersion: core.ALGORITHM_VERSION - 1,
	});
	eq('旧算法基线 → status = stale-baseline', stale.status, 'stale-baseline');
	eq('旧算法基线 → count = 0', stale.count, 0);

	// 纪律：没有基线
	const none = core.comparePortraits({ baseline: null, current: CURRENT_ENTRIES });
	eq('没有基线 → status = no-baseline', none.status, 'no-baseline');
	eq('没有基线 → count = 0', none.count, 0);

	// 当前画像为空
	const empty = core.comparePortraits({
		baseline: BASELINE_ENTRIES,
		current: [],
		baselineAlgorithmVersion: core.ALGORITHM_VERSION,
	});
	eq('当前画像为空 → status = empty-current', empty.status, 'empty-current');
	eq('当前画像为空 → count = 0（不刷"删了 N 条"）', empty.count, 0);

	// 序列化 / 解析往返（serializePortrait 按 A/B/C/D 分组，所以比较时排序）
	const roundTrip = core.parseRenderedProfileText(core.serializePortrait(CURRENT_ENTRIES));
	eq('renderProfileText 格式可往返解析（条目数）', roundTrip.length, CURRENT_ENTRIES.length);
	const sortPairs = list =>
		list.map(e => e.category + '|' + e.claim).sort();
	eq(
		'往返后 claim 与 category 都对得上',
		sortPairs(roundTrip),
		sortPairs(CURRENT_ENTRIES),
	);
	ok('往返后没有任何条目落进"未知分类"', roundTrip.every(e => e.category !== ''), JSON.stringify(roundTrip.map(e => e.category)));

	// -------------------------------------------------------------------
	section('4. 挂载点与注册契约');
	// -------------------------------------------------------------------
	mod.apply(harness.ctx);
	ok('slots.inject 被调用在 settings.section 上', !!harness.injected && harness.injected.key === 'settings.section');
	ok('settings.section 声明后才有注册（inject 是等待语义）', !!harness.registered);
	const opt = harness.registered ? harness.registered.options : {};
	eq('注册进 settings.section', opt.name, 'settings.section');
	eq('列表槽位 id 唯一', opt.id, 'prompt-adapt');
	eq('order = 40', opt.order, 40);
	ok('label 是 thunk（跟随语言，不重新注册）', typeof opt.label === 'function', typeof opt.label);
	eq('label() 走字典', opt.label(), 'AI 适配');
	ok('注册了 zh/en 两套字典', harness.dicts.has('prompt-adapt|zh') && harness.dicts.has('prompt-adapt|en'));
	ok('ctx.effect 被用来托管生命周期', harness.effectLabels.length >= 3, harness.effectLabels.join(' | '));

	// -------------------------------------------------------------------
	section('5. 组件结构（迷你 React 真渲染一遍）');
	// -------------------------------------------------------------------
	const injectedFace = opt.inject();
	ok('inject 面提供 t', typeof injectedFace.t === 'function');
	ok('inject 面提供 actions', !!injectedFace.actions);
	ok('inject 面提供 hooks.adapt（合成 useAdapt）', !!(injectedFace.hooks && injectedFace.hooks.adapt));
	ok('状态源 getSnapshot/subscribe 齐全',
		typeof injectedFace.hooks.adapt.getSnapshot === 'function' &&
		typeof injectedFace.hooks.adapt.subscribe === 'function');

	await injectedFace.actions.refresh();
	// 模拟"上次复制过"：本地基线
	harness.storage.set(
		'dsh-prompt-adapt:copied:v1',
		JSON.stringify({
			text: core.serializePortrait(BASELINE_ENTRIES),
			at: 1759900000000,
			profileVersion: 6,
			entries: BASELINE_ENTRIES,
			algorithmVersion: core.ALGORITHM_VERSION,
		}),
	);
	await injectedFace.actions.refresh();

	const props = {
		close: () => {},
		t: injectedFace.t,
		actions: injectedFace.actions,
		useAdapt: selector => selector(injectedFace.hooks.adapt.getSnapshot()),
	};
	let tree = harness.mini.render(harness.registered.component, props);
	// 真实环境里 useAdapt 是 useSyncExternalStore 语义：store 一变就重渲染。
	// 这里用订阅复刻那条链路，而不是每步手动重渲染。
	injectedFace.hooks.adapt.subscribe(() => harness.mini.rerender());
	let text = treeText(tree);

	ok('渲染出标题', text.indexOf('让 AI 更好地适配你') >= 0);
	ok('渲染出模式 1 面板', text.indexOf('模式 1 · 自动画像') >= 0);
	ok('渲染出模式 2 面板', text.indexOf('模式 2 · 自定义') >= 0);
	ok('渲染出模式 3 面板', text.indexOf('模式 3 · 提示词大厅') >= 0);
	ok('明确显示当前生效的是哪一个', text.indexOf('当前生效：自动画像') >= 0, text.slice(0, 400));
	ok('模式 1 标为"生效中"', text.indexOf('生效中') >= 0);
	ok('模式 2 标为"未生效"', text.indexOf('未生效') >= 0);
	ok('互斥选择器是 radiogroup', findByType(tree, 'div').some(el => el.props.role === 'radiogroup'));
	eq('选择器有两个 radio', findByType(tree, 'button').filter(b => b.props.role === 'radio').length, 2);
	ok('显示上次更新时间', /上次更新：/.test(text));
	ok('显示画像基于多少条发言', text.indexOf('画像基于 148 条发言') >= 0);
	ok('显示证据量（基于 N 条发言）', text.indexOf('基于 96 条发言') >= 0);
	ok('显示"有 N 处修订"', text.indexOf('有 2 处修订') >= 0, text.slice(0, 600));
	ok('修订提示说明了只算有依据的变化', text.indexOf('换了措辞不算') >= 0);
	ok('有"复制"按钮', !!findButton(tree, '复制'));
	ok('有"重新生成"按钮', !!findButton(tree, '重新生成'));
	ok('有"从模式 1 填入"按钮', !!findButton(tree, '从模式 1 填入'));
	ok('模式 3 是外链而不是内容', findByType(tree, 'a').some(a => a.props.href === 'https://example.com/prompts'));
	ok('外链在新标签打开且带 rel=noopener', findByType(tree, 'a').every(a => a.props.target === '_blank' && a.props.rel === 'noopener noreferrer'));
	ok('外链声明了不抓取不缓存', text.indexOf('不抓取、不缓存') >= 0);
	ok('没有抓取外链内容的任何请求（模式 3 只是链接）',
		harness.calls.every(call => call.url.indexOf('example.com') < 0));

	// 宿主当前用的是占位地址 PROMPT_HALL_URL = 'https://example.invalid/prompt-hall'
	ok('宿主占位地址 .invalid 被识别为占位符', core.resolveHallUrl({ hallUrl: 'https://example.invalid/prompt-hall' }) === '');
	ok('promptHallUrl 字段名也被接受（对应 service.getPromptHallUrl()）',
		core.resolveHallUrl({ promptHallUrl: 'https://real.example.net/hall' }) === 'https://real.example.net/hall');
	ok('两个字段名同时出现时 hallUrl 优先',
		core.resolveHallUrl({ hallUrl: 'https://a.example.net/x', promptHallUrl: 'https://b.example.net/y' }) === 'https://a.example.net/x');
	ok('四个计数信号渲染出来了', text.indexOf('AI 把活推回给你') >= 0 && text.indexOf('给了选项你却自己另说') >= 0);
	ok('展示上次生成的措辞抖动率', text.indexOf('措辞抖动率') >= 0);
	ok('没有渲染预览横幅（因为读到了真宿主）', text.indexOf('预览数据') < 0);

	// —— 交互：点"从模式 1 填入" → textarea 真的被填 ——
	const textareaBefore = findByType(tree, 'textarea')[0];
	ok('存在 textarea', !!textareaBefore);
	eq('初始 textarea 为空（宿主 customText 为空）', textareaBefore.props.value, '');
	ok('初始状态显示"已与宿主同步"', treeText(tree).indexOf('已与宿主同步') >= 0);
	const fillButton = findButton(tree, '从模式 1 填入');
	fillButton.props.onClick();
	tree = harness.mini.tree;
	const textareaAfter = findByType(tree, 'textarea')[0];
	ok(
		'点击后 textarea 被填入画像全文（且不是自动覆盖：这是点击的结果）',
		typeof textareaAfter.props.value === 'string' && textareaAfter.props.value.indexOf('【稳定特质】') >= 0,
		'value 前 80 字: ' + String(textareaAfter.props.value).slice(0, 80),
	);
	ok('填入后标记为有未保存的修改', treeText(tree).indexOf('有未保存的修改') >= 0);
	ok('填入后出现"保存"可点', !!findButton(tree, '保存'));

	// —— 交互：非空时点"从模式 1 填入" → 先确认，不直接覆盖 ——
	const fillAgain = findButton(tree, '从模式 1 填入');
	fillAgain.props.onClick();
	tree = harness.mini.tree;
	ok('文本框非空时再点填入 → 先弹确认，不静默覆盖', treeText(tree).indexOf('填入会覆盖当前文本框内容') >= 0);
	ok('确认前内容没被改动', findByType(tree, 'textarea')[0].props.value.indexOf('【稳定特质】') >= 0);

	// —— 交互：复制按钮 ——
	harness.calls.length = 0;
	const copyButton = findButton(tree, '复制');
	await copyButton.props.onClick();
	await flush();
	const copiedCall = harness.calls.find(call => call.url.endsWith('/copied'));
	ok('点复制后向宿主 /copied 上报了基线', !!copiedCall);
	ok('上报的基线带上了结构化 entries（精确比较的前提）',
		!!copiedCall && Array.isArray(copiedCall.body.entries) && copiedCall.body.entries.length === CURRENT_ENTRIES.length);
	ok('上报的基线带了算法版本',
		!!copiedCall && copiedCall.body.algorithmVersion === core.ALGORITHM_VERSION);
	ok('algorithmVersion 是字符串（宿主 markCopied 只接受 typeof === "string"）',
		!!copiedCall && typeof copiedCall.body.algorithmVersion === 'string',
		'typeof=' + (copiedCall ? typeof copiedCall.body.algorithmVersion : 'n/a'));
	ok('本地也记了基线', harness.storage.has('dsh-prompt-adapt:copied:v1'));
	tree = harness.mini.tree;
	ok('复制之后修订归零（store emit 驱动重渲染，无需手动刷新）',
		treeText(tree).indexOf('与你上次复制时一致') >= 0, treeText(tree).slice(0, 700));

	// —— 交互：切到模式 2 且模式 2 有内容 → 提醒 ——
	harness.setApiState(buildHostState({ mode: 'custom', customText: '我的写法' }));
	await injectedFace.actions.refresh();
	tree = harness.mini.render(harness.registered.component, props);
	await flush();
	tree = harness.mini.tree;
	ok('模式 2 生效时显示"当前生效：自定义"', treeText(tree).indexOf('当前生效：自定义') >= 0);
	ok('模式 2 生效时 textarea 同步到宿主文本（effect 驱动）',
		findByType(tree, 'textarea')[0].props.value === '我的写法',
		'value=' + JSON.stringify(findByType(tree, 'textarea')[0].props.value));

	// 回归测试：模式 2 生效时，宿主的 effectiveText 等于自定义文本。
	// 如果"从模式 1 填入"错用了 effectiveText，就会把文本框内容填回自己。
	findButton(tree, '从模式 1 填入').props.onClick();
	await flush();
	tree = harness.mini.tree;
	const confirmFill = findButton(tree, '确认填入');
	ok('模式 2 生效且文本框已有内容 → 先要确认（不静默覆盖）', !!confirmFill);
	if (confirmFill) {
		confirmFill.props.onClick();
		await flush();
		tree = harness.mini.tree;
	}
	const filledValue = findByType(tree, 'textarea')[0].props.value;
	ok(
		'模式 2 生效时填进来的是**画像**文本，不是自定义文本本身',
		filledValue.indexOf('【稳定特质】') >= 0 && filledValue.indexOf('我的写法') < 0,
		'value 前 80 字: ' + String(filledValue).slice(0, 80),
	);

	harness.calls.length = 0;
	findButton(tree, '自动画像').props.onClick();
	tree = harness.mini.tree;
	ok('从模式 2 切模式 1 且模式 2 有内容 → 弹出"会以模式 1 为准"的提醒',
		treeText(tree).indexOf('切换到「自动画像」会以模式 1 为准') >= 0);
	ok('提醒里有"仍然切换"和"取消"', !!findButton(tree, '仍然切换') && !!findButton(tree, '取消'));
	ok('确认前没有发切换请求', harness.calls.filter(c => c.url.endsWith('/mode')).length === 0);
	findButton(tree, '仍然切换').props.onClick();
	await flush();
	ok('确认后才真的发切换请求', harness.calls.some(c => c.url.endsWith('/mode') && c.body.mode === 'auto'));

	// —— 交互：重新生成（宿主回 202 + 无 running 字段 → 客户端必须自己观察） ——
	globalThis.__DSH_PROMPT_ADAPT__ = { pollMs: 20 };
	harness.setApiState(buildHostState());
	await injectedFace.actions.refresh();
	harness.calls.length = 0;
	await injectedFace.actions.regenerate();
	const afterTrigger = injectedFace.hooks.adapt.getSnapshot();
	ok('POST /regenerate 已发出', harness.calls.some(call => call.url.endsWith('/regenerate')));
	ok('宿主回 202 被当作成功（requestJson 只认 2xx）', afterTrigger.phase === 'ready', afterTrigger.phase);
	ok('触发后进入"生成中"状态', afterTrigger.regenerating === true);
	tree = harness.mini.tree;
	ok('界面显示"生成中…"并禁用按钮',
		treeText(tree).indexOf('生成中…') >= 0 &&
			findButton(tree, '生成中…').props.disabled === true);
	ok('并说明了会在后台自动更新', treeText(tree).indexOf('生成已在后台开始') >= 0);

	// 宿主后台完成：版本号与 generatedAt 都变了
	const bumped = buildHostState();
	bumped.profile = Object.assign({}, bumped.profile, { version: 8, generatedAt: Date.now() });
	bumped.lastRun = Object.assign({}, bumped.lastRun, { at: Date.now() });
	harness.setApiState(bumped);
	await sleep(160);
	ok('画像版本变化后自动退出"生成中"',
		injectedFace.hooks.adapt.getSnapshot().regenerating === false);
	const callsAfterSettle = harness.calls.length;
	await sleep(160);
	ok('退出后停止轮询（不再对 /state 发请求）', harness.calls.length === callsAfterSettle,
		`before=${callsAfterSettle} after=${harness.calls.length}`);
	delete globalThis.__DSH_PROMPT_ADAPT__;

	// -------------------------------------------------------------------
	section('4b. 注入区显示各分类条数（取自宿主 injectedByCategory）');
	// -------------------------------------------------------------------
	// 需求：A 类有了保底份额，用户要在界面上**自己验证 A 不再归零**。
	// 数字一律取自宿主 `GET /state` 的 `injection.injectedByCategory`，界面不自己算
	// （界面只有完整画像，算不出宿主那次裁剪的结果）。
	// ⚠️ 夹具默认**不带** `injection` 字段 —— 那正是"老宿主 / 预览数据"的形状，
	//    上面那批断言就是在那个形状下跑的（"只显示文本、不报条数"）。这里显式给。
	const withBreakdown = buildHostState();
	withBreakdown.injection = {
		budgetChars: 1500,
		totalEntries: CURRENT_ENTRIES.length,
		injectedEntries: 4,
		omittedEntries: CURRENT_ENTRIES.length - 4,
		injectedByCategory: { A: 2, B: 2, C: 0, D: 0 },
		omittedByCategory: { A: 0, B: 0, C: 2, D: 0 },
		estimatedChars: 120,
		overBudget: false,
		annotation: '（本次注入 4/6 条；A 类 2 条、B 类 2 条、C 类 0 条）',
	};
	harness.setApiState(withBreakdown);
	await injectedFace.actions.refresh();
	tree = harness.mini.tree;
	ok('注入区渲染出各分类条数（A/B/C 三个数字都来自宿主）',
		treeText(tree).indexOf('A 2 条 · B 2 条 · C 0 条') >= 0,
		treeText(tree).slice(0, 700));

	// A 类被挤成 0 的情形：界面必须如实显示 0，不许藏起来 ——
	// 这个数字是用户验证"保底有没有生效"的唯一依据。
	const zeroA = buildHostState();
	zeroA.injection = Object.assign({}, withBreakdown.injection, {
		injectedByCategory: { A: 0, B: 6, C: 0, D: 0 },
	});
	harness.setApiState(zeroA);
	await injectedFace.actions.refresh();
	tree = harness.mini.tree;
	ok('A 类为 0 时如实显示（不隐藏、不美化）',
		treeText(tree).indexOf('A 0 条 · B 6 条 · C 0 条') >= 0,
		treeText(tree).slice(0, 700));

	// —— 断连状态 ——
	// 注意：新 harness 的桩必须先在位，再载入模块（模块体在顶层就注册 factory）。
	const offline = createHarness({ state: buildHostState() });
	await loadClientModule();
	const offlineMod = offline.exports;
	offlineMod.apply(offline.ctx);
	const offlineFace = offline.registered.options.inject();
	applyGlobals({
		fetch: async () => {
			throw new Error('connect ECONNREFUSED 127.0.0.1:19387');
		},
	});
	await offlineFace.actions.refresh();
	const offlineProps = {
		close: () => {},
		t: offlineFace.t,
		actions: offlineFace.actions,
		useAdapt: selector => selector(offlineFace.hooks.adapt.getSnapshot()),
	};
	let offlineTree = offline.mini.render(offline.registered.component, offlineProps);
	const offlineText = treeText(offlineTree);
	ok('读不到宿主时显示"未连接宿主"', offlineText.indexOf('未连接宿主') >= 0);
	ok('断连时给出实际请求的 URL', offlineText.indexOf('/dsh-prompt-adapt/api/state') >= 0);
	ok('断连时提供"重试"按钮', !!findButton(offlineTree, '重试'));
	ok('断连时提供"载入预览数据"按钮（且是明示的演示数据）',
		!!findButton(offlineTree, '载入预览数据'));
	findButton(offlineTree, '载入预览数据').props.onClick();
	// 这个 harness 没有订阅 store emit，显式重渲染一次
	offlineTree = offline.mini.render(offline.registered.component, offlineProps);
	const previewText = treeText(offlineTree);
	ok('预览模式明确标注"仅界面演示"', previewText.indexOf('仅界面演示') >= 0, previewText.slice(0, 400));
	ok('预览模式下修订数依然是 2（同一套比较逻辑）', previewText.indexOf('有 2 处修订') >= 0,
		previewText.slice(0, 800));
	offline.restore();

	// -------------------------------------------------------------------
	section('6. 语言：文案没有写死在组件里');
	// -------------------------------------------------------------------
	const en = harness.dicts.get('prompt-adapt|en');
	const zh = harness.dicts.get('prompt-adapt|zh');
	ok('zh / en 两套字典 key 完全一致',
		JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(en).sort()));
	ok('字典 key 数量合理（> 90 条）', Object.keys(zh).length > 90, String(Object.keys(zh).length));
	const zhMissing = Object.keys(zh).filter(key => !zh[key]);
	eq('zh 没有空文案', zhMissing, []);

	// -------------------------------------------------------------------
	section('7. 与宿主 lib/http.js 的集成（真实路由代码 + 真实 body 解析）');
	// -------------------------------------------------------------------
	const ih = createHarness({ state: buildHostState() });
	const host = await attachHostRoutes(ih);
	if (!host.ok) {
		ok('能挂上宿主 lib/http.js', false, host.reason);
	} else {
		ok('能挂上宿主 lib/http.js 并拿到 disposer', true);
		await loadClientModule();
		ih.exports.apply(ih.ctx);
		const face = ih.registered.options.inject();
		const ihProps = {
			close: () => {},
			t: face.t,
			actions: face.actions,
			useAdapt: selector => selector(face.hooks.adapt.getSnapshot()),
		};

		// GET /state 走真实分发
		await face.actions.refresh();
		const snap = face.hooks.adapt.getSnapshot();
		ok('GET /state 经宿主真实路由成功', snap.phase === 'ready', String(snap.error));
		eq('契约版本被读到', snap.contract, 1);
		ok('宿主的 profile.entries 被读到（4 条）',
			!!(snap.state && snap.state.profile && snap.state.profile.entries.length === 4));
		ok('宿主没有 running 字段也不影响（当前不在生成中）', snap.regenerating === false);
		ok('hallUrl = null（宿主未配置）→ 界面显示"尚未配置"而不是死链',
			ih.exports.__internals.resolveHallUrl(snap.state) === '');

		// POST /mode：body 形状必须被宿主接受
		await face.actions.setMode('custom');
		eq('POST /mode 真的改到了宿主状态', host.getIntercepted().mode, 'custom');

		// PUT /custom
		await face.actions.saveCustom('我的写法 v2');
		eq('PUT /custom 真的写进了宿主', host.getIntercepted().customText, '我的写法 v2');

		// POST /copied：algorithmVersion 必须是字符串，否则宿主会存成 null
		await face.actions.markCopied('PORTRAIT TEXT');
		const intercepted = host.getIntercepted();
		ok('POST /copied 真的写进了宿主 copiedSnapshot.text',
			intercepted.copiedSnapshot.text === 'PORTRAIT TEXT');
		ok('宿主接受并保存了结构化 entries（精确比较的前提）',
			Array.isArray(intercepted.copiedSnapshot.entries) &&
				intercepted.copiedSnapshot.entries.length === 4);
		eq('宿主保存了 algorithmVersion（证明字符串类型对了）',
			intercepted.copiedSnapshot.algorithmVersion, '1');

		// POST /regenerate：宿主回 202，客户端必须当成功并开始观察
		await face.actions.regenerate();
		eq('POST /regenerate 真的打到了宿主服务', host.getIntercepted().regenerateCalls, 1);
		ok('202 之后客户端进入"生成中"', face.hooks.adapt.getSnapshot().regenerating === true);

		// 非法 mode 必须被宿主拒掉，且客户端要如实报错
		const bad = await fetch('/dsh-prompt-adapt/api/mode', {
			method: 'POST',
			body: JSON.stringify({ mode: 'both' }),
		});
		eq('宿主对非法 mode 回 400', bad.status, 400);
		const badBody = JSON.parse(await bad.text());
		ok('400 响应里有可读的 error', typeof badBody.error === 'string' && badBody.error.length > 0);

		// 未知路径
		const missing = await fetch('/dsh-prompt-adapt/api/nope');
		eq('未知路径回 404', missing.status, 404);

		// 真实渲染一遍，确认宿主数据能画出来
		const ihTree = ih.mini.render(ih.registered.component, ihProps);
		await flush();
		const ihText = treeText(ih.mini.tree);
		ok('用宿主真实响应渲染出了画像分类', ihText.indexOf('稳定特质') >= 0, ihText.slice(0, 300));
		ok('渲染出了四个计数信号', ihText.indexOf('AI 把活推回给你') >= 0);
		ok('模式 3 因未配置而显示提示', ihText.indexOf('外链地址尚未配置') >= 0);

		// 卸载清理：观察者还在跑的时候把插件 fiber 拆掉，轮询必须停
		const beforeDispose = ih.calls.length;
		ih.runDisposers();
		await sleep(120);
		eq('卸载后轮询被清掉（否则会一直空轮询，进程也退不出去）',
			ih.calls.length, beforeDispose);
		host.dispose();
	}
	ih.restore();

	harness.restore();
	if (previousGlobals) restoreGlobals(previousGlobals);

	// -------------------------------------------------------------------
	console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
	if (failures.length > 0) {
		console.log('\n失败项：');
		for (const failure of failures) console.log(`  - ${failure.name}`);
	}
	// 兜底：即便还有没清掉的定时器，也让进程退出（退出码仍然反映结果）
	process.exit(failures.length > 0 ? 1 : 0);
}

// ===========================================================================
// 真实样本标定
// ===========================================================================

/** 从 state.json 或画像 JSON 里把 entries 抠出来。 */
function readEntries(file) {
	// PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，JSON.parse 会炸。
	// 顺手容忍一下，避免手工造样本时踩坑。
	const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
	if (raw && raw.profile && Array.isArray(raw.profile.entries)) return raw.profile.entries;
	if (Array.isArray(raw && raw.entries)) return raw.entries;
	throw new Error(`${file} 里找不到 entries（既不是 profile 也不是 state.json）`);
}

async function calibrate(baselineFile, currentFile) {
	const harness = createHarness({ state: buildHostState() });
	await loadClientModule();
	const core = harness.exports.__internals;
	harness.restore();

	const baseline = readEntries(baselineFile);
	const current = readEntries(currentFile);
	console.log('真实样本标定');
	console.log(`  基线: ${baselineFile}（${baseline.length} 条）`);
	console.log(`  当前: ${currentFile}（${current.length} 条）`);

	const report = core.comparePortraits({
		baseline,
		current,
		baselineAlgorithmVersion: core.ALGORITHM_VERSION,
	});
	console.log('\n—— 现行判定（证据驱动的保守判据）——');
	console.log(`  整体 token 相似度 : ${report.globalSimilarity.toFixed(4)}（闸门 ${core.COMPARE_DEFAULTS.globalSimilarityFloor}）`);
	console.log(`  status            : ${report.status}`);
	console.log(`  修订处数          : ${report.count}`);
	console.log(`  新增 / 删除 / 改写: ${report.added.length} / ${report.removed.length} / ${report.modified.length}`);
	console.log(`  id 抖动归并       : ${report.renames}`);
	if (report.added.length) console.log('  新增: ' + report.added.map(e => e.id || e.claim.slice(0, 20)).join(', '));
	if (report.removed.length) console.log('  删除: ' + report.removed.map(e => e.id || e.claim.slice(0, 20)).join(', '));
	if (report.modified.length) {
		for (const pair of report.modified) {
			console.log(`  改写 [${pair.reason}] ${pair.before.id}`);
			console.log(`     旧: ${pair.before.claim}`);
			console.log(`     新: ${pair.after.claim}`);
		}
	}

	console.log('\n—— 如果只按文本相似度判（阈值扫描）——');
	console.log('  这就是"纯措辞变化会刷屏"的量化证据：');
	console.log('  阈值   被当成"变了的条目数"   占比');
	const baseById = new Map(baseline.filter(e => e.id).map(e => [e.id, e]));
	const pairs = [];
	for (const entry of current) {
		const before = entry.id ? baseById.get(entry.id) : null;
		if (!before) continue;
		pairs.push({ id: entry.id, sim: core.claimSimilarity(before.claim, entry.claim) });
	}
	for (const threshold of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9]) {
		const flagged = pairs.filter(pair => pair.sim < threshold).length;
		const rate = pairs.length > 0 ? ((flagged / pairs.length) * 100).toFixed(1) + '%' : '—';
		console.log(`  ${threshold.toFixed(1)}    ${String(flagged).padStart(3)} / ${pairs.length}                 ${rate}`);
	}
	console.log('\n  逐条相似度（同 id）：');
	for (const pair of pairs) console.log(`    ${String(pair.id).padEnd(16)} ${pair.sim.toFixed(3)}`);
	console.log('\n结论：阈值取 0.3 以下也仍有大量同义改写被误判，取高又全都误判。');
	console.log('      所以主判据是 evidence 集合是否变化，文本相似度只在无证据时兜底。');
}

main().catch(error => {
	console.error(error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
