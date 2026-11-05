# @inksign/core

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html). From the
next release onwards these entries are generated from changesets.

## 0.1.0

Initial release.

### Added

- Envelope model and a fluent builder that resolves author-supplied aliases to
  generated IDs, so a typo in a recipient name fails at build time rather than
  producing an envelope with an unassigned signature field.
- Envelope and recipient lifecycle state machines. Transitions absent from the
  table are rejected, so a replayed request cannot resurrect a completed
  envelope.
- Recipient routing across ten roles, with sequential and parallel stages,
  signing groups satisfied by any one member, and witness and notary roles that
  cannot act before the recipient they attest for.
- Nineteen field types with validation, conditional visibility, and cycle
  detection over the dependency graph.
- Signing sessions that own every rule about what a recipient may do: consent
  and authentication gates, required-field enforcement that ignores hidden
  fields, decline, and delegation.
- A hash-chained audit trail. Each entry commits to the one before it, so
  removing, editing or reordering any entry invalidates every digest after it
  and verification names the offending index.
- Tamper-evident sealing over the envelope structure, captured values, final
  document bytes and the audit chain head, optionally bound to a server-held
  secret.
- A normalized store with keyed subscriptions. Writes are O(1) and notify only
  the affected field.
- Adapter interfaces for storage, identity, notification, persistence, clock,
  context and webhooks, with in-memory implementations for tests.

Zero runtime dependencies.
