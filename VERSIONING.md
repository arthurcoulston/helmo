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
