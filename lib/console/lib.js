/**
 * 控制台页面共用的小工具：请求、建 DOM、提示、格式化。
 * 所有文本都走 textContent / createTextNode，不拼 HTML。
 */

let csrfToken = null

export function setCsrf(value) {
  csrfToken = value
}

/** 调控制台接口。401 时跳回登录页；非 2xx 或 `ok:false` 时抛出带中文原因的错误。 */
export async function api(method, path, body) {
  const headers = { accept: 'application/json' }
  if (method !== 'GET') {
    headers['x-pa-csrf'] = csrfToken ?? ''
    if (body !== undefined) headers['content-type'] = 'application/json'
  }
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (response.status === 401) {
    location.href = '/login'
    throw new Error('需要重新登录')
  }
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  if (!response.ok || json?.ok === false) {
    const error = new Error(json?.error ?? `请求失败（HTTP ${response.status}）`)
    error.status = response.status
    error.payload = json
    throw error
  }
  return json
}

/** 建一个元素。`props` 里 `on*` 是事件，`text` 是文本，`class` 是类名，其余写成属性或 DOM 属性。 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    // CSP 不允许 style 属性（style-src 'self'），走 CSSOM 赋值不受影响。
    else if (key === 'style') node.style.cssText = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') node[key] = value
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  append(node, children)
  return node
}

export function append(node, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

export function toast(text, kind = '') {
  const box = document.getElementById('toasts')
  if (!box) return
  const item = el('div', { class: `toast ${kind}`, text })
  box.append(item)
  setTimeout(() => item.remove(), kind === 'bad' ? 7000 : 3500)
}

/** 包一层：按钮点下去先禁用，失败弹出原因。返回事件处理函数。 */
export function action(handler, { busyText } = {}) {
  return async event => {
    const button = event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null
    const label = button?.textContent
    if (button) {
      button.disabled = true
      if (busyText) button.textContent = busyText
    }
    try {
      await handler(event)
    } catch (error) {
      toast(error?.message ?? String(error), 'bad')
    } finally {
      if (button && button.isConnected) {
        button.disabled = false
        if (busyText) button.textContent = label
      }
    }
  }
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

/**
 * 轮询一个后台任务直到结束。`signal` 取消时停止轮询（任务本身照常跑）。
 * @returns {Promise<object>} 结束时的任务对象
 */
export async function waitJob(id, { onProgress, signal } = {}) {
  while (!signal?.aborted) {
    const { job } = await api('GET', `/jobs/${id}`)
    if (job.status !== 'running') return job
    onProgress?.(job)
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  return null
}

export const TIER_LABEL = { full: '完全', safe: '受限', chat: '仅聊天', inherit: '跟随父会话' }
export const KIND_LABEL = { owner: '你自己的会话', subagent: '子代理', 'qq-group': 'QQ 群', 'qq-private': 'QQ 私聊' }
export const SKILLS_LABEL = { all: '全部技能', shared: '只看可共享的', none: '不给技能', inherit: '跟随父会话' }
export const CATEGORY_LABEL = { A: '稳定特质', B: '行不通的做法', C: '有效的做法', D: '证据不足' }

export function tierBadge(tier) {
  const kind = tier === 'full' ? 'warn' : tier === 'chat' ? 'ok' : 'accent'
  return el('span', { class: `badge ${kind}`, text: TIER_LABEL[tier] ?? tier })
}

export function section(title, ...children) {
  return el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: title })), children)
}

/** 下拉框。`options` 是 `[value, label]` 数组。 */
export function select(options, value, onChange, props = {}) {
  const node = el('select', props, options.map(([optionValue, label]) => el('option', { value: optionValue, text: label, selected: optionValue === value })))
  node.value = value
  if (onChange) node.addEventListener('change', () => onChange(node.value))
  return node
}

export function checkbox(label, checked, onChange, props = {}) {
  const input = el('input', { type: 'checkbox', checked, ...props })
  if (onChange) input.addEventListener('change', () => onChange(input.checked))
  return el('label', { class: 'inline' }, input, label)
}
