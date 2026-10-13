# anti-slop upstream

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied from: `skills/install-anti-slop/assets/anti-slop/`, verified byte-for-byte against `src/` by the upstream `check:skill-assets` script. Upstream test files are excluded from this distribution.
- Installed at: `tools/oxlint/anti-slop/`
- Entry points: `index.ts` (generic) and `effect/index.ts` (Effect).
- License: upstream MIT license in `LICENSE`; nested ESLint Stylistic license and provenance in `vendor/eslint-stylistic/`.
- Dependencies: `oxlint` and `@oxlint/plugins`, both pinned to `1.87.0`.
- Local policy: all generic rules, native `oxc/no-accumulating-spread`, and all Effect rules enabled at error severity in `.oxlintrc.json`.
- Intentional source deviations: none.

These files are owned by this repository. Review upstream changes and preserve local customizations when updating.
