# Versioning

Helmo has one product version. The root workspace and the Work, Roadmap,
Runtime, and Core packages carry that same version; shipped protocol surfaces
also report it. `0.6.0` is the first consolidated version and follows the
existing public `v0.5.0` tag.

Helmo uses semantic versioning for its public compatibility surface:

- MCP tool names and argument schemas
- CLI subcommands and flags
- Work and Roadmap store schemas
- configuration and environment keys
- service labels and default ports

A breaking change to any of those requires a major version. A backward-
compatible addition requires a minor version. A compatible correction requires
a patch version. Removing an accepted argument, narrowing an accepted value,
or changing write or read meaning is breaking even when the wire shape remains
valid. Everything outside this list is internal and does not itself determine
the version.

During an upgrade, the released consolidated version and its immediately
preceding consolidated version are supported together for the documented
two-release compatibility window. Compatibility does not authorize a store
migration or a service-name, port, configuration-key, or entry-point change;
those require their own reviewed migration and recovery contract.

## Accepted legacy spellings

An installation-qualified reference is written `<id>@<installation>`, and a
qualifier naming a different installation is refused rather than resolved —
each installation mints its own ids, so the same `H-1` in two of them is two
unrelated records. Because of that refusal, a change to what an installation
calls itself does not announce itself: references that were correct when
written simply stop resolving. So each installation answers to a declared set
of names, not one.

| Accepted | Meaning |
|---|---|
| the resolved label | What this installation calls itself now, and the only spelling a new reference is ever written in |
| `dev.helmo…` / `dev.roadmap…` | The name an area's conventional home derives standing alone, accepted when the running label is the same name under `dev.rev…` |
| the home or store path | A reference qualified by `HELMO_HOME`, `HELMO_DB`, `ROADMAP_HOME` or `ROADMAP_DB` rather than by name |

The second row is the legacy set. One installation supervised by Runtime is
named `dev.rev…` in every environment it spawns, while the same home standing
alone derives `dev.helmo…` or `dev.roadmap…`; both spellings name it, and
references in the older spelling keep resolving. **This estate has 45 of them
recorded** — see `c1/verify-qualified-refs.mjs` in the consolidation notes,
which resolves every qualified reference in both live stores and requires each
one outside the declared set to still refuse.

Accepting an alias is not minting one: `qualifiedRecordRef` hands out the
resolved label only, so the set never grows from use. The legacy set is
supported for the two-release window above; after it, a legacy spelling refuses
with the canonical spelling named in the message.
