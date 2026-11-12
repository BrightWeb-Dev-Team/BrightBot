// JavaScript adaptation of AstrBot's weixin_oc client and text send path.
// Upstream source and license: ../vendor/astrbot-weixin/.
import crypto from 'node:crypto';

export const wechatBaseInfo = () => ({ channel_version: 'astrbot' });

export function assertWechatSuccess(payload) {
  for (const key of ['ret', 'errcode']) {
    if (payload[key] != null && Number(payload[key]) !== 0) {
      const error = new Error(`微信接口 ${key}=${payload[key]}: ${payload.errmsg || '请求失败'}`);
      error.code = Number(payload[key]);
      throw error;
    }
  }
  return payload;
}

export async function wechatRequest(config, method, endpoint, {
  query, body, tokenRequired = false, timeout = 40_000, signal,
} = {}) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE())).toString('base64'),
  };
  if (tokenRequired) {
    if (!config.token) throw new Error('微信机器人尚未登录');
    headers.Authorization = `Bearer ${config.token}`;
  }
  const url = new URL(`${String(config.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
  const timeoutSignal = AbortSignal.timeout(timeout);
  const response = await fetch(url, {
    method, headers,
    body: body ? JSON.stringify({ ...body, base_info: wechatBaseInfo() }) : undefined,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
  const payload = text ? JSON.parse(text) : {};
  return assertWechatSuccess(payload);
}

export function buildWechatText(config, userId, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('微信回复正文为空');
  const contextToken = config.contextTokens?.[userId];
  if (!contextToken) throw new Error('缺少微信会话 context_token');
  return {
    base_info: wechatBaseInfo(),
    msg: {
      from_user_id: '', to_user_id: userId,
      client_id: crypto.randomUUID().replaceAll('-', ''),
      message_type: 2, message_state: 2, context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
  };
}
