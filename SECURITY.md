# Security

Helm is a local-first tool: the store is a SQLite file on your machine, the
view binds to localhost, and nothing phones home. Its threat surface is
correspondingly small, but not zero — the view renders agent-written text,
and the MCP/CLI write paths trust the actor identity they are given.

If you find a vulnerability, please use GitHub's private vulnerability
reporting on this repository ("Report a vulnerability" under the Security
tab) rather than a public issue. Reports get a response within a week.
