# Releasing

## What npm actually requires

Publishing to the registry needs **either** two-factor authentication enabled on
the account **or** a granular access token with "bypass 2FA". An ordinary
logged-in session satisfies neither and is refused with a 403 that reads:

```
403 Forbidden - Two-factor authentication or granular access token with
bypass 2fa enabled is required to publish packages.
```

That message is easy to misread. It does not mean your 2FA code was wrong or
missing. It means the credential in use is not one of the two npm accepts. If
2FA is off on the account, there is no code to supply and `--otp` cannot help.
Check first:

```bash
npm profile get
```

`two-factor auth: auth-and-writes` is what allows publishing. `disabled` does
not, whatever token is configured.

Note also that npm is [restricting bypass-2FA
tokens](https://gh.io/npm-gat-bypass2fa-deprecation) for direct publishing, so
that route is the less durable of the two.

## Manual, from a laptop

This is how 0.1.0 was published. It needs 2FA enabled on the account, which the
CLI satisfies through a browser approval rather than by prompting for a code.

```bash
npm run verify:packaging
```

```bash
npm run publish:all
```

One command covers all six workspaces. npm prints a `https://www.npmjs.com/auth/cli/...`
link and waits; approve it in the browser and the remaining packages publish on
the same approval. The example workspace is marked private, so npm skips it.

Publishing takes a few minutes to propagate. Until it does, the registry serves
a `0.0.0-stage` placeholder and `npm view` returns a 404, which is expected and
not a failed publish. Confirm with:

```bash
npm view @inksign/core version
```

Then tag:

```bash
git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
```

Publishing this way does **not** produce provenance, which requires a supported
CI environment.

## Automated, from CI

Better, once set up: it adds
[provenance](https://docs.npmjs.com/generating-provenance-statements), which
ties each published tarball to the workflow run and commit that produced it.
Consumers can verify that cryptographically; a laptop publish cannot carry it.

The durable way to authenticate CI is **trusted publishing**, where GitHub
Actions proves its identity over OIDC and no token is stored anywhere. Configure
it per package under **Settings → Publishing access** on npmjs.com, pointing at
this repository and `.github/workflows/release.yml`. With that in place the
workflow needs no `NPM_TOKEN` at all.

The repository also needs **Settings → Actions → General → Workflow
permissions → "Allow GitHub Actions to create and approve pull requests"**, which
the changesets action uses to open the release pull request.

Every change that affects a published package then gets a changeset:

```bash
npx changeset
```

Merging to `main` opens a "Release packages" pull request that bumps versions and
writes changelogs. Merging that pull request publishes.

## Checks that run before publishing

`npm run verify:packaging` packs real tarballs, installs them into a throwaway
project, and imports every package through its published entry points in both
ESM and CommonJS. It also asserts no build cache or duplicate declaration tree
came along.

This catches what the test suite cannot: the tests import source files, so they
never exercise the `exports` map, the `files` list, or whether the declaration
file the manifest points at was actually emitted. Those only break for people
who install the package.
