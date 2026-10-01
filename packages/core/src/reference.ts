import { Installation, InstallationConfig, namesResolvedInstallation } from './install.js';
export function qualifiedRecordRef(id: string, i?: Installation): string { return i ? `${id}@${i.label}` : id; }
export function localRecordRef(ref: string, i: Installation | undefined, c: InstallationConfig, example: string): string {
  const at = ref.indexOf('@'); if (at < 0) return ref; const id = ref.slice(0, at).trim(); const want = ref.slice(at + 1).trim();
  if (!id) throw new Error(`Reference "${ref}" names an installation but no record. Write <id>@<installation>, e.g. "${example}@${want || c.derivedPrefix}".`);
  if (!want) throw new Error(`Reference "${ref}" ends in '@' with no installation after it. Write <id>@<installation>, or drop the '@' to mean this installation's ${id}.`);
  if (!i) throw new Error(`Reference "${ref}" names installation '${want}', but this process resolved no installation and cannot check that claim. Nothing was read or written. Use a bare "${id}".`);
  if (namesResolvedInstallation(c, i, want)) return id;
  throw new Error(`Reference "${ref}" names installation '${want}', but this is installation '${i.label}' (home ${i.home}, store ${i.db}). Nothing was read or written. Each installation mints its own ids, so "${id}" here is a DIFFERENT record from "${id}" there — a reference carried across is refused rather than resolved. Drop the qualifier to mean this installation's ${id}, or run against '${want}'.`);
}
