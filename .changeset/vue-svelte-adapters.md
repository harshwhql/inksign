---
'@inksign/vue': minor
'@inksign/svelte': minor
'@inksign/ui': patch
---

Add Vue 3 and Svelte adapters.

`@inksign/vue` provides composables over the engine's keyed subscriptions, bound to `shallowRef` and tied to the active effect scope, plus signature capture, a virtualized document viewer, field components and the signing ceremony. Components are written as render functions, so the package needs no single file component compiler and its declarations come from real TypeScript.

`@inksign/svelte` provides the reactive layer as Svelte stores and the imperative parts as actions. Neither needs the Svelte compiler, so it works unchanged in Svelte 3, 4 and 5, and the markup stays with the host application. At 2.3 kB, or 401 bytes importing only the stores, it is the smallest adapter.

Both carry the render-isolation test the React adapter has: thirty subscribed fields, one write, and the other twenty-nine must not update.

`@inksign/ui` no longer crashes when imported without a DOM. The custom element declared `class X extends HTMLElement`, which is evaluated at import time, so server rendering in Nuxt, SvelteKit or Next failed on the import alone. The base class is now resolved lazily, with a pure annotation so the module still tree-shakes, and a server-rendering test covers it.
