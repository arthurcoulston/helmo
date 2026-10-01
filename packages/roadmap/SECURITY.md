# Security

Roadmap stores project records in a local SQLite database. Its dashboard binds
to localhost and has no write routes. The MCP server trusts the actor identity
its caller supplies; those fields record provenance, not authentication.
Keep the database and its backups private. Do not expose the dashboard or MCP
server publicly without a separately reviewed authentication boundary.

For a vulnerability, use this repository's GitHub private vulnerability
reporting (Security → Report a vulnerability), not a public issue. Before a
public release, the maintainer must enable and test that private channel;
this document does not assert that an unpublished repository's channel is
already available.
