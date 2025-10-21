const express = require('express');
const fetch = require('node-fetch'); // v2
const crypto = require('crypto');
const xml2js = require('xml2js');
const tcb = require('@cloudbase/node-sdk'); const router = express.Router(); const WX_APPID = process.env.WX_APPID;   // 服务号 AppID
const WX_SECRET = process.env.WX_SECRET; // 服务号 AppSecret
const WX_TOKEN = process.env.WX_TOKEN;   // 自定义字符串，和公众号后台“服务器配置”的 Token 一致 const ENV_ID = process.env.TCB_ENV_ID || process.env.WX_ENV || process.env.ENV_ID;
const app = tcb.init({ env: ENV_ID });
const db = app.database(); async function getAccessToken() {
const url =  `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${WX_SECRET} `;
const json = await fetch(url).then(r => r.json());
return json && json.access_token ? json.access_token : '';
} 
// 1) 生成带参临时二维码（scene_str=bind_{code}）
router.post('/api/official/qrcode/create', express.json(), async (req, res) => {
try {
const { scene_str, expire_seconds = 1800 } = req.body || {};
if (!scene_str) return res.json({ ok: false, msg: 'scene_str required' }); 
const token = await getAccessToken();
if (!token) return res.json({ ok: false, msg: 'get token failed' });

const url = `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${token}`;
const body = {
  expire_seconds,
  action_name: 'QR_STR_SCENE',
  action_info: { scene: { scene_str } }
};
const resp = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}).then(r => r.json());

if (!resp || !resp.ticket) {
  return res.json({ ok: false, msg: 'create qrcode failed', resp });
}
const qrcodeUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(resp.ticket)}`;
return res.json({ ok: true, qrcodeUrl, expire_seconds: resp.expire_seconds || expire_seconds });
   } catch (e) {
return res.json({ ok: false, msg: e.message || 'exception' });
}
}); 
// 2) 公众号服务器配置：签名校验
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
router.get('/wx/callback', (req, res) => {
const { signature, timestamp, nonce, echostr } = req.query || {};
const sign = sha1([WX_TOKEN, timestamp, nonce].sort().join(''));
res.send(sign === signature ? echostr : 'invalid');
});
// 3) 公众号回调处理：subscribe/scan，解析 bind_{code} 写回跑腿员表
router.post('/wx/callback', express.text({ type: '/' }), async (req, res) => {
try {
const parsed = await xml2js.parseStringPromise(req.body, { explicitArray: false });
const msg = parsed && parsed.xml ? parsed.xml : {};
const event = (msg.Event || '').toLowerCase();   // subscribe | scan
const officialOpenid = msg.FromUserName;
let key = msg.EventKey || '';                    // 可能是 qrscene_bind_XXXX 或 bind_XXXX
if (key.startsWith('qrscene_')) key = key.substring('qrscene_'.length); 
  if ((event === 'subscribe' || event === 'scan') && key.startsWith('bind_')) {
  const code = key.substring('bind_'.length);
  const m = await db.collection('official_bind_codes').where({ code, used: false }).get();
  const row = m.data && m.data[0];
  if (row && row.mpOpenid) {
    await db.collection('delivery_staff').where({ _openid: row.mpOpenid }).update({
      data: { officialOpenid, updateTime: db.serverDate() }
    });
    await db.collection('official_bind_codes').doc(row._id).update({
      data: { used: true, usedAt: db.serverDate() }
    });
  }
}
res.send('success'); // 必须尽快返回
   } catch (e) {
res.send('success');
}
}); module.exports = router;
