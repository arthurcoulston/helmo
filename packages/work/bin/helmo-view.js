#!/usr/bin/env node
// The old name for `helmo serve work`. COMPATIBILITY.md row 17: this one is a
// one-release window, because its only consumers are this estate's own
// service definitions.
console.error(
  "helmo-view is now 'helmo serve work' — this name keeps working for one more release and refuses after 2027-01-01 (COMPATIBILITY.md).",
);
await import('../dist/view.js');
