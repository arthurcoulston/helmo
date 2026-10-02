#!/usr/bin/env node
// The old name for `helmo work`. It still does exactly what it always did —
// this file adds one line on stderr and nothing else, because helmo-cli's
// contract is that its stdout is one parseable JSON object. COMPATIBILITY.md
// row 13 carries the window.
console.error(
  "helmo-cli is now 'helmo work' — this name keeps working for two more releases and refuses after 2027-04-01 (COMPATIBILITY.md).",
);
await import('../dist/cli.js');
