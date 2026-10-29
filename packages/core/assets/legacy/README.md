# Legacy visual assets

These compatibility assets are part of the Helmo source distribution. They
were transferred byte-for-byte from the retired estate shell. The current
application preset remains governed by `UI.md`; these files only support
legacy views and do not define a new theme.

Regenerate the embedded modules with `npm run vendor:tokens -w @helmo/core`
and `npm run vendor:avatars --workspaces --if-present`. Drift checks always
run against these included sources, including in a standalone clone. No
sibling checkout or live installation supplies them. Explicit source-path
overrides are still available for deliberate development experiments.

The comments inside the transferred assets describe historical generators in
the retired estate shell. Its source archive retains those generators and
the original mark and frame SVGs; they are not required to regenerate Helmo's
embedded modules. The composed sprite and CSS here are Helmo's maintained
sources. Edit them here when changing these legacy views.

The shadcn MIT notice remains in the root `THIRD_PARTY_NOTICES.md`.
