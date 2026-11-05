---
'@inksign/core': patch
'@inksign/pdf': patch
'@inksign/ui': patch
'@inksign/react': patch
'@inksign/vue': patch
'@inksign/svelte': patch
---

Fix what the published tarballs contain.

Every package was shipping `dist/.tsbuildinfo`, TypeScript's incremental build cache, and most were also shipping `dist/types/**`, the `tsc --build` output, which duplicated the declarations tsup already emits as `dist/index.d.ts`. Between them that was roughly 40 percent dead weight and a second declaration tree that could confuse resolution. The typecheck build now writes outside `dist` entirely.

Source files are now published alongside the sourcemaps, so the maps resolve. A sourcemap pointing at files that were never published is worse than no sourcemap: it makes a consumer's bundler warn on every build.
