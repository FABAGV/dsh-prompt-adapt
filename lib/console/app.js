import { api, el, clear, setCsrf, toast, fmtAgo } from './lib.js'
import { renderOverview } from './page-overview.js'
import { renderProfile } from './page-profile.js'
import { renderPrivacy } from './page-privacy.js'
import { renderPersonas } from './page-persona.js'
import { renderSkills } from './page-skills.js'
import { renderAudit } from './page-audit.js'

const PAGES = [
  { id: 'overview', label: '概览', render: renderOverview },
  { id: 'profile', label: '画像', render: renderProfile },
  { id: 'privacy', label: '权限', render: renderPrivacy },
  { id: 'persona', label: '人格', render: renderPersonas },
  { id: 'skills', label: '技能', render: renderSkills },
  { id: 'audit', label: '审计', render: renderAudit },
]

let current = null

function routeFromHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const page = PAGES.find(item => item.id === parts[0]) ?? PAGES[0]
  return { page, params: parts.slice(1).map(decodeURIComponent) }
}

/** 页面里有未保存的修改时，切走之前先问一句。 */
let leaveGuard = null
export function setLeaveGuard(guard) {
  leaveGuard = typeof guard === 'function' ? guard : null
}

async function show() {
  const { page, params } = routeFromHash()
  current?.controller.abort()
  leaveGuard = null
  const controller = new AbortController()
  current = { id: page.id, controller }
  for (const link of document.querySelectorAll('#nav a')) {
    link.setAttribute('aria-current', link.dataset.page === page.id ? 'page' : 'false')
  }
  const view = document.getElementById('view')
  const samePage = view.dataset.page === page.id
  view.dataset.page = page.id
  clear(view)
  view.append(el('p', { class: 'muted', text: '正在载入…' }))
  if (!samePage) window.scrollTo(0, 0)
  document.title = `${page.label} · prompt-adapt 控制台`
  try {
    await page.render(view, {
      signal: controller.signal,
      params,
      rerender: () => show(),
      navigate: hash => {
        if (location.hash === hash) show()
        else location.hash = hash
      },
    })
    if (!controller.signal.aborted) view.focus({ preventScroll: true })
  } catch (error) {
    if (controller.signal.aborted) return
    clear(view)
    view.append(
      el('div', { class: 'notice bad' },
        el('strong', { text: '载入失败：' }), error?.message ?? String(error)),
      el('button', { class: 'btn', type: 'button', text: '重试', onclick: () => show() }),
    )
  }
}

function buildNav() {
  const nav = document.getElementById('nav')
  clear(nav)
  for (const page of PAGES) {
    nav.append(el('a', { href: `#/${page.id}`, dataset: { page: page.id }, text: page.label }))
  }
}

async function boot() {
  const me = await api('GET', '/me')
  setCsrf(me.csrf)
  buildNav()
  const info = document.getElementById('session-info')
  info.textContent = `${me.via === 'key' ? '用登录密钥' : '从 DSH 设置页'}登录 · ${fmtAgo(me.since)}`
  document.getElementById('logout').addEventListener('click', async () => {
    try {
      await api('POST', '/logout')
    } catch {
      /* 登出失败也回登录页 */
    }
    location.href = '/login'
  })
  window.addEventListener('hashchange', event => {
    if (leaveGuard && !leaveGuard()) {
      const previous = new URL(event.oldURL).hash
      history.replaceState(null, '', previous || '#/overview')
      return
    }
    show()
  })
  window.addEventListener('beforeunload', event => {
    if (leaveGuard && !leaveGuard({ silent: true })) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
  if (!location.hash) history.replaceState(null, '', '#/overview')
  await show()
}

boot().catch(error => {
  const view = document.getElementById('view')
  clear(view)
  view.append(el('div', { class: 'notice bad', text: `控制台启动失败：${error?.message ?? error}` }))
  toast(error?.message ?? String(error), 'bad')
})
