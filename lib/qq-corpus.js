/**
 * 只读访问 dsh-whale-inurqq 的 QQ 语料库，给"模仿群友"用。
 *
 * 语料位置固定在 `$DSH_HOME/dsh-whale-inurqq/corpus/<group|private>-<号>/<YYYY-MM-DD>.jsonl`
 * （那边硬编码，不跟随 stateDir）。每行一条记录：
 *   `{kind:'message', ts, chatType, chatId, chatName, messageId, senderId, senderName, text, segments}`
 *   `{kind:'forward', …, text:'', forwardId, nodes:[{s:发言人名, t?:毫秒, x:文本}]}`
 * 会话日志里只有 @ 机器人的那部分群消息，完整群聊只在这里。本模块绝不写这个目录。
 */
import fs from 'node:fs'
import path from 'node:path'

const CHAT_DIR = /^(group|private)-(\d{1,12})$/
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const TRIAGE_TAIL = /\n*\[分诊[:：][^\]]*\][\s\S]*$/
const MAX_FILE_BYTES = 8 * 1024 * 1024

export function corpusRoot(dshHome) {
  return path.join(dshHome, 'dsh-whale-inurqq', 'corpus')
}

/** 语料库里有哪些 QQ 会话。目录不存在时返回空数组。 */
export function listCorpusChats(root) {
  let names
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const chats = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const match = CHAT_DIR.exec(entry.name)
    if (!match) continue
    const days = dayFiles(path.join(root, entry.name))
    if (days.length === 0) continue
    let bytes = 0
    for (const day of days) bytes += day.bytes
    chats.push({
      chatType: match[1],
      chatId: match[2],
      key: `${match[1]}:${match[2]}`,
      days: days.length,
      firstDay: days[0].day,
      lastDay: days.at(-1).day,
      bytes,
    })
  }
  return chats.sort((a, b) => b.lastDay.localeCompare(a.lastDay) || a.key.localeCompare(b.key))
}

function dayFiles(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const match = DAY_FILE.exec(name)
    if (!match) continue
    try {
      const stat = fs.statSync(path.join(dir, name))
      if (stat.isFile()) out.push({ day: match[1], file: path.join(dir, name), bytes: stat.size })
    } catch {
      /* 文件刚被清理掉 */
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day))
}

/**
 * 读一个 QQ 会话最近若干天的记录（时间升序）。合并转发里的节点展开成普通消息
 * （`senderId` 为空，只有名字），标 `forwarded: true`。
 * @param {string} root
 * @param {{chatType:string, chatId:string, days?:number, maxRecords?:number}} options
 */
export function readChatRecords(root, { chatType, chatId, days = 30, maxRecords = 20000 }) {
  if (!['group', 'private'].includes(chatType) || !/^\d{1,12}$/.test(String(chatId))) return []
  const dir = path.join(root, `${chatType}-${chatId}`)
  const files = dayFiles(dir).slice(-Math.max(1, Math.min(365, Number(days) || 30)))
  const records = []
  for (const { file, bytes } of files) {
    if (bytes > MAX_FILE_BYTES) continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record?.kind === 'message') {
        const body = cleanText(record.text)
        if (!body) continue
        records.push({
          ts: Number(record.ts) || 0,
          senderId: record.senderId != null ? String(record.senderId) : '',
          senderName: String(record.senderName ?? '').slice(0, 60),
          text: body,
          forwarded: false,
        })
      } else if (record?.kind === 'forward' && Array.isArray(record.nodes)) {
        for (const node of record.nodes) {
          const body = cleanText(node?.x)
          if (!body) continue
          records.push({
            ts: Number(node?.t) || Number(record.ts) || 0,
            senderId: '',
            senderName: String(node?.s ?? '').slice(0, 60),
            text: body,
            forwarded: true,
          })
        }
      }
    }
  }
  records.sort((a, b) => a.ts - b.ts)
  return records.length > maxRecords ? records.slice(-maxRecords) : records
}

/** 去掉 QQ 插件追加的分诊尾巴；纯表情/图片占位的消息返回空串。 */
function cleanText(text) {
  if (typeof text !== 'string') return ''
  const body = text.replace(TRIAGE_TAIL, '').replace(/\r/g, '').trim()
  if (!body || /^(\[[^\]]{1,12}\]\s*)+$/.test(body)) return ''
  return body
}

/**
 * 群成员统计：按发言条数降序。合并转发里只有名字的发言人用 `name:<名字>` 当 id。
 * @returns {Array<{memberId:string, senderId:string, names:string[], messages:number, firstTs:number, lastTs:number}>}
 */
export function listMembers(records) {
  const members = new Map()
  for (const record of records) {
    const memberId = memberIdOf(record)
    if (!memberId) continue
    let member = members.get(memberId)
    if (!member) {
      member = { memberId, senderId: record.senderId, names: [], messages: 0, firstTs: record.ts, lastTs: record.ts }
      members.set(memberId, member)
    }
    member.messages += 1
    member.lastTs = Math.max(member.lastTs, record.ts)
    member.firstTs = Math.min(member.firstTs, record.ts)
    if (record.senderName && !member.names.includes(record.senderName) && member.names.length < 5) member.names.push(record.senderName)
  }
  return [...members.values()].sort((a, b) => b.messages - a.messages)
}

export function memberIdOf(record) {
  if (record.senderId) return record.senderId
  return record.senderName ? `name:${record.senderName}` : ''
}

/**
 * 取一个成员的发言样本，每条带一句"前文"（上一条别人的发言），让模型看到他怎么接话。
 * 从最新的往回取，直到条数或字数用完；返回时按时间升序。
 * @param {object[]} records `readChatRecords()` 的结果
 * @param {string} memberId
 * @param {{maxMessages?:number, maxChars?:number, maxMessageChars?:number}} [options]
 */
export function memberSamples(records, memberId, { maxMessages = 300, maxChars = 30000, maxMessageChars = 300 } = {}) {
  const out = []
  let chars = 0
  const seen = new Set()
  for (let index = records.length - 1; index >= 0 && out.length < maxMessages; index -= 1) {
    const record = records[index]
    if (memberIdOf(record) !== memberId) continue
    const text = clip(record.text, maxMessageChars)
    if (seen.has(text)) continue
    seen.add(text)
    let context = ''
    for (let back = index - 1; back >= 0 && back >= index - 5; back -= 1) {
      if (memberIdOf(records[back]) !== memberId) {
        context = clip(records[back].text, 120)
        break
      }
    }
    const cost = text.length + context.length
    if (chars + cost > maxChars && out.length > 0) break
    chars += cost
    out.push({ ts: record.ts, context, text })
  }
  return out.reverse()
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
