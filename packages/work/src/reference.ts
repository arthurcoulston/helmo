// A record reference that says which installation it came from (H-2502).
//
// H-2474 taught every surface to say which installation it IS. This is the
// other direction, and the sharper one. Two installations of Helmo mint ids
// from their own counters, so `H-267` exists in both and means two unrelated
// records. An agent that read `H-267` in installation A and asked installation
// B for it got an answer — a confident, well-formed, entirely wrong answer.
// Nothing was malformed: the id is the shape ids have, and B really does have
// one. That is the H-2431 shape again — the act was right, the target was
// assumed.
//
// The fix is a spelling that carries the target with the id: `H-267@dev.helmo.b`,
// the same `thing@where` idiom this estate already writes evidence refs in.
// Split at the FIRST '@', so the qualifier can be any of the three spellings
// `--installation` takes — the label a surface printed, the installation home,
// or the store path a roster points at — and like that flag it ASSERTS and can
// never redirect: a reference naming another installation is refused, never
// forwarded, because forwarding it would open a second store from a process
// already bound to one.
//
// A bare `H-267` keeps working everywhere, and must: within one installation an
// id is unambiguous, which is every single-install user and every caller
// written before this existed.
import { Installation, namesInstallation } from './install.js';
import { HelmoError } from './types.js';

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
    throw new HelmoError(
      `Reference "${ref}" names an installation but no record. Write <id>@<installation>, e.g. "H-42@${want || 'dev.helmo'}".`,
    );
  }
  if (!want) {
    throw new HelmoError(
      `Reference "${ref}" ends in '@' with no installation after it. Write <id>@<installation>, or drop the '@' to mean this installation's ${id}.`,
    );
  }
  if (!i) {
    throw new HelmoError(
      `Reference "${ref}" names installation '${want}', but this process resolved no installation and cannot check that claim. `
      + `Nothing was read or written. Use a bare "${id}".`,
    );
  }
  if (namesInstallation(i, want)) return id;
  throw new HelmoError(
    `Reference "${ref}" names installation '${want}', but this is installation '${i.label}' (home ${i.home}, store ${i.db}). `
    + `Nothing was read or written. Each installation mints its own ids, so "${id}" here is a DIFFERENT record from "${id}" there — `
    + `a reference carried across is refused rather than resolved. Drop the qualifier to mean this installation's ${id}, `
    + `or run against '${want}'.`,
  );
}
