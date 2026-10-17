/**
 * 工作笔记（workingNotes）回归：
 *   - 状态结构、合并去重/限长/上限、加载兜底
 *   - 旧画像 3 条项目设计需求的一次性迁移（可逆、幂等）
 *   - normalizeProfile 的 projectNotes 抽取
 *   - 生成提示词确实要求"项目事实写进 projectNotes，不占画像槽位"
 *
 * 运行：node test/working-notes.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { emptyState, appendWorkingNotes, migrateProjectEntries, WORKING_NOTES_CAP, StateStore } = await import(
  pathToFileURL(path.join(HERE, '..', 'lib', 'state.js')).href
)
const { normalizeProfile, buildProfilePrompt } = await import(
  pathToFileURL(path.join(HERE, '..', 'lib', 'profile.js')).href
)

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}${detail ? `  — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ''}`)
  }
}

console.log('1. 空状态与合并')
{
  const state = emptyState()
  check('空状态 workingNotes 是空数组', Array.isArray(state.workingNotes) && state.workingNotes.length === 0)
  check('迁移标记默认 false', state.workingNotesMigrated === false)

  const added = appendWorkingNotes(state, ['项目 A 的入口在 src/a.js', '项目 A 的入口在 src/a.js', '短', '', '项目 B 用 pnpm 管理依赖', 42], 1000)
  check('合并：去重 + 拒绝短文本/非字符串', added === 2 && state.workingNotes.length === 2, `added=${added}`)
  check('合并：记录时间戳', state.workingNotes.every(note => note.at === 1000))
  check('合并：再次合并同一条不重复', appendWorkingNotes(state, ['项目 B 用 pnpm 管理依赖'], 2000) === 0)

  for (let index = 0; index < WORKING_NOTES_CAP + 10; index += 1) {
    appendWorkingNotes(state, [`第 ${index} 条工作笔记，内容足够长`], 3000 + index)
  }
  check(`容量上限 ${WORKING_NOTES_CAP}`, state.workingNotes.length === WORKING_NOTES_CAP, `len=${state.workingNotes.length}`)
  check('超限时丢最旧的、保留最新的', state.workingNotes.at(-1).text.includes(String(WORKING_NOTES_CAP + 9)))
}

console.log('2. 旧画像 3 条项目设计需求的一次性迁移')
{
  const state = emptyState()
  state.profile = {
    version: 3,
    entries: [
      { id: 'n1', category: 'B', claim: '不要让自动画像（模式 1）与自定义提示词（模式 2）同时生效' },
      { id: 'n2', category: 'B', claim: '不要让会被注入系统提示的画像文本无上限增长' },
      { id: 'n3', category: 'D', claim: '材料里同一份「画像归纳器」提示词被重复下发' },
      { id: 'n4', category: 'B', claim: '修 bug 只做最小必要修改，禁止顺手重构' },
      { id: 'n5', category: 'B', claim: '改动本机配置或插件前先说明计划' },
    ],
  }
  const moved = migrateProjectEntries(state, 5000)
  check('迁移 3 条（只匹配铁证，不误伤通用规则）', moved === 3, `moved=${moved}`)
  check('被移走的条目已不在画像里', state.profile.entries.length === 2 && !state.profile.entries.some(entry => entry.id.startsWith('n') && ['n1', 'n2', 'n3'].includes(entry.id)))
  check('文本保留在工作笔记里（不是删除）', state.workingNotes.length === 3 && state.workingNotes.every(note => typeof note.text === 'string'))
  check('通用规则 n4/n5 仍留在画像里', state.profile.entries.some(entry => entry.id === 'n4') && state.profile.entries.some(entry => entry.id === 'n5'))
  check('迁移标记已置位', state.workingNotesMigrated === true)
  check('幂等：第二次不再迁移', migrateProjectEntries(state, 6000) === 0 && state.workingNotes.length === 3)
}

console.log('3. normalizeProfile 的 projectNotes 抽取')
{
  const profile = normalizeProfile(
    {
      entries: [{ id: 'n1', category: 'B', claim: '修 bug 只做最小必要修改', evidence: ['只改必要的一行'], confidence: 'high' }],
      unchangedIds: [],
      deletedIds: [],
      notes: '证据还不够',
      projectNotes: [
        '项目 A 的入口在 src/a.js',
        '项目 A 的入口在 src/a.js',
        '短',
        '项目 B 用 pnpm 管理依赖',
        '路径 C 在 D:/work/c',
        42,
      ],
    },
    { version: 1, evidenceMessages: 10, now: 999, previous: null, provider: 'p', model: 'm', raw: '' },
  )
  check('projectNotes 去重、拒短、拒非字符串、最多 3 条', profile.projectNotes.length === 3, JSON.stringify(profile.projectNotes))
  check('projectNotes 不混进 entries', profile.entries.length === 1 && !profile.entries.some(entry => entry.claim.includes('项目 A')))
  check('projectNotes 是数组（不是旧 notes 字符串）', Array.isArray(profile.projectNotes) && typeof profile.notes === 'string')
}

console.log('4. 生成提示词：项目事实走 projectNotes，不占画像槽位')
{
  const prompt = buildProfilePrompt({
    previousProfile: null,
    messages: [{ index: 1, sessionId: 's', time: Date.now(), text: '继续' }],
    signals: {},
    totalHumanMessages: 1,
    totalSessions: 1,
  })
  check('提示词含 projectNotes 字段', prompt.includes('projectNotes'))
  check('提示词明确 projectNotes 不占画像槽位', prompt.includes('不占画像槽位'))
  check('提示词要求项目/工具/路径类事实不要写进 entries', prompt.includes('不要写进 entries'))
}

console.log('5. StateStore 载入兜底')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-notes-'))
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      mode: 'auto',
      profile: null,
      workingNotes: ['够长的一条工作笔记', { text: '够长的一条工作笔记' }, { text: '另一条工作笔记' }, 42, '短'],
      workingNotesMigrated: 'yes',
    }),
    'utf8',
  )
  const store = new StateStore({ dir, log: null })
  check('载入：只保留字符串/对象 text，去重', store.state.workingNotes.length === 2, JSON.stringify(store.state.workingNotes))
  check('载入：非法迁移标记重置为 false', store.state.workingNotesMigrated === false)
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))
process.exit(fail === 0 ? 0 : 1)
