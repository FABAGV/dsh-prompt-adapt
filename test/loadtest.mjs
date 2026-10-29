/**
 * 加载自检：用**真实的 cordis Context**（不是手写打桩）跑 `apply()`，
 * 验证：
 *   - 模块能被 import，导出形状符合 loader 期望（default.name / default.Config / default.apply）
 *   - Config schema 能被宿主那条路径（Standard Schema `~standard.validate`）解析
 *   - apply() 能在一个只有最小服务的 Context 上跑完而不抛
 *   - `systemPrompt.section()` 真的被调用，且回调返回的文本随模式变化
 *   - `promptAdapt` 服务真的注册到了 ctx 上
 *   - llm 缺失时不崩（只是不生成画像）
 *
 * ⚠️ 这里**不安装插件、不改用户 profile**，只是在一个隔离的 Context 上试跑。
 * 状态写到临时目录，`DSH_HOME` 也指向临时目录，不碰用户的 ~/.dsh。
 * 运行：
 *   node test/loadtest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-adapt-load-'))
// 关键：把 DSH_HOME 指到临时目录 —— 插件的默认状态目录与会话目录都由它派生，
// 所以这一步同时保证了"不会写用户的 ~/.dsh"和"不会读用户的会话日志"。
process.env.DSH_HOME = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true })

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('='.repeat(72))
console.log('A. 模块导出形状（loader 采集契约）')
console.log('='.repeat(72))
const mod = await import('../lib/index.js')
{
  const plugin = mod.default
  check('默认导出存在', plugin && typeof plugin === 'object')
  check('default.name 是插件名', plugin.name === 'dsh-prompt-adapt', String(plugin.name))
  check('default.apply 是函数', typeof plugin.apply === 'function')
  // 注意：schemastery 的 schema 是**可调用对象**，所以 typeof 是 'function'，不是 'object'。
  check('default.Config 存在（loader 读 runtime.Config，缺了设置页就没有 schema）',
    plugin.Config != null && (typeof plugin.Config === 'object' || typeof plugin.Config === 'function'),
    `typeof=${typeof plugin.Config}`)
  check('命名导出 Config 与 default.Config 是同一个对象', mod.Config === plugin.Config)
  check('Config 暴露 Standard Schema 接口', typeof plugin.Config['~standard']?.validate === 'function')
  check('导出模式 3 的外链常量', typeof mod.PROMPT_HALL_URL === 'string')
  // 用户还没给真实地址，所以现在是空串 = 未配置。
  // 语义要求：未配置时界面不显示死链（由 /state 的 hallUrl === null 保证）。
  check('大厅链接当前是空串（未配置 → 界面不显示入口）', mod.PROMPT_HALL_URL === '',
    JSON.stringify(mod.PROMPT_HALL_URL))
  check('导出 HTTP 前缀常量给客户端半边对齐', typeof mod.API_PREFIX === 'string' && mod.API_PREFIX.startsWith('/'))
}

console.log('')
console.log('='.repeat(72))
console.log('B. Config 走宿主那条路径解析')
console.log('='.repeat(72))
{
  const outcome = mod.Config['~standard'].validate({
    signals: { longToolMs: 12345 },
    profile: { triggerUserMessages: 7 },
  })
  const value = outcome?.value ?? outcome
  check('validate 返回了对象', value && typeof value === 'object')
  check('传入值真的送达（不是被 volatile 清成空对象）', value.signals?.longToolMs === 12345,
    `longToolMs=${value.signals?.longToolMs}`)
  check('未传字段取到 schema 默认值', value.signals?.repeatFailMin === 3,
    `repeatFailMin=${value.signals?.repeatFailMin}`)
  check('嵌套默认值齐全', value.scan?.intervalMs === 120000 && value.inject?.order === 30)
  // 对照：确认没有 volatile 字段（有的话传入值会被丢成 {}）
  check('没有字段被标成 volatile（否则配置会被静默丢弃）',
    !JSON.stringify(value).includes('"~volatile"'))
}

console.log('')
console.log('='.repeat(72))
console.log('C. 在真实 Context 上 apply()')
console.log('='.repeat(72))
{
  const root = new Context()
  /** 记录 systemPrompt.section() 收到的注册内容 */
  const sections = []
  let sectionDisposed = false
  root.provide('systemPrompt', {
    section(definition) {
      sections.push(definition)
      return () => {
        sectionDisposed = true
      }
    },
  })
  // 故意**不**提供 llm / timer / agentDefaultModel：
  // 验证"可选服务缺失时插件仍然完整可用"这条设计约束。
  const intervals = []
  root.provide('timer', {
    interval(callback, delay) {
      intervals.push({ callback, delay })
      return () => {}
    },
  })
  // webServer 也提供，验证"服务 + HTTP 路由"这条完整链路会被装配起来
  const registeredRoutes = []
  root.provide('webServer', {
    register(route) {
      registeredRoutes.push(route)
      return () => {}
    },
  })

  let threw = null
  try {
    mod.default.apply(root, { logLevel: 'error', scan: { scanOnStart: false } })
  } catch (error) {
    threw = error
  }
  check('apply() 没抛异常', threw === null, threw?.message)

  check('systemPrompt.section() 注册了画像段与人格段两段', sections.length === 2, `${sections.length} 次`)
  check('人格段单独注册、紧跟画像段、不做变量插值',
    sections.some(item => item.name === 'dsh-prompt-adapt:persona' && item.order === 31 && item.interpolate === false))
  const section = sections.find(item => item.name === 'dsh-prompt-adapt:effective-profile')
  check('注册名正确', section?.name === 'dsh-prompt-adapt:effective-profile', String(section?.name))
  check('order 是 30（在人格前缀之后、工具说明之前）', section?.order === 30, String(section?.order))
  check('text 是函数（每步求值，不是静态串）', typeof section?.text === 'function')

  check('用 ctx.timer.interval 排程（不是裸 setInterval）', intervals.length === 1 && intervals[0].delay === 120000,
    `delay=${intervals[0]?.delay}`)

  const service = root.get('promptAdapt')
  check('promptAdapt 服务已注册到 ctx 上', service != null, typeof service)
  check('服务暴露了模式互斥的 setMode',
    typeof service?.setMode === 'function' && typeof service?.setCustomText === 'function')

  // HTTP 路由：浏览器里的设置页靠它够到宿主服务
  check('webServer 上注册了 1 条 prefix 路由', registeredRoutes.length === 1, `${registeredRoutes.length} 条`)
  check('路由 kind=prefix、path 是插件专属前缀',
    registeredRoutes[0]?.kind === 'prefix' && registeredRoutes[0]?.path === mod.API_PREFIX,
    String(registeredRoutes[0]?.path))
  check('服务自带 validate() 自检', typeof service?.validate === 'function' && service.validate() === true)
  check('getState() 标出 effectiveSource', ['customText', 'profile'].includes(service.getState().effectiveSource),
    String(service.getState().effectiveSource))
  check('getPromptHallUrl() 返回空串（未配置）', service.getPromptHallUrl() === '')
  check('isPromptHallConfigured() 为 false', service.isPromptHallConfigured() === false)

  // 初始：没有任何画像/自定义文本 → 段文本为空串（空段会被宿主丢掉，不产生 system 节点）
  check('空状态时系统提示段为空串', section.text({}) === '')

  // 模式 2：文本立刻生效
  service.setMode('custom')
  service.setCustomText('请始终用中文回答，不要用 emoji。')
  const customText = section.text({})
  check('切到模式 2 后段文本变成自定义文本',
    customText.includes('请始终用中文回答，不要用 emoji。'), JSON.stringify(customText.slice(0, 60)))
  check('段文本带固定标题，模型能分清这是用户画像不是系统指令',
    customText.includes('关于这个用户'))

  // 字节稳定性：同一状态连续求值必须给同一个字符串
  check('同一状态连续求值返回同一字符串实例（否则每步都会追加 system 节点）',
    section.text({}) === customText)

  // 模式 1：注入来源换成画像
  service.setMode('auto')
  const stateService = root.get('promptAdapt')
  stateService.host.store.state.profile = {
    version: 1,
    entries: [
      { id: 'A1', category: 'A', claim: '习惯一句话下达任务，不写背景铺垫' },
      { id: 'B1', category: 'B', claim: '不要在他没要求时做升级' },
    ],
  }
  const autoText = section.text({})
  check('切到模式 1 后段文本变成画像', autoText.includes('习惯一句话下达任务') && autoText.includes('不要在他没要求时做升级'))
  check('模式 1 时模式 2 的文本不再出现（互斥生效）',
    !autoText.includes('请始终用中文回答'))

  // setMode 后缓存必须失效
  stateService.setMode('custom')
  const backToCustom = section.text({})
  check('setMode 之后渲染缓存失效（否则模型看到的还是旧文本）',
    backToCustom.includes('请始终用中文回答') && !backToCustom.includes('习惯一句话下达任务'))

  // 非法模式必须被拒
  let modeErr = null
  try {
    stateService.setMode('both')
  } catch (error) {
    modeErr = error
  }
  check('非法模式被拒绝（不存在"两个都开"）', modeErr !== null, modeErr?.message)

  // llm 缺失时手动生成必须给出明确错误而不是崩
  const result = await stateService.regenerateNow()
  check('llm 缺失时 regenerateNow 返回结构化失败（不抛）',
    result?.ok === false && /llm 服务不可用/.test(result.error), result?.error)

  // 服务状态里能读到"复制过期"提示
  stateService.markCopied('请始终用中文回答，不要用 emoji。')
  check('markCopied 记下快照', stateService.getState().copiedSnapshot.text !== null)
  stateService.setCustomText('换了一段文本')
  check('文本变了之后 staleCopy 为 true（提示用户重新复制）', stateService.getState().staleCopy === true)

  // 数据落盘位置
  check('状态目录落在 $DSH_HOME/prompt-adapt 下',
    fs.existsSync(path.join(tmpRoot, 'prompt-adapt', 'state.json')),
    path.join(tmpRoot, 'prompt-adapt'))
  check('没有在会话根目录下写任何东西',
    fs.readdirSync(path.join(tmpRoot, 'sessions')).length === 0)

  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'prompt-adapt', 'state.json'), 'utf8'))
  check('落盘的 mode 是合法枚举值', ['auto', 'custom'].includes(saved.mode), String(saved.mode))
  check('落盘含四个信号的字段位', 'lastSignals' in saved)
  check('落盘不含任何形如密钥的字段',
    !/(apiKey|api_key|token|secret|password)/i.test(JSON.stringify(saved)))
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`临时 DSH_HOME：${tmpRoot}`)
console.log('='.repeat(72))

if (fail === 0) {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 清不掉也无所谓 */
  }
}
process.exit(fail === 0 ? 0 : 1)
