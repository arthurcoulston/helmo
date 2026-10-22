import { statusReading } from '../roadmap/dist/types.js';

export function roadmapNow(projects, asOf = new Date().toISOString()) {
  const visible = projects.filter((project) => !project.archived);
  return {
    as_of: asOf,
    counts: Object.fromEntries(['Active', 'Planned', 'Proposed'].map((status) =>
      [status, visible.filter((project) => statusReading(project.status) === status).length])),
    attention: visible
      .filter((project) => ['At risk', 'Off track'].includes(project.health))
      .map(({ id, title, health, health_reason }) => ({ id, title, health, reason: health_reason })),
    health_unrecorded: visible.filter((project) => !project.health).length,
  };
}
