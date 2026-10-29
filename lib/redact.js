/**
 * 脱敏：整理技能、生成人格之前，把会话摘要里的密钥、账号和个人信息换成占位符。
 *
 * 这是"尽量挡住"，不是保证：规则只认常见形状。所以整理出来的技能默认只给你自己的会话用，
 * 要共享给 QQ 会话得在控制台里逐个打开。
 */

const RULES = [
  // 带凭据的 URL：https://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<凭据>@'],
  // 常见服务的令牌格式
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g, '<密钥>'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '<密钥>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<密钥>'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '<密钥>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<密钥>'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '<密钥>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<令牌>'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer <令牌>'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<私钥>'],
  // key=value / key: value 形状的口令
  [/\b((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|auth)\s*["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1<已隐藏>'],
  // 邮箱、手机号
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<邮箱>'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '<手机号>'],
  // 用户目录里的用户名
  [/([A-Za-z]:\\+Users\\+)[^\\/\s"'<>]+/gi, '$1<用户>'],
  [/(\/(?:home|Users)\/)[^/\s"'<>]+/g, '$1<用户>'],
  // 非本机的 IPv4
  [/(?<![\d.])(?!127\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g, '<IP>'],
]

/** 长串的十六进制 / base64 很可能是密钥：混有字母和数字、32 位以上、不含路径分隔符。 */
const LONG_TOKEN = /(?<![A-Za-z0-9_/\\.-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9_/\\.-])/g

/**
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out.replace(LONG_TOKEN, '<长串>')
}
