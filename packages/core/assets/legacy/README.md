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

The shadcn MIT notice remains in the root `THIRD_PARTY_NOTICES.md`.
