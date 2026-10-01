// A record reference that says which installation it came from (H-2506).
//
// The sibling of helmo:src/reference.ts, in the same idiom and for the same
// reason. Two installations of the roadmap mint ids from their own counters, so
// `R-1` exists in both and means two unrelated projects. An agent that read
// `R-1` in installation A and asked installation B for it got an answer — a
// confident, well-formed, entirely wrong answer.
//
// The roadmap already carried half of this: every result advertised
// `references: [{ id, qualified }]`. But `qualified` was a second idiom for the
// thing Helmo spells `R-1@label`, and it was advertise-only — handed back to
// the very installation that minted it, it answered "not found". A reference
// the product will not accept back is worse than none: it teaches an agent to
// fall back to the bare id, which is exactly the spelling that cross-resolves.
//
// So: one spelling for the whole family, `R-1@dev.roadmap.b`, the same
// `thing@where` idiom this estate already writes evidence refs in, and the
// inbound half is the load-bearing one. Split at the FIRST '@', so the
// qualifier can be any of the three spellings `--installation` takes — the
// label a surface printed, the installation home, or the store path a Rev
// roster points at — and like that flag it ASSERTS and can never redirect: a
// reference naming another installation is refused, never forwarded, because
// forwarding it would open a second store from a process already bound to one.
//
// A bare `R-1` keeps working everywhere, and must: within one installation an
// id is unambiguous, which is every single-install user and every caller
// written before this existed.
import { Installation, namesInstallation } from './install.js';
import { RoadmapError } from './types.js';

/** The reference to carry away for a record read here — what a surface hands an
 *  agent when the id alone would not say whose. An installation-less store
 *  (a library caller, a test) has nothing to qualify with and returns the id. */
export function qualifiedRecordRef(id: string, i?: Installation): string {
  return i ? `${id}@${i.label}` : id;
}

/** The inbound direction: the local id a reference means here, or a refusal.
 *
 *  Called by a surface BEFORE it reaches the store, so a reference carried in
 *  from another installation costs a read of nothing and writes nothing. */
export function localRecordRef(ref: string, i?: Installation): string {
  const at = ref.indexOf('@');
  if (at === -1) return ref;
  const id = ref.slice(0, at).trim();
  const want = ref.slice(at + 1).trim();
  if (!id) {
    throw new RoadmapError(
      `Reference "${ref}" names an installation but no record. Write <id>@<installation>, e.g. "R-4@${want || 'dev.roadmap'}".`,
    );
  }
  if (!want) {
    throw new RoadmapError(
      `Reference "${ref}" ends in '@' with no installation after it. Write <id>@<installation>, or drop the '@' to mean this installation's ${id}.`,
    );
  }
  if (!i) {
    throw new RoadmapError(
      `Reference "${ref}" names installation '${want}', but this process resolved no installation and cannot check that claim. `
      + `Nothing was read or written. Use a bare "${id}".`,
    );
  }
  if (namesInstallation(i, want)) return id;
  throw new RoadmapError(
    `Reference "${ref}" names installation '${want}', but this is installation '${i.label}' (home ${i.home}, store ${i.db}). `
    + `Nothing was read or written. Each installation mints its own ids, so "${id}" here is a DIFFERENT record from "${id}" there — `
    + `a reference carried across is refused rather than resolved. Drop the qualifier to mean this installation's ${id}, `
    + `or run against '${want}'.`,
  );
}
