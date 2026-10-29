import { api, el, append, clear, action, toast, waitJob, fmtTime, CATEGORY_LABEL } from './lib.js'
import { setLeaveGuard } from './app.js'

const EVIDENCE_BADGE = {
  found: ['ok', '引文已核对'],
  partial: ['warn', '部分引文找不到'],
  missing: ['bad', '引文在你的发言里找不到'],
}

function entryRow(entry, ctx) {
  const { state, evidence, refresh } = ctx
  const mark = state.entryMarks.find(item => item.presentId === entry.id && item.status === 'pinned')
  const count = state.injectionLedger?.counts?.[entry.id] ?? 0
  const injectedNow = state.injection?.injectedIds?.includes(entry.id)
  const check = evidence[entry.id]
  const badges = [
    mark ? el('span', { class: 'badge accent', text: '已置顶' }) : null,
    injectedNow ? el('span', { class: 'badge ok', text: '本版注入' }) : null,
    el('span', { class: 'badge', text: count > 0 ? `已注入 ${count} 版` : '从未注入' }),
    el('span', { class: 'badge', text: `${entry.evidence?.length ?? 0} 条引文 · ${entry.confidence ?? 'medium'}` }),
    check && EVIDENCE_BADGE[check.status] ? el('span', { class: `badge ${EVIDENCE_BADGE[check.status][0]}`, text: EVIDENCE_BADGE[check.status][1] }) : null,
  ]
  const post = (verb, body) => action(async () => {
    await api('POST', `/profile/entry/${verb}`, body)
    await refresh()
  })
  const buttons = [
    mark
      ? el('button', { class: 'btn btn-small', type: 'button', text: '取消置顶', onclick: post('unpin', { key: mark.key }) })
      : el('button', { class: 'btn btn-small', type: 'button', text: '置顶', onclick: post('pin', { id: entry.id, claim: entry.claim }) }),
    el('button', { class: 'btn btn-small', type: 'button', text: '封印', title: '扔进垃圾桶，以后也不会再生成', onclick: post('seal', { id: entry.id, claim: entry.claim }) }),
    el('button', { class: 'btn btn-small btn-danger', type: 'button', text: '删除', title: '只删这一次，材料里还有依据时可能再出现', onclick: post('delete', { id: entry.id, claim: entry.claim }) }),
  ]
  const quotes = (entry.evidence ?? []).length > 0
    ? el('details', {}, el('summary', { text: '看引文' }), el('ul', {}, entry.evidence.map(quote => el('li', { class: 'small', text: quote }))))
    : null
  return el('div', { class: 'entry' },
    el('div', {},
      el('div', { class: 'entry-claim', text: entry.claim }),
      el('div', { class: 'entry-meta' }, badges, el('span', { class: 'muted small mono', text: entry.id })),
      quotes),
    el('div', { class: 'btn-row' }, buttons))
}

function markFold(title, marks, buttonsFor) {
  if (marks.length === 0) return null
  return el('details', { class: 'card' },
    el('summary', { text: `${title}（${marks.length} 条）` }),
    marks.map(mark => el('div', { class: 'entry' },
      el('div', {},
        el('div', { class: 'entry-claim', text: mark.entry?.claim ?? mark.key }),
        el('div', { class: 'entry-meta' },
          mark.deleteCount ? el('span', { class: 'badge', text: `删过 ${mark.deleteCount} 次` }) : null,
          el('span', { class: 'badge', text: mark.present ? '当前画像里还有' : '当前画像里没有' }),
          el('span', { class: 'muted small', text: fmtTime(mark.lastAt) }))),
      el('div', { class: 'btn-row' }, buttonsFor(mark)))))
}

export async function renderProfile(view, { signal, rerender }) {
  const { state, evidence } = await api('GET', '/profile')
  if (signal.aborted) return
  clear(view)
  const refresh = async () => rerender()
  const ctx = { state, evidence, refresh }
  const entries = state.profile?.entries ?? []
  let draft = state.customText ?? ''
  let dirty = false
  setLeaveGuard(({ silent } = {}) => !dirty || (!silent && confirm('自定义文本还没保存，确定离开吗？')))

  const regenerate = action(async () => {
    const { job } = await api('POST', '/profile/regenerate')
    toast('已开始重新生成画像，通常要半分钟左右')
    const done = await waitJob(job.id, { signal })
    if (!done) return
    if (done.status === 'done') toast(done.result?.skipped ? `没有生成：${done.result.reason}` : `画像已更新到 v${done.result?.version}`)
    else toast(`生成失败：${done.error}`, 'bad')
    if (!signal.aborted) await refresh()
  }, { busyText: '生成中…' })

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: '画像' }),
      el('p', { class: 'muted', text: state.profile ? `v${state.profile.version} · ${entries.length} 条 · 生成于 ${fmtTime(state.profile.generatedAt)}` : '还没有画像。' })),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'button', text: '重新生成', onclick: regenerate }))))

  const setMode = mode => action(async () => {
    await api('POST', '/profile/mode', { mode })
    await refresh()
  })
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '当前生效' })),
    el('div', { class: 'btn-row' },
      el('button', { class: `btn ${state.mode === 'auto' ? 'btn-primary' : ''}`, type: 'button', text: '模式 1：自动画像', onclick: setMode('auto') }),
      el('button', { class: `btn ${state.mode === 'custom' ? 'btn-primary' : ''}`, type: 'button', text: '模式 2：自定义文本', onclick: setMode('custom') })),
    el('p', { class: 'muted small', text: '两种模式都只注入你自己的会话；QQ 会话和子代理默认不注入（在「权限」页可改）。' })))

  const warnings = Array.isArray(state.lastRun?.warnings) ? state.lastRun.warnings : []
  if (warnings.length > 0) {
    view.append(el('details', { class: 'notice warn' },
      el('summary', { text: `上次生成有 ${warnings.length} 条警告` }),
      el('ul', {}, warnings.map(text => el('li', { class: 'small', text })))))
  }

  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: '实际注入的文本' }),
      state.injection ? el('span', { class: 'muted small', text: `${state.injection.injectedEntries}/${state.injection.totalEntries} 条 · 约 ${state.injection.estimatedChars} token` }) : null),
    state.injectedText ? el('pre', { class: 'block', text: state.injectedText }) : el('p', { class: 'muted', text: '当前没有注入任何文本。' })))

  const missing = Object.values(evidence).filter(item => item.status === 'missing').length
  const profileCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '完整画像' }),
      missing > 0 ? el('span', { class: 'badge bad', text: `${missing} 条的引文在你的发言里找不到` }) : null))
  if (entries.length === 0) profileCard.append(el('p', { class: 'empty', text: '还没有条目。' }))
  for (const category of ['A', 'B', 'C', 'D']) {
    const group = entries.filter(entry => entry.category === category)
    if (group.length === 0) continue
    append(profileCard, [el('div', { class: 'cat-title', text: `${CATEGORY_LABEL[category]}（${group.length}）` }), group.map(entry => entryRow(entry, ctx))])
  }
  view.append(profileCard)

  const marks = state.entryMarks ?? []
  const postMark = (verb, body) => action(async () => {
    await api('POST', `/profile/entry/${verb}`, body)
    await refresh()
  })
  append(view, [
    markFold('垃圾桶（已封印）', marks.filter(mark => mark.status === 'sealed'), mark => [
      el('button', { class: 'btn btn-small', type: 'button', text: '恢复', onclick: postMark('unseal', { key: mark.key }) }),
    ]),
    markFold('已删除', marks.filter(mark => mark.status === 'deleted' && !mark.present), mark => [
      el('button', { class: 'btn btn-small', type: 'button', text: '放回画像', onclick: postMark('restore', { key: mark.key }) }),
      el('button', { class: 'btn btn-small', type: 'button', text: '封印', onclick: postMark('seal', { key: mark.key }) }),
    ]),
  ])

  const textarea = el('textarea', { rows: 10, value: draft, spellcheck: 'false' })
  const saveButton = el('button', { class: 'btn btn-primary', type: 'button', text: '保存', disabled: true })
  textarea.addEventListener('input', () => {
    draft = textarea.value
    dirty = draft !== (state.customText ?? '')
    saveButton.disabled = !dirty
  })
  saveButton.addEventListener('click', action(async () => {
    await api('PUT', '/profile/custom', { text: draft })
    state.customText = draft
    dirty = false
    saveButton.disabled = true
    toast('自定义文本已保存')
  }))
  view.append(el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '模式 2 的自定义文本' }), saveButton),
    textarea,
    el('p', { class: 'field-hint', text: '模式 2 生效时，注入的就是这段文本（原样，不裁剪）。' })))

  const notes = state.workingNotes ?? []
  if (notes.length > 0) {
    view.append(el('details', { class: 'card' },
      el('summary', { text: `工作笔记（${notes.length} 条，不注入）` }),
      el('ul', {}, notes.map(note => el('li', { class: 'small', text: note.text })))))
  }

  const confirmInput = el('input', { type: 'text', placeholder: '输入「清空画像」' })
  view.append(el('details', { class: 'card' },
    el('summary', { text: '危险操作' }),
    el('p', { class: 'small', text: '清空画像会删掉所有条目和注入账本，封印清单保留。历史版本仍在 profile-history 目录里。' }),
    el('div', { class: 'btn-row' }, confirmInput,
      el('button', { class: 'btn btn-danger', type: 'button', text: '清空画像', onclick: action(async () => {
        await api('POST', '/profile/clear', { confirm: confirmInput.value.trim() })
        toast('画像已清空')
        await refresh()
      }) }))))
}
