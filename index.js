const express = require('express');
const fetch = require('node-fetch'); // v2
const crypto = require('crypto');
const xml2js = require('xml2js');
const tcb = require('@cloudbase/node-sdk');

const router = express.Router();

// 环境变量
const WX_APPID = process.env.WX_APPID;   // 服务号 AppID
const WX_SECRET = process.env.WX_SECRET; // 服务号 AppSecret
const WX_TOKEN = process.env.WX_TOKEN;   // 公众号服务器配置里配置的 Token
const ENV_ID = process.env.TCB_ENV_ID || process.env.WX_ENV || process.env.ENV_ID;

// 云开发数据库初始化
const app = tcb.init({ env: ENV_ID });
const db = app.database();

// 简单内存缓存 access_token（生产可改 Redis/KV）
let tokenCache = { token: '', expireAt: 0 };

// 工具方法
async function httpGet(url) {
  const res = await fetch(url);
  const txt = await res.text();
  try { return JSON.parse(txt); } catch (_) { return { raw: txt }; }
}
async function httpPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body || {})
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch (_) { return { raw: txt }; }
}

// 统一获取 access_token（服务端发起）
async function getAccessToken() {
  // 命中缓存直接返回
  if (tokenCache.token && Date.now() < tokenCache.expireAt) {
    return tokenCache.token;
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${WX_SECRET}`;
  const json = await fetch(url).then(r => r.json());
  if (json && json.access_token) {
    // 预留100秒提前过期
    const expires = json.expires_in ? (json.expires_in - 100) : 7000;
    tokenCache = {
      token: json.access_token,
      expireAt: Date.now() + expires * 1000
    };
    return tokenCache.token;
  }
  return '';
}

// ========== 1) 生成带参临时二维码（scene_str=bind_{code}） ==========
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
    const resp = await httpPost(url, body);

    if (!resp || !resp.ticket) {
      return res.json({ ok: false, msg: 'create qrcode failed', resp });
    }
    const qrcodeUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(resp.ticket)}`;
    return res.json({ ok: true, qrcodeUrl, expire_seconds: resp.expire_seconds || expire_seconds });
  } catch (e) {
    return res.json({ ok: false, msg: e.message || 'exception' });
  }
});

// ========== 2) 公众号服务器配置：签名校验 ==========
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

router.get('/wx/callback', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query || {};
  const sign = sha1([WX_TOKEN, timestamp, nonce].sort().join(''));
  res.send(sign === signature ? echostr : 'invalid');
});

// ========== 3) 公众号回调处理：subscribe/scan，解析 bind_{code} 写回跑腿员表 ==========
router.post('/wx/callback', express.text({ type: ['text/xml', 'application/xml', '*/*'] }), async (req, res) => {
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
    // 微信要求尽快响应
    res.send('success');
  } catch (e) {
    res.send('success');
  }
});

// ========== 4) 统一代理：获取 access_token ==========
router.get('/api/official/token', async (req, res) => {
  try {
    const token = await getAccessToken();
    if (!token) return res.status(500).json({ ok: false, msg: 'get token failed' });
    return res.json({ ok: true, data: { access_token: token } });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

// ========== 5) 统一代理：发送服务号模板消息 ==========
router.post('/api/official/template/send', express.json(), async (req, res) => {
  try {
    let token = tokenCache.token;
    if (!token) {
      token = await getAccessToken();
      if (!token) return res.status(500).json({ ok: false, msg: 'get token failed' });
    }
    const url = `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`;
    const resp = await httpPost(url, req.body || {});
    // 直接返回微信原始响应（errcode===0 即成功）
    return res.json(resp);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

// ========== 6)（可选）统一代理：粉丝列表与批量用户信息（用于 unionid 反查） ==========
router.get('/api/official/user/get', async (req, res) => {
  try {
    const next_openid = req.query.next_openid || '';
    let token = tokenCache.token || await getAccessToken();
    if (!token) return res.status(500).json({ ok: false, msg: 'get token failed' });
    const url = `https://api.weixin.qq.com/cgi-bin/user/get?access_token=${token}&next_openid=${next_openid}`;
    const resp = await httpGet(url);
    return res.json(resp);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

router.post('/api/official/user/batchget', express.json(), async (req, res) => {
  try {
    let token = tokenCache.token || await getAccessToken();
    if (!token) return res.status(500).json({ ok: false, msg: 'get token failed' });
    const url = `https://api.weixin.qq.com/cgi-bin/user/info/batchget?access_token=${token}`;
    const resp = await httpPost(url, req.body || {});
    return res.json(resp);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

module.exports = router;
