/**
 * Runtime floor check.
 *
 * The packages declare `engines: node >=18.18`, and a declared floor nobody
 * tests is just a number in a manifest. This exercises the built output on
 * whichever Node runs it, with no install and no test runner, so it can be
 * pointed at old Node versions that the development toolchain itself refuses
 * to install on.
 *
 * It covers the parts most likely to break on an older runtime: WebCrypto for
 * the audit chain, and the ESM and CommonJS entry points both resolving.
 *
 * Run with: node scripts/smoke.mjs
 */

import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const esm = await import('../packages/core/dist/index.js')
const cjs = require('../packages/core/dist/index.cjs')

let checks = 0
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks += 1
      console.log(`  ok  ${label}`)
    })
    .catch((error) => {
      console.error(`  FAIL  ${label}`)
      console.error(error)
      process.exitCode = 1
    })
}

console.log(`Runtime floor check on Node ${process.version}`)

await check('both entry points expose the same API surface', () => {
  assert.equal(typeof esm.createEnvelope, 'function')
  assert.equal(typeof cjs.createEnvelope, 'function')
  assert.equal(esm.VERSION, cjs.VERSION)
})

await check('WebCrypto is available for the audit chain', async () => {
  const digest = await esm.sha256Text('inksign')
  assert.equal(digest.length, 64)
  assert.match(digest, /^[0-9a-f]{64}$/)
})

await check('an envelope builds and validates', () => {
  const envelope = esm
    .createEnvelope({ subject: 'Smoke test' })
    .document('d', { name: 'd.pdf', source: { kind: 'url', url: 'https://example.com/d.pdf' } })
    .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
    .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600, required: true })
    .build()

  assert.equal(envelope.status, 'draft')
  assert.equal(envelope.fields.length, 1)
  assert.equal(esm.validateEnvelope(envelope).valid, true)
})

await check('the builder rejects a bad reference', () => {
  assert.throws(() =>
    esm
      .createEnvelope({ subject: 'Typo' })
      .document('d', { name: 'd.pdf', source: { kind: 'url', url: 'https://example.com/d.pdf' } })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ recipient: 'alise', type: 'signature' })
      .build(),
  )
})

await check('a signing session completes', async () => {
  const draft = esm
    .createEnvelope({ subject: 'Smoke test' })
    .document('d', { name: 'd.pdf', source: { kind: 'url', url: 'https://example.com/d.pdf' } })
    .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
    .settings({ requireConsent: false })
    .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600, required: true })
    .build()

  const store = new esm.EnvelopeStore({ ...draft, status: 'sent' })
  const session = esm.createSession(store, draft.recipients[0].id)

  assert.equal(session.canFinish(), false)

  await session.adoptSignature({
    source: 'drawn',
    width: 300,
    height: 90,
    paths: ['M 0 0 L 10 10'],
  })

  assert.equal(session.canFinish(), true)
  await session.finish()
  assert.equal(store.getMeta().status, 'completed')
})

await check('the audit chain verifies and detects tampering', async () => {
  const trail = new esm.AuditTrail('env_smoke')
  await trail.append({ action: 'envelope_created' })
  await trail.append({ action: 'envelope_sent' })
  await trail.append({ action: 'recipient_signed', recipientId: 'r1' })

  assert.equal((await trail.verify()).valid, true)

  const entries = trail.list().slice()
  entries[1] = { ...entries[1], action: 'envelope_voided' }
  const broken = await esm.verifyTrail(entries)

  assert.equal(broken.valid, false)
  assert.equal(broken.brokenAt, 1)
})

await check('field subscriptions stay keyed', () => {
  const draft = esm
    .createEnvelope({ subject: 'Keyed' })
    .document('d', { name: 'd.pdf', source: { kind: 'url', url: 'https://example.com/d.pdf' } })
    .signer('alice', { name: 'Alice', email: 'alice@example.com' })
    .field({ alias: 'a', recipient: 'alice', type: 'text', page: 0, x: 10, y: 10 })
    .field({ alias: 'b', recipient: 'alice', type: 'text', page: 0, x: 10, y: 40 })
    .field({ recipient: 'alice', type: 'signature', page: 0, x: 10, y: 100 })
    .build()

  const store = new esm.EnvelopeStore(draft)
  const [first, second] = store.fieldIds()

  let firstHits = 0
  let secondHits = 0
  store.subscribeValue(first, () => {
    firstHits += 1
  })
  store.subscribeValue(second, () => {
    secondHits += 1
  })

  store.setValue(first, { kind: 'text', value: 'typed' })
  store.flush()

  assert.equal(firstHits, 1)
  assert.equal(secondHits, 0, 'writing one field must not notify another')
})

if (process.exitCode === 1) {
  console.error('\nRuntime floor check FAILED')
} else {
  console.log(`\n${checks} checks passed on Node ${process.version}`)
}
