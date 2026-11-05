# @inksign/svelte

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html). From the
next release onwards these entries are generated from changesets.

## 0.1.0

Initial release.

### Added

- The reactive layer as Svelte stores, implementing the store contract directly
  so it needs no compiler and works unchanged in Svelte 3, 4 and 5. The
  underlying engine subscription opens on the first subscriber and closes when
  the last one leaves.
- `writableField` for `bind:`, which still routes writes through the session so
  the rules cannot be bypassed.
- Actions for signature capture, document virtualization and page rendering.
- `createDocument` for loading a PDF and exposing the renderer as a store.
