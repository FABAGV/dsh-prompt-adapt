/**
 * 模式 3 —— 提示词大厅。
 *
 * ## 宿主侧在这里只做一件事：提供一个链接
 *
 * 需求原文：模式 3 只是一个 `查看网友提示词 ↗` 链接，**不抓取、不缓存、不鉴权**。
 * 所以本模块没有 `fetch`、没有缓存、没有凭据读取 —— 只有一个字符串常量
 * 和一个"配没配"的判定函数。这是**有意的边界**，不是没写完。
 *
 * 模式 3 也**不参与"当前生效画像文本"的计算**（那是 `lib/state.js` 的
 * `effective()`，只在模式 1 / 模式 2 之间二选一）。
 *
 * ## 空值的语义
 *
 * `''`（空串）= **未配置**。此时：
 *   - `isHallConfigured()` → `false`
 *   - `GET /state` 返回的 `hallUrl` 是 `null`
 *   - 界面据此**不显示这个入口**，而不是显示一个点不开的死链
 *
 * 真实地址用户尚未提供，所以这里保持占位（空串）。
 * 需要启用时把 `PROMPT_HALL_URL` 改成真实 URL 即可，其它代码都不用动。
 */

/** 提示词大厅的外链。**空串 = 未配置**（界面不显示该入口）。 */
export const PROMPT_HALL_URL = ''

/**
 * 是否已配置大厅链接。
 * @param {string} [value] 默认查模块常量
 * @returns {boolean}
 */
export function isHallConfigured(value = PROMPT_HALL_URL) {
  return typeof value === 'string' && value.trim().length > 0
}
