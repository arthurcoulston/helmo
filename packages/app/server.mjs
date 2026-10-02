const AREA = new Set(['work', 'roadmap', 'runtime']);

const esc = (value) => String(value ?? '').replace(/[&<>\"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);

function rows(document_) {
  const data = document_?.data;
  return Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : Array.isArray(data?.projects) ? data.projects : Array.isArray(data?.loops) ? data.loops : data ? [data] : [];
}

function cards(document_) {
  return rows(document_).map((row) => `<article class="card"${row.id ? ` id="${esc(row.id)}"` : ''}>${row.id ? `<div class="ref">${esc(row.id)}</div>` : ''}<strong>${esc(row.title ?? row.name ?? row.installation ?? 'Record')}</strong>${row.status || row.state ? `<div class="meta">${esc(row.status ?? row.state)}</div>` : ''}${row.body ? `<p>${esc(row.body)}</p>` : ''}</article>`).join('');
}

export function appPage(pathname, document_ = null) {
  const area = pathname === '/run' ? 'runtime' : pathname === '/' ? 'work' : pathname.slice(1);
  const active = AREA.has(area) ? area : 'overview';
  const api = AREA.has(active) ? `/api/v1/${active}` : null;
  const title = pathname === '/' ? 'Helmo' : `Helmo · ${active}`;
  const initial = rows(document_);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>${ESTATE_TOKENS}:root{color-scheme:light dark;font:16px/1.45 system-ui,sans-serif;--ink:var(--foreground);--paper:var(--background);--line:var(--border);--accent:var(--interactive)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}header{padding:1rem 1.5rem;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:2rem}h1{font-size:1.2rem;margin:0}nav{display:flex;gap:.4rem;flex-wrap:wrap}nav a{color:inherit;padding:.45rem .7rem;border-radius:.35rem;text-decoration:none}nav a[aria-current=page]{background:var(--primary);color:var(--primary-foreground)}main{max-width:90rem;margin:auto;padding:1.5rem}.summary,.meta{color:var(--muted-foreground)}.cards{display:grid;gap:.75rem}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:1rem}.ref{font:700 .82rem ui-monospace,monospace;color:var(--accent)}.meta{font-size:.82rem}.error{color:var(--status-bad-ink)}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>
<header><h1>Helmo</h1><nav aria-label="Areas">${[['overview','/'],['work','/work'],['roadmap','/roadmap'],['team','/team'],['runtime','/run']].map(([name,href]) => `<a href="${href}"${active === name ? ' aria-current="page"' : ''}>${name[0].toUpperCase()+name.slice(1)}</a>`).join('')}</nav></header>
<main><h2>${esc(active[0].toUpperCase()+active.slice(1))}</h2><p class="summary" id="summary">${api ? `${initial.length} record${initial.length === 1 ? '' : 's'}` : 'This area joins the shared shell in the next bounded slice.'}</p><div class="cards" id="records">${cards(document_)}</div></main>
${api ? `<script type="module">const esc=(v)=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));const summary=document.querySelector('#summary'),records=document.querySelector('#records');try{const response=await fetch('${api}',{headers:{accept:'application/json'}});if(!response.ok)throw new Error(response.status+' '+response.statusText);const document_=await response.json();if(document_.api!=='helmo/v1'||document_.area!=='${active}')throw new Error('unexpected API document');const data=document_.data;const rows=Array.isArray(data)?data:Array.isArray(data.records)?data.records:Array.isArray(data.projects)?data.projects:Array.isArray(data.loops)?data.loops:[data];summary.textContent=rows.length+' record'+(rows.length===1?'':'s');records.innerHTML=rows.map(row=>'<article class="card"'+(row.id?' id="'+esc(row.id)+'"':'')+'>'+(row.id?'<div class="ref">'+esc(row.id)+'</div>':'')+'<strong>'+esc(row.title??row.name??row.installation??'Record')+'</strong>'+(row.status||row.state?'<div class="meta">'+esc(row.status??row.state)+'</div>':'')+(row.body?'<p>'+esc(row.body)+'</p>':'')+'</article>').join('')}catch(error){summary.className='error';summary.textContent='Could not read ${active}: '+error.message}</script>` : ''}</body></html>`;
}

export function appRequest(request, response, documents = {}) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
  if (!['/', '/work', '/roadmap', '/run', '/team'].includes(pathname)) return false;
  const area = pathname === '/run' ? 'runtime' : pathname === '/' ? 'work' : pathname.slice(1);
  const document_ = documents[area]?.();
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(appPage(pathname, document_));
  return true;
}
import { ESTATE_TOKENS } from '../core/dist/index.js';
