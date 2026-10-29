import { api, el, clear, action, toast, select, fmtAgo } from './lib.js'
import { renderPersonaDetail } from './persona-detail.js'

function chatLabel(chat) {
  return `${chat.chatType === 'group' ? 'QQ 群' : 'QQ 私聊'} ${chat.chatId}（${chat.days} 天语料，最近 ${chat.lastDay}）`
}

function createForm(chats, navigate) {
  const name = el('input', { type: 'text', maxlength: 40, placeholder: '比如：毒舌老王、温柔学姐' })
  const description = el('textarea', { rows: 4, maxlength: 2000, placeholder: '几句性格描述：说话风格、口头禅、对人的态度……' })
  const memberFields = el('div', { class: 'hidden' })
  const descriptionLabel = el('label', { text: '性格描述' })
  const descriptionHint = el('div', { class: 'field-hint', text: '模型会把它扩写成一份具体的风格说明。' })
  const chatSelect = select([['', chats.length ? '选择 QQ 会话…' : 'QQ 语料库里还没有会话'], ...chats.map(chat => [chat.key, chatLabel(chat)])], '')
  const days = el('input', { type: 'number', min: 1, max: 365, value: 30 })
  const memberSelect = select([['', '先选择会话']], '')
  const memberInfo = el('div', { class: 'field-hint' })
  const consent = el('input', { type: 'checkbox' })
  let members = []

  const loadMembers = action(async () => {
    members = []
    clear(memberSelect)
    memberSelect.append(el('option', { value: '', text: chatSelect.value ? '正在读取群成员…' : '先选择会话' }))
    memberInfo.textContent = ''
    if (!chatSelect.value) return
    const data = await api('GET', `/qq/members?chat=${encodeURIComponent(chatSelect.value)}&days=${Number(days.value) || 30}`)
    members = data.members
    clear(memberSelect)
    memberSelect.append(el('option', { value: '', text: members.length ? '选择要模仿的人…' : '这段时间里没有发言记录' }))
    for (const member of members) {
      const label = `${member.names[0] ?? member.memberId}（${member.messages} 条${member.senderId ? '' : '，只出现在合并转发里'}）`
      memberSelect.append(el('option', { value: member.memberId, text: label }))
    }
    memberInfo.textContent = `最近 ${days.value} 天共 ${data.records} 条记录。发言少于 5 条的人模仿不出来。`
  })
  chatSelect.addEventListener('change', loadMembers)
  days.addEventListener('change', () => chatSelect.value && loadMembers())

  const kind = select([['description', '按一段性格描述'], ['member', '模仿一位 QQ 群友']], 'description', value => {
    const isMember = value === 'member'
    memberFields.classList.toggle('hidden', !isMember)
    descriptionLabel.textContent = isMember ? '补充说明（可选）' : '性格描述'
    descriptionHint.textContent = isMember ? '比如"他在群里一般很冷淡，只有聊游戏时话多"。' : '模型会把它扩写成一份具体的风格说明。'
  })

  memberFields.append(
    el('label', { text: 'QQ 会话' }), chatSelect,
    el('label', { text: '读取最近多少天' }), el('div', { style: 'width:120px' }, days),
    el('label', { text: '要模仿的人' }), memberSelect, memberInfo,
    el('div', { class: 'notice warn', style: 'margin-top:12px' },
      el('p', { text: '模仿真人之前请先征得对方同意。生成的人格会在系统提示里写明"你不是本人、不冒充本人、不编造本人的经历和隐私"。' }),
      el('label', { class: 'inline' }, consent, '我已征得对方同意，只在合适的场合使用')))

  const submit = el('button', { class: 'btn btn-primary', type: 'button', text: '创建并生成' })
  submit.addEventListener('click', action(async () => {
    const isMember = kind.value === 'member'
    const member = members.find(item => item.memberId === memberSelect.value)
    const [chatType, chatId] = chatSelect.value.split(':')
    const body = {
      name: name.value.trim(),
      kind: kind.value,
      description: description.value.trim(),
      ...(isMember ? {
        source: { chatType, chatId, memberId: memberSelect.value, memberName: member?.names?.[0] ?? '', days: Number(days.value) || 30 },
        consent: consent.checked,
      } : {}),
    }
    const { persona } = await api('POST', '/personas', body)
    try {
      await api('POST', `/personas/${persona.id}/generate`)
      toast('已创建，正在生成风格说明')
    } catch (error) {
      toast(`已创建，但没能开始生成：${error.message}`, 'bad')
    }
    navigate(`#/persona/${persona.id}`)
  }, { busyText: '创建中…' }))

  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '新建人格' })),
    el('label', { text: '名字' }), name,
    el('label', { text: '怎么来' }), kind,
    memberFields,
    descriptionLabel, description, descriptionHint,
    el('div', { class: 'btn-row', style: 'margin-top:14px' }, submit,
      el('button', { class: 'btn btn-ghost', type: 'button', text: '取消', onclick: () => navigate('#/persona') })))
}

export async function renderPersonas(view, ctx) {
  const { signal, params, navigate } = ctx
  const [{ personas }, { chats }] = await Promise.all([api('GET', '/personas'), api('GET', '/qq/chats')])
  if (signal.aborted) return
  clear(view)
  const selected = params[0] ?? null

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: '人格' }),
      el('p', { class: 'muted', text: '以一段性格描述，或一位 QQ 群友的说话方式为目标，生成风格说明；在这里试聊、标出哪里不像，再按反馈修订。只注入你绑定的会话。' })),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'button', text: '新建人格', onclick: () => navigate('#/persona/new') }))))

  const list = el('div', { class: 'list' })
  if (personas.length === 0) list.append(el('p', { class: 'empty', text: '还没有人格。' }))
  for (const persona of personas) {
    const version = persona.versions.find(item => item.v === persona.activeVersion)
    list.append(el('button', {
      class: 'list-item',
      type: 'button',
      'aria-current': persona.id === selected ? 'true' : 'false',
      onclick: () => navigate(`#/persona/${persona.id}`),
    },
    el('div', { class: 'title', text: persona.name }),
    el('div', { class: 'entry-meta' },
      el('span', { class: `badge ${persona.enabled ? 'ok' : ''}`, text: persona.enabled ? '启用中' : '未启用' }),
      el('span', { class: 'badge', text: persona.kind === 'member' ? '模仿群友' : '按描述' }),
      persona.runningJob ? el('span', { class: 'badge accent', text: '生成中' }) : null,
      el('span', { class: 'muted small', text: version ? `v${version.v} · ${fmtAgo(persona.updatedAt)}` : '还没有版本' }))))
  }

  const right = el('div', {})
  view.append(el('div', { class: 'split' }, el('div', {}, list), right))
  if (selected === 'new') {
    right.append(createForm(chats, navigate))
  } else if (selected) {
    if (!personas.some(item => item.id === selected)) {
      right.append(el('div', { class: 'notice bad', text: '找不到这个人格，可能已被删除。' }))
      return
    }
    await renderPersonaDetail(right, selected, { ...ctx, chats })
  } else {
    right.append(el('section', { class: 'card' },
      el('p', { class: 'empty', text: personas.length ? '从左边选一个人格。' : '点「新建人格」开始。' })))
  }
}
