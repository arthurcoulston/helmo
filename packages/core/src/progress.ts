/** The latest authored progress note on a record, which Work and Roadmap both
 *  carry on every row they draw and both show in one shared preview. Arthur
 *  chose this over adding an author-written description field (H-2988): every
 *  live ticket already has a note and 35 of 47 projects do, and it is the only
 *  thing in either store that says where a record stands rather than how it was
 *  filed. It is never a summary, and nothing labels it as one. */
export interface LatestProgress {
  at: string;
  note: string;
  actor: { name: string; kind?: string };
}

export const NOTE_BOUND = 280;

/** The note as a reader sees it: the author's own words, bounded, cut at a word
 *  boundary and admitting the cut.
 *
 *  The bound is not new — the store has always sent at most 280 characters — but
 *  it was a hard slice, which landed mid-word on 1,787 of the 2,066 notes in the
 *  live store long enough to be cut, and said nothing about having cut. That was
 *  survivable while the note sat near the foot of a full record. Now that it is
 *  the first thing an expanded row shows, a half-word that reads as a finished
 *  sentence is the failure that matters: the reader cannot tell a complete
 *  thought from a truncated one.
 *
 *  The same rule as the shell's `excerpt`, which bounds a record's opening on
 *  the display side. It cannot be the same function — the shell is a browser
 *  bundle and this package imports `node:fs` — so
 *  `packages/shell/test/record-preview.test.mjs` asserts the two agree on every
 *  input rather than leaving them to drift. */
export function boundNote(note: string, limit = NOTE_BOUND): string {
  const whole = Array.from(note.trim());
  if (whole.length <= limit) return whole.join('');
  const cut = whole.slice(0, limit).join('');
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}
