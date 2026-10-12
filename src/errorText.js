// src/errorText.js
// Day 23 安全审计修复：把「三类错误」统一成中文提示，杜绝向用户泄露英文 / 技术错误。
//
// 设计克制（今日不做「异常框架」）：只做「分类 + 取文案」两件事，调用方仍照常 try/catch。
// 判定只看「信号」——错误名、契约错误码、HTTP 状态、消息关键字——
// 不依赖具体文案，所以服务端文案改了也不会误判。

export const ERR_TEXT = {
  // 输入错：校验未通过。服务端已给具体中文原因时（见 friendlyError）优先用它。
  input: '输入有误，请检查后重试',
  // 网络错：请求发不出去 / 超时 / 离线。
  network: '网络连接异常，请检查网络后重试',
  // 服务端错：其余非 2xx（5xx、403、401、初始化失败等）—— 不暴露技术细节。
  server: '服务暂时不可用，请稍后再试',
}

/**
 * 把任意错误归到三类之一。
 * @param {Error} [err]
 * @returns {'input'|'network'|'server'}
 */
export function classifyError(err) {
  if (!err) return 'server'
  const name = err.name || ''
  const code = err.code || ''
  const status = typeof err.status === 'number' ? err.status : 0
  const msg = err.message || ''
  const hay = `${name} ${code} ${status} ${msg}`

  // 网络层：浏览器 fetch 失败抛 TypeError（"Failed to fetch" 在 message 里），
  // 超时是 AbortError，或文案含「超时」。
  if (
    name === 'TypeError' ||
    name === 'AbortError' ||
    /Failed to fetch|NetworkError|network|timeout|超时/i.test(hay)
  ) {
    return 'network'
  }

  // 输入错：契约 422 VALIDATION_FAILED，或服务端校验中文已点名「缺字段 / 整数 / 越界 / 格式」。
  if (
    code === 'VALIDATION_FAILED' ||
    /\b422\b|缺少必填|必须是整数|必须在|越界|格式(不|错)|无效/.test(hay)
  ) {
    return 'input'
  }

  // 其余（4xx 非 422、5xx、初始化失败）—— 服务端错，不暴露技术细节。
  return 'server'
}

/**
 * 取面向用户的中文提示。
 * 输入错优先用服务端给的具体中文原因（它本来就是中文、且更可操作）；
 * 其它类别一律用固定文案，绝不把英文 / HTTP 状态号透给用户。
 * @param {Error} [err]
 * @returns {string}
 */
export function friendlyError(err) {
  const type = classifyError(err)
  if (type === 'input' && err && err.message && /[一-龥]/.test(err.message)) {
    return err.message
  }
  return ERR_TEXT[type]
}
