# @inksign/pdf

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html). From the
next release onwards these entries are generated from changesets.

## 0.1.0

Initial release.

### Added

- Coordinate geometry across PDF user space, field space and CSS pixels, with
  rotation handling. Round-trips are tested through all four rotations at four
  scales.
- A page renderer with cancellable renders, bounded concurrency, scale
  bucketing, and an LRU cache bounded by total pixels rather than entry count.
- Anchor-based field placement off the text layer, including reassembling glyph
  runs into words so a multi-word anchor matches.
- Field flattening into page content rather than interactive form fields, with
  vector signature paths preferred over raster and repeated signatures embedded
  once.
- A generated certificate of completion.
- `setPdfJs` and `setPdfLib` for supplying either peer dependency yourself,
  which is how you pin a build, load from a CDN, or use pdf.js in Node where it
  needs its legacy build.
