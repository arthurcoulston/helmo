import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { revHome } from './config.js';

export interface StallObservation {
  case: 'unavailable_seat' | 'ready_without_progress' | 'self_triage';
  ticket: string;
  seat: string;
  reason: string;
  action: string;
}

export interface StallEpisode extends StallObservation {
  id: string;
  first_observed_at: string;
  last_observed_at: string;
  checks: number;
}

function episodeFile(): string {
  return join(revHome(), 'state', 'supervisor', 'stalled-work.json');
}

function readEpisodes(file = episodeFile()): StallEpisode[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { format: number; episodes: StallEpisode[] };
  if (parsed.format !== 1 || !Array.isArray(parsed.episodes)) throw new Error('stalled-work episode state is unreadable');
  return parsed.episodes;
}

function writeDurable(file: string, episodes: StallEpisode[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, `${JSON.stringify({ format: 1, episodes }, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* no partial episode file remains */ }
    throw e;
  }
}

/** Reconcile complete current observations into one durable episode per case
 * and ticket. Resolved episodes disappear; repeated checks update in place. */
export function recordStallEpisodes(observations: StallObservation[], at = new Date().toISOString(), file = episodeFile()): StallEpisode[] {
  const prior = readEpisodes(file);
  const episodes = observations.map((observation) => {
    const id = `${observation.case}:${observation.ticket}`;
    const existing = prior.find((episode) => episode.id === id);
    return {
      ...observation,
      id,
      first_observed_at: existing?.first_observed_at ?? at,
      last_observed_at: at,
      checks: (existing?.checks ?? 0) + 1,
    };
  });
  writeDurable(file, episodes);
  return episodes;
}
