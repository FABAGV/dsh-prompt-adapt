/**
 * `ctx.llm.stream()` 的薄封装：人格、技能这些后台任务共用。
 *
 * 失败不抛在 stream 里，而是变成一个 `finish` chunk（`reason.kind === 'error'`），
 * 所以必须读完整个流再判 —— 与 `profile.js` 的 `generateProfile()` 同一套处理。
 */

/**
 * 宿主当前的默认模型选择（`agentDefaultModel.currentSelection()`）。拿不到返回 null。
 * @param {any} root cordis 上下文
 * @returns {{provider:string, model:string}|null}
 */
export function resolveDefaultModel(root) {
  try {
    const service = typeof root?.get === 'function' ? root.get('agentDefaultModel') : undefined
    if (!service || typeof service.currentSelection !== 'function') return null
    const selection = service.currentSelection()
    if (!selection) return null
    const provider = selection.provider ?? selection.config?.provider
    const model = selection.model ?? selection.config?.model
    if (!provider || !model) return null
    return { provider: String(provider), model: String(model) }
  } catch {
    return null
  }
}

/**
 * 跑一次纯文本生成。
 * @param {any} llm `ctx.llm`
 * @param {{provider:string, model:string, system?:string, messages:Array<{role:string, text:string}>,
 *   maxTokens?:number, timeoutMs?:number, signal?:AbortSignal}} input
 * @returns {Promise<{text:string, truncated:boolean}>}
 */
export async function streamText(llm, input) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用（ctx.llm.stream 缺失）')
  if (!input.provider || !input.model) throw new Error('没有可用的 provider/model：请在插件配置里填写，或在 DSH 里选一个默认模型')
  const signals = []
  if (input.signal) signals.push(input.signal)
  if (Number.isFinite(input.timeoutMs) && typeof AbortSignal?.timeout === 'function') signals.push(AbortSignal.timeout(input.timeoutMs))
  const signal = signals.length > 1 && typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0]
  const options = {
    provider: input.provider,
    model: input.model,
    messages: input.messages.map(message => ({
      role: message.role,
      content: [{ type: 'text', text: String(message.text ?? '') }],
    })),
    maxTokens: input.maxTokens ?? 4000,
    signal,
  }
  if (input.system) options.system = input.system
  let text = ''
  let finish = null
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
      if (!text) text += String(chunk.block.text ?? '')
    } else if (chunk?.type === 'finish') finish = chunk
  }
  const kind = finish?.reason?.kind
  if (kind === 'error') throw new Error(`LLM 调用失败: ${finish.reason.failure?.message ?? 'unknown'}`)
  if (kind === 'aborted') throw new Error(`LLM 调用被中止: ${finish.reason.failure?.message ?? 'unknown'}`)
  const truncated = kind === 'max-tokens' || kind === 'maxTokens' || kind === 'length'
  return { text, truncated }
}

/**
 * 从模型回复里取出第一个完整的 JSON 对象（容忍 ```json 代码块与前后废话）。
 * @returns {any} 解析结果；找不到返回 null
 */
export function extractJson(text) {
  const source = String(text ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const candidates = fenced ? [fenced[1], source] : [source]
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, index + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}
