import { api, el, clear, select, fmtTime, KIND_LABEL, TIER_LABEL } from './lib.js'

const TYPE_LABEL = { deny: '拦下工具调用', policy: '修改权限', persona: '人格', skill: '技能' }
const ACTOR_LABEL = { console: '本机控制台', 'dsh-settings': 'DSH 设置页' }

function describe(item) {
  if (item.type === 'deny') {
    const where = `${KIND_LABEL[item.kind] ?? item.kind}${item.chatKey ? ` ${item.chatKey}` : ''}`
    const suppressed = item.suppressedBefore ? `（之前一分钟内还拦过 ${item.suppressedBefore} 次，没逐条记）` : ''
    return [el('div', { text: `${where} 调用 ${item.tool}，等级「${TIER_LABEL[item.tier] ?? item.tier}」${suppressed}` }), el('div', { class: 'sub', text: item.reason })]
  }
  if (item.type === 'policy') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    return [
      el('div', { text: `${ACTOR_LABEL[item.actor] ?? item.actor}改了 ${changes.length} 处` }),
      changes.length ? el('ul', {}, changes.map(change => el('li', { class: 'sub mono', text: `${change.group}.${change.key}：${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}` }))) : null,
    ]
  }
  if (item.type === 'persona') {
    const verb = { create: '新建', update: '修改', delete: '删除' }[item.action] ?? item.action
    const extra = item.action === 'update' ? `，${item.enabled ? '启用' : '未启用'}，绑定 ${item.bindings?.length ?? 0} 处` : item.name ? `「${item.name}」` : ''
    return [el('div', { text: `${ACTOR_LABEL[item.actor] ?? item.actor}${verb}了人格 ${item.persona}${extra}` })]
  }
  if (item.type === 'skill') {
    const verb = item.action === 'delete' ? '删除了' : `把状态改成「${item.status}」、可见范围「${item.visibility === 'shared' ? '共享' : '只给自己'}」`
    return [el('div', { text: `${ACTOR_LABEL[item.actor] ?? item.actor}${verb}：${item.skill}` })]
  }
  return [el('div', { class: 'mono small', text: JSON.stringify(item) })]
}

export async function renderAudit(view, { signal }) {
  const { items } = await api('GET', '/audit?limit=500')
  if (signal.aborted) return
  clear(view)
  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: '审计' }),
      el('p', { class: 'muted', text: '权限修改、被拦下的工具调用、人格和技能的变化都记在这里（同一个会话一分钟内对同一个工具的重复拒绝只记一次）。文件在状态目录的 audit.jsonl。' }))))
  const filter = select([['all', '全部'], ...Object.entries(TYPE_LABEL)], 'all')
  const body = el('tbody', {})
  const draw = () => {
    clear(body)
    const rows = items.filter(item => filter.value === 'all' || item.type === filter.value)
    if (rows.length === 0) {
      body.append(el('tr', {}, el('td', { colspan: 3, class: 'empty', text: '没有记录。' })))
      return
    }
    for (const item of rows) {
      body.append(el('tr', {},
        el('td', { class: 'mono small', text: fmtTime(item.at) }),
        el('td', {}, el('span', { class: `badge ${item.type === 'deny' ? 'ok' : item.type === 'policy' ? 'warn' : ''}`, text: TYPE_LABEL[item.type] ?? item.type })),
        el('td', {}, describe(item))))
    }
  }
  filter.addEventListener('change', draw)
  draw()
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: `最近 ${items.length} 条` }), filter),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['时间', '类型', '内容'].map(text => el('th', { text })))),
      body))))
}
