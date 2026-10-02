#!/usr/bin/env node
// The old name for `helmo serve work`. COMPATIBILITY.md row 17: this one is a
// one-release window, because its only consumers are this estate's own
// service definitions.
if (Date.now() > Date.parse('2027-01-01T23:59:59.999Z')) {
  console.error("helmo-view stopped working after 2027-01-01; use 'helmo serve work'.");
  process.exit(2);
}
console.error(
  "helmo-view is now 'helmo serve work' — this name keeps working for one more release and refuses after 2027-01-01 (COMPATIBILITY.md).",
);
await import('../dist/view.js');
