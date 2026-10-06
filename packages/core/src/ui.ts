import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const DIST = new URL('../../shell/dist/', import.meta.url);
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', woff2: 'font/woff2', woff: 'font/woff', svg: 'image/svg+xml',
};
const ROUTES: Record<string, string> = { '/overview': 'overview', '/work': 'work', '/roadmap': 'roadmap', '/team': 'team', '/run': 'runtime' };

/** Every entry point serves the same untouched Vite document and assets. A
 * standalone entry advertises only the area its backend can actually serve. */
export function uiRequest(req: IncomingMessage, res: ServerResponse, config: { areas: string[]; defaultArea: string }): boolean {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) return false;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/v1/ui') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(config));
    return true;
  }
  const asset = /^\/assets\/([\w.-]+)$/.exec(url.pathname);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const area = path === '/' ? config.defaultArea : ROUTES[path];
  if (!asset && (!area || !config.areas.includes(area))) return false;
  const section = url.searchParams.get('section');
  if (!asset && section && (area !== 'work' || section !== 'awaiting')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Unknown Helmo section.');
    return true;
  }
  const file = asset ? `assets/${asset[1]}` : 'index.html';
  const type = TYPES[file.slice(file.lastIndexOf('.') + 1)];
  if (!type) return false;
  try {
    const bytes = readFileSync(new URL(file, DIST));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The Helmo application is not built: run npm run build.\n');
  }
  return true;
}
