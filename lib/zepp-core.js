import crypto from 'node:crypto';
import templateData from './template.js';

// 华米官方传输加密密钥与固定 IV (Zepp Life v2 协议标准)
const HM_AES_KEY = Buffer.from('xeNtBVqzDc6tuNTh', 'utf8');
const HM_AES_IV = Buffer.from('MAAAYAAAAAAAAABg', 'utf8');
const MIN_STEPS = 1;
const MAX_STEPS = 98800;
const DEFAULT_STEP_MIN = 18000;
const DEFAULT_STEP_MAX = 26000;
const DATA_HOSTS = [
  'api-mifit.zepp.com',
  'api-mifit.huami.com',
  'api-mifit-cn.huami.com'
];
const LOGIN_HOSTS = [
  'api-user.zepp.com',
  'api-user.huami.com',
  'api-user-cn.huami.com',
  'api-user-us2.zepp.com',
  'api-user-us3.zepp.com'
];
const ACCOUNT_HOSTS = ['account.huami.com', 'account.zepp.com', 'account-cn.huami.com'];
const USER_AGENT = 'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)';

// 业务错误。status 会被适配层直接用作 HTTP 状态码。
export class ZeppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'ZeppError';
    this.status = status;
  }
}

// AES-128-CBC 加密
export function encryptV2(plainText) {
  const cipher = crypto.createCipheriv('aes-128-cbc', HM_AES_KEY, HM_AES_IV);
  return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
}

// 工具函数：获取北京时间格式化字符串
export function getBeijingDateTime() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${beijingTime.getFullYear()}-${pad(beijingTime.getMonth() + 1)}-${pad(beijingTime.getDate())}`;
  const timeStr = `${pad(beijingTime.getHours())}:${pad(beijingTime.getMinutes())}:${pad(beijingTime.getSeconds())}`;
  return { date: dateStr, full: `${dateStr} ${timeStr}` };
}

export function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 空步数按页面提示生成随机值；其他非法值要明确报错，避免把 NaN 发送给服务端。
export function normalizeSteps(rawSteps) {
  if (rawSteps === undefined || rawSteps === null || rawSteps === '') {
    return Math.floor(Math.random() * (DEFAULT_STEP_MAX - DEFAULT_STEP_MIN + 1)) + DEFAULT_STEP_MIN;
  }

  const steps = Number(rawSteps);
  if (!Number.isSafeInteger(steps) || steps < MIN_STEPS || steps > MAX_STEPS) {
    throw new ZeppError(`步数必须是 ${MIN_STEPS} 到 ${MAX_STEPS} 之间的整数`, 400);
  }
  return steps;
}

function responseMessage(response, data, fallback) {
  return data?.message || data?.error_description || data?.error_code || `${fallback} (HTTP ${response.statusCode})`;
}

function getVirtualDeviceForUser(userId) {
  const hash = crypto.createHash('md5').update(String(userId)).digest('hex').toUpperCase();
  return {
    deviceId: `DA${hash.slice(0, 14)}`,
    macAddress: [0, 2, 4, 6, 8, 10].map((index) => hash.slice(index, index + 2)).join(':')
  };
}

// 登录获取授权 Code（使用 Zepp Life 最新 v2 加密协议，多节点无缝容灾）
export async function loginGetCode(request, user, password) {
  const isPhone = !user.includes('@');
  let emailOrPhone = user;
  if (isPhone && !user.startsWith('+')) {
    emailOrPhone = `+86${user}`;
  }

  const v2Params = new URLSearchParams({
    emailOrPhone: emailOrPhone,
    password: password,
    state: 'REDIRECTION',
    client_id: 'HuaMi',
    country_code: 'CN',
    region: 'us-west-2',
    redirect_uri: 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html'
  });
  // 当前 v2 登录流程会同时返回短期 access 与 refresh 凭据。即使本服务暂时只
  // 使用 access，也必须按该协议请求两者。
  v2Params.append('token', 'access');
  v2Params.append('token', 'refresh');

  const encryptedBody = encryptV2(v2Params.toString());
  let lastError = null;

  for (const host of LOGIN_HOSTS) {
    try {
      // 登录结果是 302 + Location，请求层必须不自动跟随重定向。
      const response = await request(`https://${host}/v2/registrations/tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'user-agent': USER_AGENT,
          'app_name': 'com.xiaomi.hm.health',
          'appname': 'com.xiaomi.hm.health',
          'appplatform': 'android_phone',
          'x-hm-ekv': '1',
          'hm-privacy-ceip': 'false'
        },
        body: encryptedBody,
        timeout: 8000
      });

      if (response.statusCode === 429) {
        throw new Error(`HOST_429: 节点 ${host} 正在触发限流`);
      }

      const location = response.headers?.location || '';
      if (!location) {
        throw new Error(`HTTP ${response.statusCode} 未返回重定向`);
      }

      const redirect = new URL(location, `https://${host}`);
      const errorCode = redirect.searchParams.get('error');
      if (errorCode) {
        if (errorCode === '401') {
          const attemptsMatch = redirect.searchParams.get('attempts');
          const maxAttemptsMatch = redirect.searchParams.get('max_attempts');
          let countHint = '';
          if (attemptsMatch && maxAttemptsMatch) {
            countHint = ` (已尝试 ${attemptsMatch}/${maxAttemptsMatch} 次)`;
          }
          throw new ZeppError(`Zepp Life 账号或密码错误${countHint}。请注意：必须在 Zepp Life App 内设置独立登录密码，非微信授权密码`, 401);
        }
        throw new Error(`登录接口返回错误代码: ${errorCode}`);
      }

      const accessCode = redirect.searchParams.get('access');
      if (!accessCode) {
        throw new Error('未在响应中解析到授权 access code');
      }

      return { code: accessCode, isPhone };
    } catch (err) {
      lastError = err;
      // 账号密码错误不必再换节点重试。
      if (err instanceof ZeppError) throw err;
      console.warn(`节点 ${host} v2 异常，尝试切换备用节点: ${err.message}`);
    }
  }

  throw new ZeppError(`登录节点均受限或异常(${lastError ? lastError.message : '请稍后再试'})`);
}

// 获取 login_token 和 user_id
export async function getLoginToken(request, code, isPhone) {
  const url = 'https://account.huami.com/v2/client/login';
  const deviceId = (crypto.randomUUID ? crypto.randomUUID() : '2C8B4939-0CCD-4E94-8CBA-CB8EA6E613A1').toUpperCase();
  const headers = {
    'app_name': 'com.xiaomi.hm.health',
    'x-request-id': deviceId,
    'accept-language': 'zh-CN',
    'appname': 'com.xiaomi.hm.health',
    'cv': '50818_6.14.0',
    'v': '2.0',
    'appplatform': 'android_phone',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
  };

  const params = isPhone
    ? {
        app_name: 'com.xiaomi.hm.health',
        app_version: '6.14.0',
        code: code,
        country_code: 'CN',
        device_id: deviceId,
        device_model: 'phone',
        grant_type: 'access_token',
        third_name: 'huami_phone'
      }
    : {
        'allow_registration=': 'false',
        app_name: 'com.xiaomi.hm.health',
        app_version: '6.14.0',
        code: code,
        country_code: 'CN',
        device_id: deviceId,
        device_model: 'android_phone',
        dn: 'account.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,api-analytics.huami.com,auth.zepp.com',
        grant_type: 'access_token',
        lang: 'zh_CN',
        os_version: '1.5.0',
        source: 'com.xiaomi.hm.health:6.14.0:50818',
        third_name: 'email'
      };

  const response = await request(url, {
    method: 'POST',
    headers: headers,
    body: new URLSearchParams(params).toString()
  });

  const resJson = await response.json();
  if (!resJson?.token_info?.login_token) {
    throw new ZeppError(resJson?.message || resJson?.result || '获取 login_token 失败');
  }

  return {
    loginToken: resJson.token_info.login_token,
    appToken: resJson.token_info.app_token || null,
    userId: resJson.token_info.user_id
  };
}

// 获取业务凭据 app_token
export async function getAppToken(request, loginToken) {
  let lastError = null;

  for (const host of ACCOUNT_HOSTS) {
    try {
      const url = `https://${host}/v1/client/app_tokens?app_name=com.xiaomi.hm.health&dn=api-user.huami.com%2Capi-mifit.huami.com%2Capp-analytics.huami.com&login_token=${encodeURIComponent(loginToken)}`;
      const response = await request(url, { timeout: 6000 });
      const resJson = await response.json();
      if (resJson?.token_info?.app_token) {
        return resJson.token_info.app_token;
      }
      if (resJson?.message) {
        throw new Error(resJson.message);
      }
    } catch (e) {
      lastError = e;
      console.warn(`节点 ${host} 获取 app_token 异常，尝试备用节点:`, e.message);
    }
  }

  throw new ZeppError(lastError?.message || '获取 app_token 失败');
}

function findActiveDevice(items, expectedDeviceId = null) {
  return items.find((item) => (
    item?.deviceId
    && (!expectedDeviceId || item.deviceId === expectedDeviceId)
    && (item.activeStatus === 1 || item.activeStatus === true)
    && String(item.priority) !== '-1'
  ));
}

// 设备注册是会修改账号状态的操作，必须由调用方显式选择 allowVirtualDevice。
// 注册后立刻回读设备列表，只有服务端确认已启用时才允许继续上传。
async function bindAndVerifyVirtualDevice(request, host, appToken, userId) {
  const virtualDevice = getVirtualDeviceForUser(userId);
  const bindResponse = await request(`https://${host}/users/${encodeURIComponent(userId)}/devices`, {
    method: 'POST',
    headers: { apptoken: appToken, 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: virtualDevice.deviceId,
      deviceType: 0,
      deviceSource: 24,
      macAddress: virtualDevice.macAddress,
      displayName: '小米手环 2',
      activeStatus: 1,
      bindingStatus: 1,
      priority: 1
    }),
    timeout: 5000
  });
  const bindData = await bindResponse.json();
  if (bindResponse.statusCode < 200 || bindResponse.statusCode >= 300) {
    throw new ZeppError(`添加测试设备失败：${responseMessage(bindResponse, bindData, '绑定接口拒绝请求')}`);
  }

  const listResponse = await request(`https://${host}/users/${encodeURIComponent(userId)}/devices?enable=true`, {
    headers: { apptoken: appToken },
    timeout: 2500
  });
  const listData = await listResponse.json();
  const items = Array.isArray(listData?.items) ? listData.items : [];
  const device = listResponse.statusCode === 200 ? findActiveDevice(items, virtualDevice.deviceId) : null;
  if (!device) {
    throw new ZeppError('测试设备未被服务端确认启用，已停止上传');
  }
  return { host, deviceId: device.deviceId };
}

// 优先使用已绑定设备；若用户明确同意，才创建并验证一个测试设备。
async function findVerifiedActiveDevice(request, appToken, userId, allowVirtualDevice = false) {
  const failures = [];
  const reachableHosts = [];
  for (const host of DATA_HOSTS) {
    try {
      const response = await request(`https://${host}/users/${encodeURIComponent(userId)}/devices?enable=true`, {
        headers: { apptoken: appToken },
        timeout: 2500
      });
      const data = await response.json();
      if (response.statusCode !== 200) {
        failures.push(`${host}: ${responseMessage(response, data, '设备接口不可用')}`);
        continue;
      }

      const devices = Array.isArray(data?.items) ? data.items : [];
      const device = findActiveDevice(devices);
      if (device) return { host, deviceId: device.deviceId };
      reachableHosts.push(host);
      failures.push(`${host}: 未找到已启用的绑定设备`);
    } catch (error) {
      failures.push(`${host}: ${error.message}`);
    }
  }

  if (allowVirtualDevice) {
    for (const host of reachableHosts) {
      try {
        return await bindAndVerifyVirtualDevice(request, host, appToken, userId);
      } catch (error) {
        failures.push(`${host}: ${error.message}`);
      }
    }
  }

  const optInHint = allowVirtualDevice ? '' : ' 如需注册测试设备，请在页面明确勾选授权选项。';
  throw new ZeppError(`未找到可用的 Zepp 设备。${optInHint}${failures.length ? ` (${failures.join('；')})` : ''}`);
}

// 模板来自旧协议。解析后按字段更新，避免字符串替换命中错误位置。
export function createBandData(deviceId, steps, date) {
  const records = JSON.parse(decodeURIComponent(templateData));
  const record = records[0];
  const summary = record && typeof record.summary === 'string' ? JSON.parse(record.summary) : null;
  if (!record || !summary?.stp) throw new ZeppError('步数数据模板格式无效');

  record.date = date;
  record.did = deviceId;
  summary.stp.ttl = steps;
  record.summary = JSON.stringify(summary);
  return JSON.stringify(records);
}

// 提交步数数据
export async function uploadBandData(request, appToken, userId, steps, allowVirtualDevice = false) {
  const { date: todayDate } = getBeijingDateTime();
  const verifiedDevice = await findVerifiedActiveDevice(request, appToken, userId, allowVirtualDevice);
  const activeDeviceId = verifiedDevice.deviceId;
  const finalDataJson = createBandData(activeDeviceId, steps, todayDate);

  const timestamp = Date.now();
  const payload = new URLSearchParams({
    userid: userId,
    last_sync_data_time: String(Math.floor(Date.now() / 1000) - 300),
    device_type: '0',
    last_deviceid: activeDeviceId,
    data_json: finalDataJson
  });

  let lastError = null;

  for (const host of [verifiedDevice.host]) {
    try {
      const url = `https://${host}/v1/data/band_data.json?&t=${timestamp}`;
      const response = await request(url, {
        method: 'POST',
        headers: {
          apptoken: appToken,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: payload.toString(),
        timeout: 5000
      });

      const resJson = await response.json();
      if (resJson?.code === 1) {
        return { success: true, message: resJson.message || '步数提交成功' };
      }
      return { success: false, message: responseMessage(response, resJson, '服务器返回异常') };
    } catch (e) {
      lastError = e;
      console.warn(`节点 ${host} 提交步数异常:`, e.message);
    }
  }

  throw new ZeppError(`提交步数节点均不可用: ${lastError?.message || '网络超时'}`);
}

// 完整提交流程：登录 -> 取凭据 -> 找设备 -> 上传步数。
// request 由平台适配层注入（Node 用 https，Workers 用 fetch）。
export async function submitSteps(request, { user, password, steps, allowVirtualDevice = false }) {
  const { code, isPhone } = await loginGetCode(request, user, password);
  const { loginToken, appToken: directAppToken, userId } = await getLoginToken(request, code, isPhone);
  const finalAppToken = directAppToken || (await getAppToken(request, loginToken));
  const result = await uploadBandData(request, finalAppToken, userId, steps, allowVirtualDevice);

  if (!result.success) {
    throw new ZeppError(`提交步数失败: ${result.message}`, 502);
  }

  const { full: nowTime, date: nowDate } = getBeijingDateTime();

  return {
    account: user.includes('@') ? user : `${user.slice(0, 3)}****${user.slice(-4)}`,
    steps: steps,
    date: nowDate,
    time: nowTime
  };
}
