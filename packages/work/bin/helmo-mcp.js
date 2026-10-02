#!/usr/bin/env node
// The old name for `helmo mcp work`. The notice goes on stderr, which is also
// where this server already prints its installation line: stdout is the MCP
// protocol channel and carries nothing else. COMPATIBILITY.md row 15.
console.error(
  "helmo-mcp is now 'helmo mcp work' — this name keeps working for two more releases and refuses after 2027-04-01 (COMPATIBILITY.md).",
);
await import('../dist/server.js');
