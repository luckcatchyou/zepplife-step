// 生成 Cloudflare Pages 的静态输出目录。
// Pages 会把输出目录里的所有文件当静态资源公开，所以这里只复制需要公开的页面，
// 避免 api/、lib/、server.js 等源码被直接下载。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(path.join(rootDir, 'index.html'), path.join(distDir, 'index.html'));

console.log(`已生成 Cloudflare Pages 输出目录: ${distDir}`);
