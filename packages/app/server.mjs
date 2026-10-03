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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${ESTATE_TOKENS}:root{color-scheme:light dark;font:16px/1.45 system-ui,sans-serif;--ink:var(--foreground);--paper:var(--background);--line:var(--border)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}header{padding:1rem 1.5rem;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:2rem}h1{font-size:1.2rem;margin:0}h3{font-size:.9rem;letter-spacing:.04em;text-transform:uppercase}nav,.links{display:flex;gap:.4rem;flex-wrap:wrap}nav a{color:inherit;padding:.45rem .7rem;border-radius:.35rem;text-decoration:none}nav a[aria-current=page]{background:var(--primary);color:var(--primary-foreground)}main{max-width:90rem;margin:auto;padding:1.5rem}.summary,.meta,.empty{color:var(--muted-foreground)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(18rem,100%),1fr));gap:.75rem}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:1rem}.area-summary{padding:.25rem 0 1.5rem;border-bottom:1px solid var(--line)}.area-summary .card{background:var(--secondary)}.current-work{padding-top:.75rem}.ref{font:700 .82rem ui-monospace,monospace;color:var(--interactive)}.meta{font-size:.82rem}.links a{color:var(--interactive)}.error{color:var(--status-bad-ink)}@media(max-width:42rem){header{align-items:flex-start;flex-direction:column;gap:.65rem;padding:1rem}nav{flex-wrap:nowrap;width:100%;overflow-x:auto}nav a{padding:.4rem .3rem;white-space:nowrap;font-size:.8rem}main{padding:1rem}}</style></head><body><header><h1>Helmo</h1><nav aria-label="Areas">${[...ROUTES].map(([href,name])=>`<a href="${href}"${active===name?' aria-current="page"':''}>${name[0].toUpperCase()+name.slice(1)}</a>`).join('')}</nav></header><main><h2>${esc(active[0].toUpperCase()+active.slice(1))}</h2><p class="summary" id="summary">${active==='overview'?'4 areas':`${initial.length} record${initial.length===1?'':'s'}`}</p>${content(active,document_,empty)}</main><script type="module">const summary=document.querySelector('#summary'),records=document.querySelector('#records');try{const response=await fetch('${api}',{headers:{accept:'application/json'}});if(!response.ok)throw new Error(response.status+' '+response.statusText);const document_=await response.json();if(document_.api!=='helmo/v1'||document_.area!=='${active}')throw new Error('unexpected API document');const data=document_.data,rows=Array.isArray(data)?data:Array.isArray(data.records)?data.records:Array.isArray(data.projects)?data.projects:Array.isArray(data.loops)?data.loops:[data];summary.textContent=${active==='overview'?"'4 areas'":"rows.length+' record'+(rows.length===1?'':'s')"};if(!rows.length)records.innerHTML='<p class="empty">No ${active} records are configured.</p>'}catch(error){summary.className='error';summary.textContent='Could not read ${active}: '+error.message;records.replaceChildren()}</script></body></html>`;
}

export function appRequest(request,response,documents={}) { const url=new URL(request.url??'/',`http://${request.headers.host??'localhost'}`), pathname=url.pathname.length>1?url.pathname.replace(/\/$/,''):url.pathname, area=ROUTES.get(pathname); if(!area)return false; const document_=documents[area]?.(); response.writeHead(200,{'content-type':'text/html; charset=utf-8'}); response.end(appPage(pathname,document_)); return true; }


// Compose the established product documents without replacing their behavior.
// Scoped CSS leaves each product's layout, disclosure and refresh code intact.
export function productNavigation(area) {
  return `<style>
.helmo-navigation{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;border-bottom:1px solid var(--border);padding:0 0 1rem;margin:0 0 1.5rem;font:14px/1.5 system-ui,sans-serif;color:var(--foreground)}
.helmo-navigation strong{font-size:16px}.helmo-navigation nav{display:flex;gap:.25rem;overflow-x:auto;max-width:100%;flex-wrap:nowrap}.helmo-navigation a{display:block;white-space:nowrap;padding:.4rem .55rem;border-radius:var(--radius);text-decoration:none;color:var(--foreground)}.helmo-navigation a[aria-current=page]{background:var(--primary);color:var(--primary-foreground)}
.helmo-scroll-hint{display:none}
@media(max-width:42rem){.helmo-navigation{gap:.4rem}.helmo-navigation nav{width:100%;gap:.15rem}.helmo-navigation a{font-size:.8rem;padding:.4rem .35rem}.helmo-scroll-hint{display:block;color:var(--muted-foreground);font:13px/1.5 system-ui,sans-serif;margin:.75rem 0}}
</style><div class="helmo-navigation"><strong>Helmo</strong><nav aria-label="Areas">${[...ROUTES].map(([href,name])=>`<a href="${href}"${name===area?' aria-current="page"':''}>${name[0].toUpperCase()+name.slice(1)}</a>`).join('')}</nav></div>`;
}

export function serveProduct(request, response, handler, area) {
  const end = response.end;
  response.end = function(body, ...args) {
    if (typeof body === 'string' && body.startsWith('<!doctype html>')) {
      body = body.replace(/<body(?:\s[^>]*)?>/i, (tag) => tag + productNavigation(area));
      if (area === 'runtime') body = body.replace('<div class="tablewrap"', '<p class="helmo-scroll-hint" id="helmo-runtime-scroll">Scroll sideways for runtime, pace, spend and recent trace.</p><div aria-describedby="helmo-runtime-scroll" class="tablewrap"');
    }
    return end.call(this, body, ...args);
  };
  return handler(request, response);
}
