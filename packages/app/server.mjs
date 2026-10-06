/* Helmo's application shell is a standard shadcn/ui Vite build (packages/shell,
   R-39 H-2933). The server's whole part in it is handing over the built files:
   the document for an area the application renders, and the hashed assets that
   document asks for. There is no injection, no adopted DOM and no stylesheet
   of ours on the page — the framework owns the page styling, and each area's
   content is React in packages/shell/src/App.tsx reading /api/v1/<area>.

   Roadmap and Runtime are NOT in ROUTES: they are still served as their own
   complete documents by their own handlers, outside this application, until
   H-2938 and H-2939 move them in. Those two therefore carry no sidebar and no
   cross-area navigation at all, which is why this is still a preview to look
   at and not a build to deploy.

   `/work` IS in ROUTES (H-2936), and `/` is not: the historical landing path
   still serves Work's own document, because the record lists and history a
   `#H-n` bookmark resolves against are H-2937's packet. Until it lands, the
   two renderings of Work coexist on purpose. */
import { readFileSync } from 'node:fs';

const ROUTES = new Map([['/overview', 'overview'], ['/team', 'team'], ['/work', 'work']]);
const DIST = new URL('../shell/dist/', import.meta.url);

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.svg', 'image/svg+xml'],
]);

const UNBUILT = 'The Helmo application is not built: run npm run build.\n';

/** One built file, by name. no-store rather than an etag: these are local
 *  files on a loopback port, and a cached asset from the release before this
 *  one is the kind of stale that looks like a bug in the page it draws. */
function sendBuilt(response, path) {
  const type = TYPES.get(path.slice(path.lastIndexOf('.')));
  if (!type) return false;
  let bytes;
  try { bytes = readFileSync(new URL(path, DIST)); }
  catch {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(UNBUILT);
    return true;
  }
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(bytes);
  return true;
}

/** The build's own asset requests. The name is matched rather than joined so a
 *  request can only ever name a file Vite emitted into dist/assets. */
export function shellRequest(request, response) {
  const found = /^\/assets\/([\w.-]+)$/.exec((request.url ?? '/').split('?')[0]);
  if (!found) return false;
  return sendBuilt(response, `assets/${found[1]}`);
}

/** An area this application renders. Every such route answers the one built
 *  document; which area it is comes from the path, in the browser. */
export function appRequest(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers?.host ?? 'localhost'}`);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
  if (!ROUTES.has(pathname)) return false;
  return sendBuilt(response, 'index.html');
}

export const APP_AREAS = [...ROUTES.values()];
