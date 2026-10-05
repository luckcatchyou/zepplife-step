import fetchRequest from './lib/http-worker.js';
import { handleStepRequest } from './lib/step-handler.js';

// Cloudflare Worker 入口（Workers Builds 用 `wrangler deploy` 部署）。
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;

    if (pathname === '/api/step') {
      return handleStepRequest(request, fetchRequest);
    }

    // 其余请求交给静态资源（dist/ 里的 index.html）
    return env.ASSETS.fetch(request);
  }
};
