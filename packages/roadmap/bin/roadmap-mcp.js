#!/usr/bin/env node
// The old name for `helmo mcp roadmap`. On stderr, beside this server's own
// installation line; stdout is the MCP protocol channel. COMPATIBILITY.md
// row 16.
if (Date.now() > Date.parse('2027-04-01T23:59:59.999Z')) {
  console.error("roadmap-mcp stopped working after 2027-04-01; use 'helmo mcp roadmap'.");
  process.exit(2);
}
console.error(
  "roadmap-mcp is now 'helmo mcp roadmap' — this name keeps working for two more releases and refuses after 2027-04-01 (COMPATIBILITY.md).",
);
await import('../dist/server.js');
