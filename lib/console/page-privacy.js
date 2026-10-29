import { api, el, clear, action, toast, select, checkbox, fmtAgo, tierBadge, KIND_LABEL, TIER_LABEL, SKILLS_LABEL } from './lib.js'
import { setLeaveGuard } from './app.js'

const KINDS = ['owner', 'subagent', 'qq-group', 'qq-private']
const BOOL_OPTIONS = [['', '默认'], ['true', '是'], ['false', '否']]
const MAX_SESSION_ROWS = 150

function tierOptions(allowInherit) {
  const options = [['', '默认'], ['full', TIER_LABEL.full], ['safe', TIER_LABEL.safe], ['chat', TIER_LABEL.chat]]
  if (allowInherit) options.push(['inherit', TIER_LABEL.inherit])
  return options
}

function skillOptions(allowInherit) {
  const options = [['', '默认'], ['all', SKILLS_LABEL.all], ['shared', SKILLS_LABEL.shared], ['none', SKILLS_LABEL.none]]
  if (allowInherit) options.push(['inherit', SKILLS_LABEL.inherit])
  return options
}

/** 把一条规则里的某个字段改成下拉框的值；空串 = 删掉这个字段（跟随默认）。 */
function setField(rule, key, raw) {
  if (raw === '') delete rule[key]
  else if (raw === 'true' || raw === 'false') rule[key] = raw === 'true'
  else rule[key] = raw
}

function boolValue(value) {
  return value === true ? 'true' : value === false ? 'false' : ''
}

function prune(map) {
  for (const [key, rule] of Object.entries(map)) {
    const meaningful = Object.keys(rule).filter(field => field !== 'note')
    if (meaningful.length === 0) delete map[key]
  }
}

export async function renderPrivacy(view, { signal, rerender }) {
  const { policy, sessions } = await api('GET', '/privacy')
  if (signal.aborted) return
  clear(view)
  const original = JSON.stringify(policy.overrides)
  const draft = structuredClone(policy.overrides)
  draft.classes ??= {}
  draft.chats ??= {}
  draft.sessions ??= {}
  draft.extraAllowedTools ??= { chat: [], safe: [] }
  const isDirty = () => {
    const copy = structuredClone(draft)
    prune(copy.classes)
    prune(copy.chats)
    prune(copy.sessions)
    return JSON.stringify(copy) !== original
  }
  const saveButton = el('button', { class: 'btn btn-primary', type: 'button', text: '保存修改', disabled: true })
  const dirtyNote = el('span', { class: 'muted small' })
  const touch = () => {
    const dirty = isDirty()
    saveButton.disabled = !dirty
    dirtyNote.textContent = dirty ? '有未保存的修改' : ''
  }
  setLeaveGuard(({ silent } = {}) => !isDirty() || (!silent && confirm('权限修改还没保存，确定离开吗？')))
  saveButton.addEventListener('click', action(async () => {
    const payload = structuredClone(draft)
    prune(payload.classes)
    prune(payload.chats)
    prune(payload.sessions)
    await api('PUT', '/privacy', { overrides: payload })
    toast('权限已保存，立即生效')
    setLeaveGuard(null)
    rerender()
  }, { busyText: '保存中…' }))

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: '权限' }),
      el('p', { class: 'muted', text: '这里的设置只能在本机控制台或 DSH 自己的设置页里修改，模型没有任何工具能改它。改完立即生效，不用重启。' })),
    el('div', { class: 'actions' }, dirtyNote, saveButton)))

  if (!policy.enforcing) {
    view.append(el('div', { class: 'notice warn', text: '工具门控在插件配置里关掉了（privacy.enforceTools）：下面的「工具权限」现在只记录、不拦截。' }))
  }

  // ── 按会话类别 ────────────────────────────────────────────────
  const classRows = KINDS.map(kind => {
    const rule = (draft.classes[kind] ??= {})
    const def = policy.defaults[kind]
    const effective = policy.effective[kind]
    const inherit = kind === 'subagent'
    const onChange = key => value => {
      setField(rule, key, value)
      touch()
    }
    return el('tr', {},
      el('td', {}, el('div', { text: KIND_LABEL[kind] }), el('div', { class: 'sub', text: policy.classes[kind]?.hint ?? '' })),
      el('td', {}, select(tierOptions(inherit), rule.tier ?? '', onChange('tier')), el('div', { class: 'sub' }, '现在：', tierBadge(effective.tier), ` 默认：${TIER_LABEL[def.tier] ?? def.tier}`)),
      el('td', {}, select(BOOL_OPTIONS, boolValue(rule.learn), onChange('learn')), el('div', { class: 'sub', text: `现在：${effective.learn ? '是' : '否'}` })),
      el('td', {}, select(BOOL_OPTIONS, boolValue(rule.injectProfile), onChange('injectProfile')), el('div', { class: 'sub', text: `现在：${effective.injectProfile ? '是' : '否'}` })),
      el('td', {}, select(skillOptions(inherit), rule.skills ?? '', onChange('skills')), el('div', { class: 'sub', text: `现在：${SKILLS_LABEL[effective.skills] ?? effective.skills}` })))
  })
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '按会话类别' })),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['类别', '工具权限', '用来学习画像和技能', '注入你的画像 / 自定义文本', '能看到的技能'].map(text => el('th', { text })))),
      el('tbody', {}, classRows))),
    el('details', {},
      el('summary', { text: '三个权限等级分别能做什么' }),
      el('ul', {}, ['full', 'safe', 'chat'].map(tier => el('li', {}, el('strong', { text: `${TIER_LABEL[tier]}：` }), policy.tiers[tier]?.summary ?? ''))),
      el('p', { class: 'small muted', text: `仅聊天允许的工具：${policy.allowedTools.chat.join('、')}` }),
      el('p', { class: 'small muted', text: `受限允许的工具：${policy.allowedTools.safe.join('、')}` }))))

  // ── QQ 会话单独设置 ──────────────────────────────────────────
  const knownChats = new Map()
  for (const row of sessions) if (row.chatKey) knownChats.set(row.chatKey, (knownChats.get(row.chatKey) ?? 0) + 1)
  for (const key of Object.keys(draft.chats)) if (!knownChats.has(key)) knownChats.set(key, 0)
  const chatBody = el('tbody', {})
  const renderChatRows = () => {
    clear(chatBody)
    if (knownChats.size === 0) {
      chatBody.append(el('tr', {}, el('td', { colspan: 4, class: 'empty', text: '还没有发现 QQ 会话。QQ 插件建好工作区后会出现在这里，也可以在下面手动添加。' })))
      return
    }
    for (const [key, count] of [...knownChats].sort()) {
      const rule = (draft.chats[key] ??= {})
      const [type, id] = key.split(':')
      chatBody.append(el('tr', {},
        el('td', {}, el('div', { text: `${type === 'group' ? 'QQ 群' : 'QQ 私聊'} ${id}` }), el('div', { class: 'sub', text: `${count} 个会话` })),
        el('td', {}, select(tierOptions(false), rule.tier ?? '', value => { setField(rule, 'tier', value); touch() })),
        el('td', {}, select(BOOL_OPTIONS, boolValue(rule.learn), value => { setField(rule, 'learn', value); touch() })),
        el('td', {}, select(skillOptions(false), rule.skills ?? '', value => { setField(rule, 'skills', value); touch() }))))
    }
  }
  renderChatRows()
  const newChatType = select([['group', 'QQ 群'], ['private', 'QQ 私聊']], 'group')
  const newChatId = el('input', { type: 'text', placeholder: '群号或 QQ 号', inputmode: 'numeric' })
  const addChat = el('button', { class: 'btn', type: 'button', text: '添加', onclick: () => {
    const id = newChatId.value.trim()
    if (!/^\d{1,12}$/.test(id)) {
      toast('群号 / QQ 号只能是 1 到 12 位数字', 'bad')
      return
    }
    const key = `${newChatType.value}:${id}`
    if (!knownChats.has(key)) knownChats.set(key, 0)
    draft.chats[key] ??= {}
    newChatId.value = ''
    renderChatRows()
  } })
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'QQ 会话单独设置' })),
    el('p', { class: 'muted small', text: '比类别设置优先。比如只给你自己的 QQ 私聊开「受限」或「完全」，其余 QQ 会话保持「仅聊天」。' }),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['QQ 会话', '工具权限', '用来学习', '能看到的技能'].map(text => el('th', { text })))),
      chatBody)),
    el('div', { class: 'btn-row' }, newChatType, el('div', { style: 'width:180px' }, newChatId), addChat)))

  // ── 单个会话 ─────────────────────────────────────────────────
  const filter = select([['all', '全部类别'], ...KINDS.map(kind => [kind, KIND_LABEL[kind]])], 'all')
  const sessionBody = el('tbody', {})
  const renderSessionRows = () => {
    clear(sessionBody)
    const rows = sessions.filter(row => filter.value === 'all' || row.kind === filter.value).slice(0, MAX_SESSION_ROWS)
    if (rows.length === 0) {
      sessionBody.append(el('tr', {}, el('td', { colspan: 5, class: 'empty', text: '没有符合条件的会话。' })))
      return
    }
    for (const row of rows) {
      const rule = draft.sessions[row.id] ?? {}
      const ensure = () => (draft.sessions[row.id] ??= rule)
      sessionBody.append(el('tr', {},
        el('td', {},
          el('div', { class: 'ellipsis', title: row.title || row.id, text: row.title || '（无标题）' }),
          el('div', { class: 'sub mono ellipsis', title: row.cwd ?? '', text: `${row.id.slice(0, 8)} · ${row.cwd ?? '—'}` })),
        el('td', {}, el('span', { class: 'badge', text: KIND_LABEL[row.kind] ?? row.kind }), row.chatKey ? el('div', { class: 'sub', text: row.chatKey }) : null),
        el('td', {}, el('div', { text: fmtAgo(row.lastAt) }), el('div', { class: 'sub', text: `${row.userMessages} 条发言` })),
        el('td', {}, select(tierOptions(false), rule.tier ?? '', value => { setField(ensure(), 'tier', value); touch() }), el('div', { class: 'sub' }, '现在：', tierBadge(row.tier))),
        el('td', {}, checkbox('私密（不学习）', rule.private === true, checked => {
          const target = ensure()
          if (checked) target.private = true
          else delete target.private
          touch()
        }), el('div', { class: 'sub', text: row.learn ? '会用来学习' : '不用来学习' }))))
    }
  }
  filter.addEventListener('change', renderSessionRows)
  renderSessionRows()
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '单个会话' }), filter),
    el('p', { class: 'muted small', text: `按最后活动时间排序，最多显示 ${MAX_SESSION_ROWS} 个。标成私密的会话不会被拿来学习画像和技能。` }),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['会话', '类别', '最后活动', '工具权限', '学习'].map(text => el('th', { text })))),
      sessionBody))))

  // ── 额外放行的工具 ───────────────────────────────────────────
  const toolInput = tier => {
    const input = el('input', { type: 'text', value: (draft.extraAllowedTools[tier] ?? []).join(', '), placeholder: '工具名，用逗号分隔' })
    input.addEventListener('input', () => {
      draft.extraAllowedTools[tier] = input.value.split(/[,，\s]+/).map(name => name.trim()).filter(Boolean)
      touch()
    })
    return input
  }
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '额外放行的工具' })),
    el('p', { class: 'muted small', text: '其他插件提供的工具默认不放行。确认某个工具对外部会话安全后，再加到这里。' }),
    el('label', { text: '仅聊天等级额外放行' }), toolInput('chat'),
    el('label', { text: '受限等级额外放行' }), toolInput('safe')))
}
