# @inksign/ui

## 0.2.0

### Minor Changes

- [`4ab987c`](https://github.com/harshwhql/inksign/commit/4ab987c5863553d73c505f0930a67e247b65fede) Thanks [@harshwhql](https://github.com/harshwhql)! - First release.

  `@inksign/core` is the engine: envelope model and builder, lifecycle state machine, recipient routing with groups and attestation roles, conditional field logic, validation, signing sessions, and a hash-chained audit trail with tamper-evident sealing. No runtime dependencies.

  `@inksign/pdf` covers coordinate geometry across PDF, field and CSS space with rotation support, a page renderer with cancellation and a pixel-budgeted cache, anchor placement off the text layer, field flattening, and a generated certificate of completion.

  `@inksign/ui` provides variable-width signature capture, document layout with virtualization, white-label theming over CSS custom properties, accessibility helpers, and web components.

  `@inksign/react` provides a provider, keyed hooks over `useSyncExternalStore`, signature capture, a virtualized document viewer, and the signing ceremony.

### Patch Changes

- [`3491f83`](https://github.com/harshwhql/inksign/commit/3491f83a9938599bbf2937e634412cbba213e1f6) Thanks [@harshwhql](https://github.com/harshwhql)! - Fix what the published tarballs contain.

  Every package was shipping `dist/.tsbuildinfo`, TypeScript's incremental build cache, and most were also shipping `dist/types/**`, the `tsc --build` output, which duplicated the declarations tsup already emits as `dist/index.d.ts`. Between them that was roughly 40 percent dead weight and a second declaration tree that could confuse resolution. The typecheck build now writes outside `dist` entirely.

  Source files are now published alongside the sourcemaps, so the maps resolve. A sourcemap pointing at files that were never published is worse than no sourcemap: it makes a consumer's bundler warn on every build.

- [`daca1be`](https://github.com/harshwhql/inksign/commit/daca1bed574687071411fac1cade4cb9ccd92ce2) Thanks [@harshwhql](https://github.com/harshwhql)! - Add Vue 3 and Svelte adapters.

  `@inksign/vue` provides composables over the engine's keyed subscriptions, bound to `shallowRef` and tied to the active effect scope, plus signature capture, a virtualized document viewer, field components and the signing ceremony. Components are written as render functions, so the package needs no single file component compiler and its declarations come from real TypeScript.

  `@inksign/svelte` provides the reactive layer as Svelte stores and the imperative parts as actions. Neither needs the Svelte compiler, so it works unchanged in Svelte 3, 4 and 5, and the markup stays with the host application. At 2.3 kB, or 401 bytes importing only the stores, it is the smallest adapter.

  Both carry the render-isolation test the React adapter has: thirty subscribed fields, one write, and the other twenty-nine must not update.

  `@inksign/ui` no longer crashes when imported without a DOM. The custom element declared `class X extends HTMLElement`, which is evaluated at import time, so server rendering in Nuxt, SvelteKit or Next failed on the import alone. The base class is now resolved lazily, with a pure annotation so the module still tree-shakes, and a server-rendering test covers it.

- Updated dependencies [[`4ab987c`](https://github.com/harshwhql/inksign/commit/4ab987c5863553d73c505f0930a67e247b65fede), [`3491f83`](https://github.com/harshwhql/inksign/commit/3491f83a9938599bbf2937e634412cbba213e1f6)]:
  - @inksign/core@0.2.0
  - @inksign/pdf@0.2.0
