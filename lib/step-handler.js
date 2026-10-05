import { ZeppError, asTrimmedString, normalizeSteps, submitSteps } from './zepp-core.js';

// 与平台无关的“Request -> Response”处理逻辑。
// Vercel 之外的两个入口（Cloudflare Worker、Pages Functions）都复用它，
// 区别只是传入的底层 request 实现。
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS
    }
  });
}

function readParams(source, key, alias) {
  return source[key] ?? source[alias];
}

export async function handleStepRequest(request, requestImpl) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse({ code: 405, success: false, message: '只支持 GET 或 POST 请求' }, 405);
  }

  let source = {};
  if (request.method === 'POST') {
    const raw = await request.text();
    if (raw) {
      try {
        source = JSON.parse(raw);
      } catch {
        source = Object.fromEntries(new URLSearchParams(raw));
      }
    }
  } else {
    source = Object.fromEntries(new URL(request.url).searchParams);
  }
  if (!source || typeof source !== 'object') {
    source = {};
  }

  const user = asTrimmedString(readParams(source, 'user', 'account'));
  // 密码首尾空格是合法字符，不能 trim。
  const passwordValue = readParams(source, 'password', 'pwd');
  const password = typeof passwordValue === 'string' ? passwordValue : '';
  const rawSteps = readParams(source, 'steps', 'step') ?? '';
  const allowVirtualDevice = source.allow_virtual_device === true
    || source.allow_virtual_device === 'true';

  let steps;
  try {
    steps = normalizeSteps(rawSteps);
  } catch (error) {
    const status = error.status || 400;
    return jsonResponse({ code: status, success: false, message: error.message }, status);
  }

  if (!user || !password) {
    return jsonResponse({
      code: 400,
      success: false,
      message: '请提供 Zepp Life 账号 (user/account) 和密码 (password/pwd)'
    }, 400);
  }

  try {
    const data = await submitSteps(requestImpl, { user, password, steps, allowVirtualDevice });
    return jsonResponse({
      code: 200,
      success: true,
      message: 'Zepp 数据已提交（微信展示仍取决于官方同步）',
      data
    }, 200);
  } catch (error) {
    const status = error instanceof ZeppError ? error.status : 500;
    return jsonResponse({
      code: status,
      success: false,
      message: error.message || '执行过程出现异常'
    }, status);
  }
}
