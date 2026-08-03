#!/usr/bin/env node
// Deliberately plain read-only view. The "visually excellent" view comes after
// dogfooding shows what real agent-written data looks like.
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { Ticket } from './types.js';

const dbPath = process.env['HELM_DB'] ?? join(homedir(), '.helm', 'helm.db');
const port = Number(process.env['HELM_VIEW_PORT'] ?? 4400);
const store = new Store(dbPath);

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function row(t: Ticket): string {
  const blocked = t.status === 'open' && store.isBlocked(t.id);
  const q = t.question ? `<div class="q"><b>${esc(t.question.question)}</b> — rec: ${esc(t.question.recommendation)}</div>` : '';
  const ev = t.evidence.map((e) => `<a href="${esc(e.ref)}">${esc(e.kind)}</a>`).join(' ');
  const flag = t.status === 'done' && t.evidence.length === 0 ? ' <span class="flag">no evidence</span>' : '';
  return `<tr>
    <td class="id">${esc(t.id)}</td>
    <td>${esc(t.title)}${flag}${q}<div class="chain">${esc(store.agentChain(t.id).join(' → '))}</div></td>
    <td>${esc(t.workstream)}</td>
    <td>${esc(t.type)}</td>
    <td>P${t.priority}</td>
    <td>${esc(t.status)}${blocked ? ' <span class="blocked">blocked</span>' : ''}</td>
    <td>${esc(t.assignee ?? '')}</td>
    <td class="br br-${t.blast_radius}">${esc(t.blast_radius)}</td>
    <td>${ev}</td>
    <td>${t.tokens_total ? `${(t.tokens_total / 1000).toFixed(1)}k` : ''}${t.cost_usd_total ? ` $${t.cost_usd_total.toFixed(2)}` : ''}</td>
    <td>${esc(t.updated_at.slice(0, 16).replace('T', ' '))}</td>
  </tr>`;
}

function section(title: string, tickets: Ticket[]): string {
  if (!tickets.length) return title.startsWith('Awaiting') ? `<h2>${title}</h2><p class="empty">Queue is empty. Nothing needs you.</p>` : '';
  return `<h2>${title} (${tickets.length})</h2>
  <table><tr><th>ID</th><th>Title</th><th>Workstream</th><th>Type</th><th>Pri</th><th>Status</th><th>Assignee</th><th>Blast</th><th>Evidence</th><th>Spend</th><th>Updated</th></tr>
  ${tickets.map(row).join('\n')}</table>`;
}

createServer((_req, res) => {
  const all = store.listTickets({ limit: 1000 });
  const by = (s: string) => all.filter((t) => t.status === s);
  const html = `<!doctype html><meta charset="utf-8"><title>Helm</title>
  <meta http-equiv="refresh" content="10">
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 1200px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; color: #666; }
    .id { font-family: ui-monospace, monospace; white-space: nowrap; }
    .chain { color: #888; font-size: 12px; }
    .q { background: #fff8e1; padding: 4px 8px; margin-top: 4px; border-radius: 4px; }
    .flag, .blocked { color: #b00; font-size: 12px; }
    .br-sent, .br-published { color: #b00; font-weight: 600; }
    .br-records { color: #b60; }
    .empty { color: #383; }
    h1 span { color: #999; font-weight: normal; font-size: 16px; }
  </style>
  <h1>Helm <span>read-only · agents write, you read · ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}</span></h1>
  ${section('Awaiting you', by('awaiting_human'))}
  ${section('In progress', by('in_progress'))}
  ${section('Open', by('open'))}
  ${section('Done', by('done'))}
  ${section('Cancelled', by('cancelled'))}`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(port, () => console.log(`Helm view (read-only): http://localhost:${port} — db: ${dbPath}`));
