// Cloudflare Workers / Pages Functions 使用的底层请求实现。
//
// Workers 的 node:https 只是 fetch 的包装，会引入重定向行为的不确定性，
// 因此这里直接用运行时原生的 fetch，并显式 redirect: 'manual'，
// 与 Node 版 https.request 的“不跟随重定向”语义保持一致。
//
// 返回结构与 Node 版保持一致：{ statusCode, headers, text(), json() }
export default async function fetchRequest(urlStr, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 10000);

  const headers = new Headers();
  for (const [key, value] of Object.entries(options.headers || {})) {
    const lower = key.toLowerCase();
    // 这些头由 Workers 运行时接管，手动设置会被忽略或直接报错。
    if (lower === 'content-length' || lower === 'connection' || lower === 'expect') continue;
    headers.set(key, value);
  }

  try {
    const response = await fetch(urlStr, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
      redirect: 'manual',
      signal: controller.signal
    });

    const text = await response.text();
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text: async () => text,
      json: async () => {
        try {
          return JSON.parse(text);
        } catch {
          return {};
        }
      }
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`请求超时(${new URL(urlStr).hostname})`);
    }
    throw new Error(`网络请求失败(${new URL(urlStr).hostname}): ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}
