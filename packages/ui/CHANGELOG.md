# @inksign/ui

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html). From the
next release onwards these entries are generated from changesets.

## 0.1.0

Initial release.

### Added

- Variable-width stroke rendering that builds and fills an outline rather than
  stroking a path, so width varies with stylus pressure or, failing that, with
  velocity.
- A signature pad controller that keeps drawing off the framework's reactivity,
  repainting only the in-progress stroke so latency stays flat.
- Typed and uploaded signature support. No webfont is bundled.
- Document layout and virtualization, with the first visible page found by
  binary search rather than a scan per scroll event.
- White-label theming over CSS custom properties, with a palette derived from a
  single brand colour and text contrast chosen by measurement rather than a
  luminance threshold.
- A WCAG AA contrast auditor.
- Accessibility helpers: a shared live region, a focus trap that restores focus
  on release, field descriptions, and keyboard field navigation.
- A `<inksign-signature-pad>` web component, registered explicitly so the
  module stays tree-shakeable and server rendering is unaffected.
