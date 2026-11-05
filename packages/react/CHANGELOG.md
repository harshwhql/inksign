# @inksign/react

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html). From the
next release onwards these entries are generated from changesets.

## 0.1.0

Initial release.

### Added

- A provider holding the store and session outside React state, so a re-render
  cannot discard a recipient's progress.
- Hooks over `useSyncExternalStore` with per-field keyed subscriptions, so
  typing in one input re-renders that input and nothing else.
- Signature capture, a virtualized document viewer with a field overlay, field
  components, and the signing ceremony with its consent and authentication
  gates.
