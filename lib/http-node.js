import https from 'node:https';

// Node/Vercel 使用的底层请求实现。
//
// 原实现刻意不走 global fetch：Vercel 上的 undici 访问国内节点时会出现 fetch failed。
// 这里保持原生 https.request，且沿用 Node 默认行为——不自动跟随重定向，
// 登录接口依赖这一点来读取 302 响应里的 Location。
//
// 返回结构与 Workers 版保持一致：{ statusCode, headers, text(), json() }
export default function httpsRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const postData = options.body;
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)',
        ...(options.headers || {})
      }
    };
    if (postData) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          text: async () => data,
          json: async () => {
            try {
              return JSON.parse(data);
            } catch {
              return {};
            }
          }
        });
      });
    });

    req.on('error', (err) => reject(new Error(`网络请求失败(${parsedUrl.hostname}): ${err.message}`)));
    req.setTimeout(options.timeout || 10000, () => {
      req.destroy();
      reject(new Error(`请求超时(${parsedUrl.hostname})`));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}
