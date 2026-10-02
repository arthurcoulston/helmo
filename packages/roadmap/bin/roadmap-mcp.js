#!/usr/bin/env node
// The old name for `helmo mcp roadmap`. On stderr, beside this server's own
// installation line; stdout is the MCP protocol channel. COMPATIBILITY.md
// row 16.
console.error(
  "roadmap-mcp is now 'helmo mcp roadmap' — this name keeps working for two more releases and refuses after 2027-04-01 (COMPATIBILITY.md).",
);
await import('../dist/server.js');
