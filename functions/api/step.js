import fetchRequest from '../../lib/http-worker.js';
import { handleStepRequest } from '../../lib/step-handler.js';

// Cloudflare Pages Function：/api/step
// 走 Pages（而不是 Workers Builds）部署时使用；逻辑与 worker.js 完全一致。
export async function onRequest(context) {
  return handleStepRequest(context.request, fetchRequest);
}
