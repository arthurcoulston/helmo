# Security

Helmo is local-first. The Work and Roadmap stores are SQLite files on your
machine, every view binds to localhost, and nothing phones home. The threat
surface is correspondingly small but not zero, and it differs by area.

**Work and Roadmap.** The views render agent-written text. The MCP and CLI
write paths trust the actor identity they are given: those fields record
provenance, not authentication. Keep the stores and their backups private, and
do not expose a view or an MCP server publicly without a separately reviewed
authentication boundary.

**Runtime.** Rev launches agent processes, passes them a deliberately scrubbed
environment, and reads and writes machine-local state. Those sessions run with
the agent CLI's permission prompts and sandbox disabled, unattended, in the
folder the roster names — that is the design and not a vulnerability; the
README's "What a loop session can do" states it plainly, and it is what an
operator consents to when they register a loop. The folder is a starting
directory, the constitution is behavioral guidance, and the MCP allowlist
configures tools; none of them confines shell, filesystem, or network access.
The account's permissions are the effective security boundary.

A vulnerability that exceeds those permissions, exposes credentials, executes
unintended commands, or permits an untrusted network writer is
security-sensitive.

## Reporting

Use GitHub's private vulnerability reporting on this repository — **Report a
vulnerability** on the Security tab — not a public issue, and not a public
issue with exploit details. Reports receive an acknowledgement through that
private channel within a week.

Before a public release, the maintainer must enable and test that private
channel. This document does not assert that an unpublished repository's channel
is already available.
