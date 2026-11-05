# @inksign/vue

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html). From the
next release onwards these entries are generated from changesets.

## 0.1.0

Initial release.

### Added

- `provideInkSign`, composables bound to `shallowRef` and tied to the active
  effect scope, so an unmounting component takes its subscription with it.
- Signature capture, a virtualized document viewer with a field overlay, field
  components, and the signing ceremony with its consent and authentication
  gates.

Components are written as render functions, so the package needs no single file
component compiler and its declarations come from real TypeScript.
