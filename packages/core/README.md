# @inksign/core

The InkSign engine: envelopes, recipient routing, field logic, signing sessions and tamper-evident audit trails. **Zero runtime dependencies**, no framework, no DOM.

Part of [InkSign](https://github.com/harshwhql/inksign). 15.0 kB minified and gzipped, and it tree-shakes: importing only the builder, store, session and validation costs 12.9 kB.

```bash
npm install @inksign/core
```

## Build an envelope

```ts
import { createEnvelope } from '@inksign/core'

const envelope = createEnvelope({ subject: 'Mutual NDA' })
  .document('nda', { name: 'NDA.pdf', source: { kind: 'url', url: '/nda.pdf' } })
  .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
  .signer('bob', { name: 'Bob Diaz', email: 'bob@example.com' })
  .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 640, required: true })
  .field({ recipient: 'bob', type: 'signature', page: 0, x: 72, y: 700, required: true })
  .build()
```

You name documents and recipients once and refer to those names. Threading generated IDs by hand is where misassignment bugs come from, so a typo in a recipient name throws at build time and lists what was available, rather than producing an envelope with an unassigned signature field.

`build()` validates. It rejects a required field nobody owns, a field on a page the document does not have, a field assigned to a carbon-copy recipient, an invalid validation pattern, and conditional visibility cycles. It warns about a signer with nothing to do.

## Run a signing session

```ts
import { EnvelopeStore, createSession } from '@inksign/core'

const store = new EnvelopeStore({ ...envelope, status: 'sent' })
const session = createSession(store, aliceId, { adapters })

await session.acceptConsent()
await session.adoptSignature(signature) // applies to every signature field

session.blockingReason()
// { code: 'REQUIRED_FIELDS_INCOMPLETE', message: '1 required field is still empty' }

session.setValue(titleField, { kind: 'text', value: 'General Counsel' })
if (session.canFinish()) await session.finish()
```

The session is the gatekeeper. It refuses to open out of turn, blocks input before consent, hides fields whose conditions are unmet and does not require them, and rejects a value for a field belonging to someone else. Put your UI in front of it and those rules cannot be skipped by accident.

## Subscribe to one field

```ts
const off = store.subscribeValue(fieldId, () => {
  render(store.getValue(fieldId))
})
```

Subscriptions are keyed, so writing one value notifies that field and nothing else. Reads are O(1), and writes replace one immutable object inside a mutable map rather than cloning a 400-entry collection. This is what makes a long contract usable.

## Audit trail

```ts
import { AuditTrail, verifyTrail } from '@inksign/core'

const trail = new AuditTrail(envelope.id)
await trail.append({ action: 'envelope_sent' })

await verifyTrail(trail.list()) // { valid: true, head: '...' }
```

Each entry commits to the digest of the one before it, so removing, editing or reordering any entry invalidates every digest after it, and verification names the offending index.

## Sealing

```ts
import { seal, verifySeal } from '@inksign/core'

const sealed = await seal({ envelope, values, documents, trail, secret: process.env.SEAL_SECRET })
const check = await verifySeal(sealed, { envelope, values, documents, trail })
```

The seal covers the envelope structure, the captured values, the final PDF bytes and the audit chain head. `verifySeal` runs every check even after one fails, so the report says what was tampered with rather than stopping at the first problem.

What it proves and what it does not is set out in the [main README](https://github.com/harshwhql/inksign#what-the-audit-trail-proves). In short: it proves integrity, and with a server-held secret, issuance. It does not prove the time, and it is not a PKI digital signature.

## Adapters

Storage, identity, notification, persistence, clock, context and webhooks are interfaces you implement, because a browser cannot verify its own identity and a local timestamp is not evidence of anything. Every adapter is optional, and a flow needing a missing one fails with `ADAPTER_MISSING` rather than degrading silently. In-memory implementations are included for tests, and they say so.

## License

MIT
