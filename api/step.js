import httpsRequest from '../lib/http-node.js';
import { ZeppError, asTrimmedString, normalizeSteps, submitSteps } from '../lib/zepp-core.js';

// Vercel Serverless Function 入口。
// 业务逻辑全部在 lib/zepp-core.js，这里只做 Vercel 的 req/res 适配。
export default async function handler(req, res) {
  // 设置跨域 CORS 头，方便网页或快捷指令跨域访问
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  let user = '';
  let password = '';
  let rawSteps = '';
  let allowVirtualDevice = false;

  if (req.method === 'POST') {
    const body = req.body || {};
    user = asTrimmedString(body.user ?? body.account);
    // 密码首尾空格是合法字符，不能像旧代码一样 trim 掉。
    password = typeof (body.password ?? body.pwd) === 'string' ? (body.password ?? body.pwd) : '';
    rawSteps = body.steps ?? body.step ?? '';
    allowVirtualDevice = body.allow_virtual_device === true;
  } else if (req.method === 'GET') {
    const query = req.query || {};
    user = asTrimmedString(query.user ?? query.account);
    password = typeof (query.password ?? query.pwd) === 'string' ? (query.password ?? query.pwd) : '';
    rawSteps = query.steps ?? query.step ?? '';
    allowVirtualDevice = query.allow_virtual_device === 'true';
  } else {
    return res.status(405).json({ code: 405, success: false, message: '只支持 GET 或 POST 请求' });
  }

  let steps;
  try {
    steps = normalizeSteps(rawSteps);
  } catch (error) {
    const status = error.status || 400;
    return res.status(status).json({ code: status, success: false, message: error.message });
  }

  if (!user || !password) {
    return res.status(400).json({
      code: 400,
      success: false,
      message: '请提供 Zepp Life 账号 (user/account) 和密码 (password/pwd)'
    });
  }

  try {
    const data = await submitSteps(httpsRequest, { user, password, steps, allowVirtualDevice });
    return res.status(200).json({
      code: 200,
      success: true,
      message: 'Zepp 数据已提交（微信展示仍取决于官方同步）',
      data
    });
  } catch (error) {
    const status = error instanceof ZeppError ? error.status : 500;
    return res.status(status).json({
      code: status,
      success: false,
      message: error.message || '执行过程出现异常'
    });
  }
}

export { normalizeSteps, createBandData } from '../lib/zepp-core.js';
