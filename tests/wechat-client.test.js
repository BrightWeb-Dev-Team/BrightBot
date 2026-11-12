import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildWechatText, wechatRequest } from '../server/wechat-client.js';

test('账号使用各自的凭据和会话，发送格式符合 AstrBot 文本路径', async () => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.end('{"ret":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await Promise.all(['A', 'B'].map(async token => {
      const config = { baseUrl, token, contextTokens: { user: `context-${token}` } };
      await wechatRequest(config, 'POST', 'ilink/bot/sendmessage', {
        tokenRequired: true, body: buildWechatText(config, 'user', '测试回复'),
      });
    }));
    for (const {auth, body} of received) {
      assert.equal(body.msg.context_token, `context-${auth.slice(7)}`);
      assert.equal(body.msg.item_list[0].text_item.text, '测试回复');
      assert.equal(body.base_info.channel_version, 'astrbot');
      assert.equal(body.msg.message_type, 2);
      assert.equal(body.msg.message_state, 2);
      assert.match(body.msg.client_id, /^[a-f0-9]{32}$/);
    }
    assert.equal(received.length, 2);
    assert.notEqual(received[0].body.msg.client_id, received[1].body.msg.client_id);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('拒绝空正文、缺少上下文以及业务错误', async () => {
  assert.throws(() => buildWechatText({}, 'user', '内容'), /context_token/);
  assert.throws(() => buildWechatText({}, 'user', undefined), /正文为空/);
  const { assertWechatSuccess } = await import('../server/wechat-client.js');
  assert.throws(() => assertWechatSuccess({ ret: -14, errmsg: 'session timeout' }), /-14/);
  assert.throws(() => assertWechatSuccess({ ret: 0, errcode: 1 }), /errcode/);
});
