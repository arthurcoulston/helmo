import { readFileSync } from 'node:fs';
import { ESTATE_TOKENS } from '../core/dist/index.js';

const ROUTES = new Map([['/overview', 'overview'], ['/work', 'work'], ['/roadmap', 'roadmap'], ['/team', 'team'], ['/run', 'runtime']]);
const esc = (value) => String(value ?? '').replace(/[&<>\"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
function rows(document_) { const data=document_?.data??document_; return Array.isArray(data)?data:Array.isArray(data?.records)?data.records:Array.isArray(data?.projects)?data.projects:Array.isArray(data?.loops)?data.loops:data?[data]:[]; }
function cards(document_) { return rows(document_).map((row) => `<article class="card"${row.id?` id="${esc(row.id)}"`:''}>${row.id?`<div class="ref">${esc(row.id)}</div>`:''}<strong>${esc(row.title??row.name??row.installation??'Record')}</strong>${row.status||row.state?`<div class="meta">${esc(row.status??row.state)}</div>`:''}${row.body||row.detail?`<p>${esc(row.body??row.detail)}</p>`:''}${Array.isArray(row.links)?`<div class="links">${row.links.map((link)=>`<a href="${esc(link.href)}">${esc(link.label)}</a>`).join('')}</div>`:''}</article>`).join(''); }
function content(active, document_, empty) {
  const records=rows(document_);
  if(active!=='overview')return `<div class="cards" id="records">${cards(document_)||empty}</div>`;
  const areas={data:{records:records.slice(0,4)}};
  return `<section class="area-summary"><h3>Areas</h3><div class="cards">${cards(areas)||empty}</div></section><section class="current-work" id="records"><h3>Current work</h3><p><a href="/work">Open Work for decisions, actions, progress and evidence.</a></p></section>`;
}

export function appPage(pathname, document_=null) {
  const active=ROUTES.get(pathname)??'overview', api=`/api/v1/${active}`, title=active==='overview'?'Helmo':`Helmo · ${active}`, initial=rows(document_), empty=`<p class="empty">No ${esc(active)} records are configured.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${ESTATE_TOKENS}:root{color-scheme:light dark;font:16px/1.45 system-ui,sans-serif;--ink:var(--foreground);--paper:var(--background);--line:var(--border)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}h3{font-size:.9rem;letter-spacing:.04em;text-transform:uppercase}.links{display:flex;gap:.4rem;flex-wrap:wrap}.page{max-width:90rem;margin:auto;padding:1.5rem}.summary,.meta,.empty{color:var(--muted-foreground)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(18rem,100%),1fr));gap:.75rem}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:1rem}.area-summary{padding:.25rem 0 1.5rem;border-bottom:1px solid var(--line)}.area-summary .card{background:var(--secondary)}.current-work{padding-top:.75rem}.ref{font:700 .82rem ui-monospace,monospace;color:var(--interactive)}.meta{font-size:.82rem}.links a{color:var(--interactive)}.error{color:var(--status-bad-ink)}@media(max-width:42rem){.page{padding:1rem}}</style></head><body>${shellMount(active)}<div class="page"><h2>${esc(active[0].toUpperCase()+active.slice(1))}</h2><p class="summary" id="summary">${active==='overview'?'4 areas':`${initial.length} record${initial.length===1?'':'s'}`}</p>${content(active,document_,empty)}</div><script type="module">const summary=document.querySelector('#summary'),records=document.querySelector('#records');try{const response=await fetch('${api}',{headers:{accept:'application/json'}});if(!response.ok)throw new Error(response.status+' '+response.statusText);const document_=await response.json();if(document_.api!=='helmo/v1'||document_.area!=='${active}')throw new Error('unexpected API document');const data=document_.data,rows=Array.isArray(data)?data:Array.isArray(data.records)?data.records:Array.isArray(data.projects)?data.projects:Array.isArray(data.loops)?data.loops:[data];summary.textContent=${active==='overview'?"'4 areas'":"rows.length+' record'+(rows.length===1?'':'s')"};if(!rows.length)records.innerHTML='<p class="empty">No ${active} records are configured.</p>'}catch(error){summary.className='error';summary.textContent='Could not read ${active}: '+error.message;records.replaceChildren()}</script></body></html>`;
}

export function appRequest(request,response,documents={}) { const url=new URL(request.url??'/',`http://${request.headers.host??'localhost'}`), pathname=url.pathname.length>1?url.pathname.replace(/\/$/,''):url.pathname, area=ROUTES.get(pathname); if(!area)return false; const document_=documents[area]?.(); response.writeHead(200,{'content-type':'text/html; charset=utf-8'}); response.end(appPage(pathname,document_)); return true; }


// The shell: one shadcn/ui Sidebar, one header row, around every Helmo page
// (R-39 H-2933). The products still render their own complete documents —
// the shell adopts those nodes in the browser rather than replacing them, so
// each product's layout, disclosure and refresh code is untouched.

const ASSETS = new Map([
  ['/shell/shell.js', { file: 'shell.js', type: 'text/javascript; charset=utf-8' }],
  ['/shell/shell.css', { file: 'shell.css', type: 'text/css; charset=utf-8' }],
]);

/** The shell's built assets. no-store rather than an etag: these are two local
 *  files on a loopback port, and a cached shell from the release before this
 *  one is the kind of stale that looks like a bug in the page it wraps. */
export function shellRequest(request, response) {
  const asset = ASSETS.get((request.url ?? '/').split('?')[0]);
  if (!asset) return false;
  let bytes;
  try {
    bytes = readFileSync(new URL(`../shell/dist/${asset.file}`, import.meta.url));
  } catch {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('The Helmo shell is not built: run npm run build.\n');
    return true;
  }
  response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
  response.end(bytes);
  return true;
}

export const DESTINATIONS = [...ROUTES].map(([href, id]) => ({ id, href, label: id[0].toUpperCase() + id.slice(1) }));

/** The shell's assets and what it needs to draw itself, in one block at the
 *  top of <body>.
 *
 *  <body> and not <head>, because Work and Roadmap render no head element at
 *  all — their documents open straight into <meta> and the browser builds the
 *  head implicitly, so a `</head>` anchor matches nothing and the shell
 *  silently never loads on the two busiest pages. A stylesheet link is valid
 *  in body, and this one applies nothing until the shell has mounted anyway.
 *
 *  The configuration is a JSON island rather than a global, so the mount
 *  script reads it with no parsing order to get wrong and the page carries no
 *  inline executable code of ours. */
export function shellMount(area) {
  const config = { area, title: DESTINATIONS.find((d) => d.id === area)?.label ?? 'Helmo', destinations: DESTINATIONS };
  return '<link rel="stylesheet" href="/shell/shell.css">'
    + `<script type="application/json" id="helmo-shell-config">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`
    + '<script type="module" src="/shell/shell.js"></script>';
}

// Runtime's table is wider than a narrow window; the hint says so out loud,
// and only where the table has actually been cut off.
const SCROLL_HINT_CSS = '<style>.helmo-scroll-hint{display:none}@media(max-width:42rem){.helmo-scroll-hint{display:block;color:var(--muted-foreground);font:13px/1.5 system-ui,sans-serif;margin:.75rem 0}}</style>';

export function serveProduct(request, response, handler, area) {
  const end = response.end;
  response.end = function(body, ...args) {
    if (typeof body === 'string' && body.startsWith('<!doctype html>')) {
      body = body.replace(/<body(?:\s[^>]*)?>/i, (tag) => tag + shellMount(area));
      if (area === 'runtime') body = body.replace('<div class="tablewrap"', `${SCROLL_HINT_CSS}<p class="helmo-scroll-hint" id="helmo-runtime-scroll">Scroll sideways for runtime, pace, spend and recent trace.</p><div aria-describedby="helmo-runtime-scroll" class="tablewrap"`);
    }
    return end.call(this, body, ...args);
  };
  return handler(request, response);
}
