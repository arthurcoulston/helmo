#!/usr/bin/env node
// The old name for `helmo work`. It still does exactly what it always did —
// this file adds one line on stderr and nothing else, because helmo-cli's
// contract is that its stdout is one parseable JSON object. COMPATIBILITY.md
// row 13 carries the window.
if (Date.now() > Date.parse('2027-04-01T23:59:59.999Z')) {
  console.error("helmo-cli stopped working after 2027-04-01; use 'helmo work'.");
  process.exit(2);
}
console.error(
  "helmo-cli is now 'helmo work' — this name keeps working for two more releases and refuses after 2027-04-01 (COMPATIBILITY.md).",
);
await import('../dist/cli.js');
