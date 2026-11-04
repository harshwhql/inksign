---
'@inksign/core': minor
'@inksign/pdf': minor
'@inksign/ui': minor
'@inksign/react': minor
---

First release.

`@inksign/core` is the engine: envelope model and builder, lifecycle state machine, recipient routing with groups and attestation roles, conditional field logic, validation, signing sessions, and a hash-chained audit trail with tamper-evident sealing. No runtime dependencies.

`@inksign/pdf` covers coordinate geometry across PDF, field and CSS space with rotation support, a page renderer with cancellation and a pixel-budgeted cache, anchor placement off the text layer, field flattening, and a generated certificate of completion.

`@inksign/ui` provides variable-width signature capture, document layout with virtualization, white-label theming over CSS custom properties, accessibility helpers, and web components.

`@inksign/react` provides a provider, keyed hooks over `useSyncExternalStore`, signature capture, a virtualized document viewer, and the signing ceremony.
