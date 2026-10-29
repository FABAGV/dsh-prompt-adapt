import { api, el, clear, action, toast, waitJob, select, fmtTime, fmtAgo } from './lib.js'
import { setLeaveGuard } from './app.js'

const STATUS_LABEL = { active: ['ok', '启用'], candidate: ['warn', '候选'], disabled: ['', '停用'] }
const SCORE_LABEL = { reusable: '可复用', verified: '已验证', specific: '具体', safe: '安全' }

function scoreBadges(scores) {
  return Object.entries(SCORE_LABEL).map(([key, label]) => {
    const value = scores?.[key] ?? 0
    return el('span', { class: `badge ${value >= 4 ? 'ok' : value >= 3 ? '' : 'bad'}`, text: `${label} ${value}` })
  })
}

function skillEditor(skill, refresh) {
  const description = el('input', { type: 'text', value: skill.description, maxlength: 160 })
  const whenToUse = el('input', { type: 'text', value: skill.whenToUse ?? '', maxlength: 160 })
  const body = el('textarea', { rows: 14, value: skill.body, spellcheck: 'false', class: 'mono' })
  let dirty = false
  const markDirty = () => {
    dirty = true
    save.disabled = false
  }
  for (const input of [description, whenToUse, body]) input.addEventListener('input', markDirty)
  setLeaveGuard(({ silent } = {}) => !dirty || (!silent && confirm('技能的修改还没保存，确定离开吗？')))
  const save = el('button', { class: 'btn btn-primary', type: 'button', text: '保存修改', disabled: true, onclick: action(async () => {
    await api('PATCH', `/skills/${skill.name}`, { description: description.value, whenToUse: whenToUse.value, body: body.value })
    dirty = false
    setLeaveGuard(null)
    toast('已保存。你改过的技能以后不会被自动整理覆盖。')
    await refresh()
  }) })
  const patch = (fields, message) => action(async () => {
    await api('PATCH', `/skills/${skill.name}`, fields)
    toast(message)
    await refresh()
  })
  const [statusKind, statusText] = STATUS_LABEL[skill.status] ?? ['', skill.status]
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', { class: 'mono', text: skill.exposedName }), el('div', { class: 'entry-meta' },
        el('span', { class: `badge ${statusKind}`, text: statusText }),
        el('span', { class: `badge ${skill.visibility === 'shared' ? 'warn' : ''}`, text: skill.visibility === 'shared' ? '可共享给 QQ 会话' : '只给你自己的会话' }),
        skill.editedByUser ? el('span', { class: 'badge accent', text: '你改过' }) : null)),
      el('div', { class: 'btn-row' },
        skill.status !== 'active' ? el('button', { class: 'btn', type: 'button', text: '启用', onclick: patch({ status: 'active' }, '已启用：DSH 的技能目录里能看到它了') }) : null,
        skill.status === 'active' ? el('button', { class: 'btn', type: 'button', text: '停用', onclick: patch({ status: 'disabled' }, '已停用') }) : null,
        skill.visibility === 'owner'
          ? el('button', { class: 'btn', type: 'button', text: '共享给 QQ 会话', onclick: action(async () => {
            if (!confirm('共享后，QQ 群和私聊里的会话也能加载这个技能的全文。确认里面没有私人信息？')) return
            await api('PATCH', `/skills/${skill.name}`, { visibility: 'shared' })
            toast('已共享')
            await refresh()
          }) })
          : el('button', { class: 'btn', type: 'button', text: '取消共享', onclick: patch({ visibility: 'owner' }, '已改回只给你自己的会话') }),
        el('button', { class: 'btn btn-danger btn-ghost', type: 'button', text: '删除', onclick: action(async () => {
          if (!confirm(`删除技能 ${skill.exposedName}？`)) return
          await api('DELETE', `/skills/${skill.name}`)
          toast('已删除')
          await refresh()
        }) }))),
    el('div', { class: 'entry-meta' }, scoreBadges(skill.scores)),
    skill.reason ? el('p', { class: 'muted small', text: `模型的判断：${skill.reason}` }) : null,
    el('label', { text: '描述（平时只有这一句在技能目录里）' }), description,
    el('label', { text: '什么时候用（可选）' }), whenToUse,
    el('label', { text: '正文（模型需要时才加载）' }), body,
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, save),
    skill.evidence?.length ? el('details', {}, el('summary', { text: `依据（${skill.evidence.length}）` }), el('ul', {}, skill.evidence.map(text => el('li', { class: 'small', text })))) : null,
    skill.history?.length ? el('details', {}, el('summary', { text: `历史版本（${skill.history.length}）` }),
      skill.history.map(item => el('div', { class: 'card' },
        el('div', { class: 'muted small', text: `${fmtTime(item.at)} · ${item.reason === 'edit' ? '你改之前' : '自动整理并入之前'}` }),
        el('p', { text: item.description }),
        el('pre', { class: 'block', text: item.body })))) : null,
    el('p', { class: 'muted small', text: `创建于 ${fmtTime(skill.createdAt)} · 更新于 ${fmtAgo(skill.updatedAt)}${skill.model ? ` · ${skill.model}` : ''}` }))
}

export async function renderSkills(view, { signal, params, navigate, rerender }) {
  const data = await api('GET', '/skills')
  if (signal.aborted) return
  clear(view)
  const refresh = async () => rerender()
  const mine = action(async () => {
    const { job } = await api('POST', '/skills/mine')
    toast('开始整理技能，通常要一两分钟')
    const done = await waitJob(job.id, { signal })
    if (!done) return
    if (done.status === 'done') {
      const result = done.result ?? {}
      toast(`整理完成：新启用 ${result.created?.length ?? 0} 个，候选 ${result.candidates?.length ?? 0} 个，并入 ${result.merged?.length ?? 0} 个`)
    } else {
      toast(`整理失败：${done.error}`, 'bad')
    }
    if (!signal.aborted) await refresh()
  }, { busyText: '整理中…' })

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: '技能' }),
      el('p', { class: 'muted', text: '从你自己的会话里把摸索出来的做法整理成 DSH 技能。平时只有名字和一句描述在上下文里，模型需要时才用 skill 工具加载全文。QQ 会话和标成私密的会话不参与整理。' })),
    el('div', { class: 'actions' },
      el('button', { class: 'btn btn-primary', type: 'button', text: '现在整理', disabled: !data.config.enabled || Boolean(data.runningJob), onclick: mine }))))

  if (!data.config.enabled) view.append(el('div', { class: 'notice warn', text: '技能整理在插件配置里关掉了（skills.enabled）。' }))
  const mining = data.mining
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '整理情况' })),
    el('dl', { class: 'kv' },
      el('dt', { text: '自动整理' }), el('dd', { text: data.config.autoMine ? `开（每 ${data.config.minIntervalHours} 小时最多一次，攒够 ${data.config.minNewSessions} 个新会话才跑）` : '关' }),
      el('dt', { text: '可以整理的新会话' }), el('dd', { text: `${data.eligible} 个（至少 ${data.config.minToolCalls} 次工具调用、空闲 10 分钟以上）` }),
      el('dt', { text: '上次整理' }), el('dd', { text: mining.lastRunAt ? fmtTime(mining.lastRunAt) : '还没有' }),
      el('dt', { text: '直接启用的门槛' }), el('dd', { text: `四项自评都不低于 ${data.config.autoActivateScore} 分，否则先当候选` })),
    mining.lastError ? el('div', { class: 'notice bad', text: `上次整理失败：${mining.lastError}` }) : null,
    data.runningJob ? el('div', { class: 'notice', text: `正在整理…${data.runningJob.progress ? `（${data.runningJob.progress}）` : ''}` }) : null,
    mining.reports?.length ? el('details', {}, el('summary', { text: '最近几次整理的结果' }),
      el('ul', {}, mining.reports.map(report => el('li', { class: 'small', text: `${fmtTime(report.at)}${report.auto ? '（自动）' : ''}：看了 ${report.sessions} 个会话，模型提了 ${report.proposals} 个；启用 ${report.created.length}、候选 ${report.candidates.length}、并入 ${report.merged.length}、跳过 ${report.skipped.length}` })))) : null))

  const statusFilter = select([['all', '全部'], ['active', '启用'], ['candidate', '候选'], ['disabled', '停用']], params[1] ?? 'all', value => navigate(`#/skills/${params[0] ?? ''}/${value}`))
  const list = el('div', { class: 'list' })
  const skills = data.skills.filter(skill => statusFilter.value === 'all' || skill.status === statusFilter.value)
  if (skills.length === 0) list.append(el('p', { class: 'empty', text: data.skills.length ? '没有符合条件的技能。' : '还没有技能。' }))
  for (const skill of skills) {
    const [statusKind, statusText] = STATUS_LABEL[skill.status] ?? ['', skill.status]
    list.append(el('button', {
      class: 'list-item',
      type: 'button',
      'aria-current': skill.name === params[0] ? 'true' : 'false',
      onclick: () => navigate(`#/skills/${skill.name}/${statusFilter.value}`),
    },
    el('div', { class: 'title mono', text: skill.exposedName }),
    el('div', { class: 'small', text: skill.description }),
    el('div', { class: 'entry-meta' }, el('span', { class: `badge ${statusKind}`, text: statusText }), skill.visibility === 'shared' ? el('span', { class: 'badge warn', text: '共享' }) : null)))
  }
  const selected = data.skills.find(skill => skill.name === params[0])
  view.append(el('div', { class: 'split' },
    el('div', {}, el('div', { class: 'btn-row', style: 'margin-bottom:8px' }, el('span', { class: 'muted small', text: '显示' }), statusFilter), list),
    selected ? skillEditor(selected, refresh) : el('section', { class: 'card' }, el('p', { class: 'empty', text: data.skills.length ? '从左边选一个技能。' : '整理过一次之后，技能会出现在这里。' }))))
}
