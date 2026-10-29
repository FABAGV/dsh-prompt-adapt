import { api, el, clear, action, fmtTime, fmtAgo, tierBadge, KIND_LABEL, SKILLS_LABEL } from './lib.js'

const yesNo = value => el('span', { class: `badge ${value ? 'accent' : ''}`, text: value ? '是' : '否' })

function stat(label, value, sub) {
  return el('div', { class: 'card' },
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat', text: value }),
    sub ? el('div', { class: 'muted small', text: sub }) : null)
}

function lastRunLine(lastRun) {
  if (!lastRun?.at) return el('p', { class: 'muted', text: '还没有生成过画像。' })
  if (lastRun.ok === true) {
    const diff = lastRun.diff ?? {}
    return el('p', {}, el('span', { class: 'badge ok', text: '成功' }), ` ${fmtTime(lastRun.at)}：新增 ${diff.added ?? 0}、删除 ${diff.removed ?? 0}、改写 ${diff.modified ?? 0}、未动 ${diff.unchanged ?? 0}`)
  }
  if (lastRun.ok === false) {
    return el('p', {}, el('span', { class: 'badge bad', text: '失败' }), ` ${fmtTime(lastRun.at)}：${lastRun.error ?? '未知错误'}`)
  }
  return el('p', {}, el('span', { class: 'badge', text: '未触发' }), ` ${fmtAgo(lastRun.at)}：${lastRun.reason || '没到阈值'}（这是正常状态）`)
}

export async function renderOverview(view, { signal, navigate }) {
  const data = await api('GET', '/overview')
  if (signal.aborted) return
  clear(view)

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: '概览' }),
      el('p', { class: 'muted', text: `控制台地址 ${data.console?.url ?? '—'}，只接受这台电脑上的访问。` })),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => navigate('#/overview') }),
      el('button', { class: 'btn', type: 'button', text: '更换登录密钥', onclick: action(async () => {
        if (!confirm('换一把新的登录密钥？旧密钥和所有已登录的浏览器都会失效，需要重新登录。')) return
        await api('POST', '/console/rotate-key')
        location.href = '/login'
      }) }))))

  const privacy = data.privacy
  if (!privacy.enforcing) {
    view.append(el('div', { class: 'notice warn', text: '工具门控在插件配置里关掉了：QQ 会话的工具调用只记录、不拦截。要恢复，在 DSH 的插件设置里打开 privacy.enforceTools。' }))
  }
  const looseQq = ['qq-group', 'qq-private'].filter(kind => privacy.effective?.[kind]?.tier === 'full')
  if (looseQq.length > 0) {
    view.append(el('div', { class: 'notice warn' },
      `${looseQq.map(kind => KIND_LABEL[kind]).join('、')}的工具权限是「完全」：能给机器人发消息的人可以让它执行命令。`,
      el('a', { href: '#/privacy', text: '去调整' })))
  }

  const counts = privacy.sessions ?? {}
  const sessionSummary = Object.entries(counts).map(([kind, count]) => `${KIND_LABEL[kind] ?? kind} ${count}`).join(' · ')
  const profile = data.profile
  view.append(el('div', { class: 'grid cols-4' },
    stat('画像', profile.version ? `v${profile.version} · ${profile.entries} 条` : '还没有', profile.mode === 'custom' ? '当前生效：自定义文本' : '当前生效：自动画像'),
    stat('近 24 小时拦下的工具调用', String(privacy.deniedLastDay ?? 0), sessionSummary ? `已发现的会话：${sessionSummary}` : '还没有扫描到会话'),
    stat('人格', `${data.personas.enabled} / ${data.personas.total}`, '启用 / 全部'),
    stat('技能', `${data.skills.active} 个启用`, `${data.skills.candidate} 个候选${data.skills.autoMine ? '' : ' · 自动整理已关'}`)))

  const rules = el('table', {},
    el('thead', {}, el('tr', {}, ['会话类别', '工具权限', '用来学习画像', '注入画像', '能看到的技能'].map(text => el('th', { text })))),
    el('tbody', {}, Object.entries(privacy.effective ?? {}).map(([kind, rule]) => el('tr', {},
      el('td', {}, el('div', { text: KIND_LABEL[kind] ?? kind }),
        kind === 'subagent' ? el('div', { class: 'sub', text: '这一行是你派出的子代理；QQ 会话派出的跟随 QQ 会话，而且只会更严' }) : null),
      el('td', {}, tierBadge(rule.tier)),
      el('td', {}, yesNo(rule.learn)),
      el('td', {}, yesNo(rule.injectProfile)),
      el('td', { text: SKILLS_LABEL[rule.skills] ?? rule.skills })))))
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '各类会话的生效规则' }), el('a', { href: '#/privacy', text: '修改' })),
    el('div', { class: 'table-wrap' }, rules),
    privacy.lastPolicyChange
      ? el('p', { class: 'muted small', text: `上次修改：${fmtTime(privacy.lastPolicyChange.at)}，来自${privacy.lastPolicyChange.actor === 'console' ? '本机控制台' : 'DSH 设置页'}` })
      : el('p', { class: 'muted small', text: '还没有修改过，全部是默认值。' })))

  view.append(el('div', { class: 'grid cols-2' },
    el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: '最近一次画像生成' }), el('a', { href: '#/profile', text: '查看画像' })),
      lastRunLine(profile.lastRun),
      profile.injection
        ? el('p', { class: 'muted small', text: `注入 ${profile.injection.injectedEntries}/${profile.injection.totalEntries} 条，估算 ${profile.injection.estimatedChars} token（预算 ${profile.injection.budgetChars}）` })
        : null),
    el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: '技能整理' }), el('a', { href: '#/skills', text: '查看技能' })),
      el('p', { text: data.skills.lastRunAt ? `上次整理：${fmtTime(data.skills.lastRunAt)}` : '还没有整理过。' }),
      data.skills.lastError ? el('p', { class: 'small' }, el('span', { class: 'badge bad', text: '上次失败' }), ` ${data.skills.lastError}`) : null,
      el('p', { class: 'muted small', text: `QQ 语料库里有 ${data.qq.corpusChats} 个会话可以用来模仿群友。` }))))

  if (data.jobs.length > 0) {
    view.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: '正在进行的后台任务' })),
      el('ul', {}, data.jobs.map(job => el('li', { text: `${job.label}${job.progress ? `：${job.progress}` : ''}（${fmtAgo(job.startedAt)}开始）` })))))
  }
}
