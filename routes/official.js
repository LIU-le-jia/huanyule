const express = require('express');
const axios = require('axios');

const router = express.Router();

// 从环境变量读取服务号配置
const OFFICIAL_APPID = process.env.OFFICIAL_APPID;
const OFFICIAL_SECRET = process.env.OFFICIAL_SECRET;

// 简单内存缓存 access_token（生产可换 Redis）
let tokenCache = { token: '', expireAt: 0 };

// 统一获取 access_token（走官方接口，但由云托管服务端发起）
// 支持两种来源：query 参数或环境变量；优先用环境变量更安全
router.get('/token', async (req, res) => {
  try {
    const appid = OFFICIAL_APPID || req.query.appid;
    const secret = OFFICIAL_SECRET || req.query.secret;
    if (!appid || !secret) {
      return res.status(400).json({ ok: false, msg: 'appid/secret required' });
    }

    if (tokenCache.token && Date.now() < tokenCache.expireAt) {
      return res.json({ ok: true, data: { access_token: tokenCache.token } });
    }

    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
    const { data } = await axios.get(url, { timeout: 5000 });

    if (data.access_token) {
      // 预留 100 秒提前过期
      tokenCache = {
        token: data.access_token,
        expireAt: Date.now() + (data.expires_in ? (data.expires_in - 100) * 1000 : 7000 * 1000)
      };
      return res.json({ ok: true, data: { access_token: tokenCache.token } });
    }
    return res.status(500).json({ ok: false, msg: 'fetch token failed', resp: data });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

// 统一发送服务号模板消息（转发到官方接口）
router.post('/template/send', async (req, res) => {
  try {
    // 优先使用服务端缓存 token；也支持前端提供 access_token（不推荐）
    let accessToken = req.query.access_token || (tokenCache.token && tokenCache.token);
    if (!accessToken) {
      // 强制用环境变量拉取一次
      const appid = OFFICIAL_APPID;
      const secret = OFFICIAL_SECRET;
      if (!appid || !secret) {
        return res.status(400).json({ ok: false, msg: 'no access_token and no env appid/secret' });
      }
      const urlGet = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
      const { data: tk } = await axios.get(urlGet, { timeout: 5000 });
      if (!tk.access_token) return res.status(500).json({ ok: false, msg: 'token fetch failed', resp: tk });
      accessToken = tk.access_token;
      tokenCache = { token: accessToken, expireAt: Date.now() + (tk.expires_in ? (tk.expires_in - 100) * 1000 : 7000 * 1000) };
    }

    const urlSend = `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`;
    const { data } = await axios.post(urlSend, req.body, { timeout: 5000 });
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

// 可选：粉丝列表
router.get('/user/get', async (req, res) => {
  try {
    const next_openid = req.query.next_openid || '';
    let accessToken = tokenCache.token;
    if (!accessToken) return res.status(400).json({ ok: false, msg: 'token not ready' });
    const url = `https://api.weixin.qq.com/cgi-bin/user/get?access_token=${accessToken}&next_openid=${next_openid}`;
    const { data } = await axios.get(url, { timeout: 5000 });
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

// 可选：批量获取用户信息（用于 unionid 匹配）
router.post('/user/batchget', async (req, res) => {
  try {
    let accessToken = tokenCache.token;
    if (!accessToken) return res.status(400).json({ ok: false, msg: 'token not ready' });
    const url = `https://api.weixin.qq.com/cgi-bin/user/info/batchget?access_token=${accessToken}`;
    const { data } = await axios.post(url, req.body || {}, { timeout: 5000 });
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

module.exports = router;

