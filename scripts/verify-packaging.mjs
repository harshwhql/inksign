/**
 * Packaging check.
 *
 * Builds real tarballs with `npm pack`, installs them into a throwaway
 * project, and imports every package through its published entry points.
 *
 * This catches a class of mistake nothing else does. The test suite imports
 * source files directly, so it never exercises the `exports` map, the `files`
 * list, or whether the declaration file the manifest points at was actually
 * emitted. Those only break for the people who install the package, which is
 * the worst possible time to find out.
 *
 * Run with: npm run verify:packaging
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGES = ['core', 'pdf', 'ui', 'react', 'vue', 'svelte']
const VERSION = '0.1.0'

/** Runs inside the throwaway project, where the packages are really installed. */
const CHECK_SOURCE = `
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { strict as assert } from 'node:assert'

const require = createRequire(import.meta.url)
const names = ${JSON.stringify(PACKAGES)}
let failures = 0

for (const name of names) {
  const pkg = '@inksign/' + name
  try {
    const esm = await import(pkg)
    assert.ok(Object.keys(esm).length > 0, 'ESM entry exported nothing')

    const cjs = require(pkg)
    assert.ok(Object.keys(cjs).length > 0, 'CJS entry exported nothing')

    const manifest = require(pkg + '/package.json')
    const typesPath = manifest.exports['.'].types.replace('./', '')
    assert.ok(
      existsSync(new URL('node_modules/' + pkg + '/' + typesPath, import.meta.url)),
      'declared types file ' + typesPath + ' is missing',
    )

    // Build output only: a published package must not carry the TypeScript
    // build cache or a duplicate declaration tree.
    for (const unwanted of ['dist/.tsbuildinfo', 'dist/types/index.d.ts']) {
      assert.ok(
        !existsSync(new URL('node_modules/' + pkg + '/' + unwanted, import.meta.url)),
        'published ' + unwanted + ', which no consumer needs',
      )
    }

    const exported = Object.keys(esm).filter((key) => key !== 'default').length
    console.log(
      '  ok  ' + pkg.padEnd(18) + ' esm ' + exported + ', cjs ' + Object.keys(cjs).length + ', types present',
    )
  } catch (error) {
    failures += 1
    console.error('  FAIL  ' + pkg + ': ' + error.message)
  }
}

const { createEnvelope, EnvelopeStore, createSession, AuditTrail, verifyTrail } =
  await import('@inksign/core')

const envelope = createEnvelope({ subject: 'Packaging check' })
  .document('d', { name: 'd.pdf', source: { kind: 'url', url: 'https://example.com/d.pdf' } })
  .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
  .settings({ requireConsent: false })
  .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600, required: true })
  .build()

const store = new EnvelopeStore({ ...envelope, status: 'sent' })
const session = createSession(store, envelope.recipients[0].id)
await session.adoptSignature({ source: 'drawn', width: 300, height: 90, paths: ['M 0 0 L 10 10'] })
await session.finish()
assert.equal(store.getMeta().status, 'completed')

const trail = new AuditTrail(envelope.id)
await trail.append({ action: 'envelope_sent' })
assert.equal((await verifyTrail(trail.list())).valid, true)
console.log('  ok  a full signing flow through the published entry points')

const { fieldValue } = await import('@inksign/svelte')
let pushed = 0
fieldValue(store, store.fieldIds()[0]).subscribe(() => { pushed += 1 })
assert.equal(pushed, 1, 'a Svelte store must call its subscriber synchronously')
console.log('  ok  the Svelte store contract holds')

if (failures > 0) {
  console.error('\\n' + failures + ' package(s) failed')
  process.exitCode = 1
} else {
  console.log('\\nall ' + names.length + ' packages install and import cleanly')
}
`

const repoRoot = resolve(import.meta.dirname, '..')
const workspace = join(tmpdir(), 'inksign-packaging-check')
const tarballs = join(workspace, 'tarballs')
const app = join(workspace, 'app')

/**
 * Runs a command through the shell with every argument quoted.
 *
 * Node 25 refuses to spawn a `.cmd` shim without a shell, and passing an
 * argument array with `shell: true` concatenates without escaping. Quoting
 * here sidesteps both. Every path fed in is one this script constructed, not
 * user input, but the repository path can contain spaces.
 */
function run(command, args, cwd) {
  const quoted = args.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(' ')
  return execSync(`${command} ${quoted}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

console.log('Packing...')
rmSync(workspace, { recursive: true, force: true })
mkdirSync(tarballs, { recursive: true })
mkdirSync(app, { recursive: true })

for (const name of PACKAGES) {
  run('npm', ['pack', '--pack-destination', tarballs], join(repoRoot, 'packages', name))
  if (!existsSync(join(tarballs, `inksign-${name}-${VERSION}.tgz`))) {
    console.error(`  FAIL  @inksign/${name} did not produce a tarball`)
    process.exit(1)
  }
}

// Relative specifiers, because an absolute POSIX path from a Git Bash shell is
// not what npm on Windows resolves it to.
const dependency = (name) => `file:../tarballs/inksign-${name}-${VERSION}.tgz`

writeFileSync(
  join(app, 'package.json'),
  `${JSON.stringify(
    {
      name: 'inksign-packaging-check',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(
        PACKAGES.map((name) => [`@inksign/${name}`, dependency(name)]),
      ),
      // The adapters depend on sibling versions that are not on the registry
      // yet, so the tarballs have to satisfy each other.
      overrides: Object.fromEntries(
        ['core', 'pdf', 'ui'].map((name) => [`@inksign/${name}`, dependency(name)]),
      ),
    },
    null,
    2,
  )}\n`,
)

console.log('Installing...')
run('npm', ['install', '--no-audit', '--no-fund'], app)

writeFileSync(join(app, 'check.mjs'), CHECK_SOURCE)

console.log('Importing...\n')
try {
  process.stdout.write(run(`"${process.execPath}"`, ['check.mjs'], app))
} catch (error) {
  process.stdout.write(error.stdout ?? '')
  process.stderr.write(error.stderr ?? '')
  process.exit(1)
}

rmSync(workspace, { recursive: true, force: true })
