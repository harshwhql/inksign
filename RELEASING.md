# Releasing

Two routes. The automated one is better and should be the default once set up.

## Automated, from CI

The release workflow versions, tags and publishes with
[provenance](https://docs.npmjs.com/generating-provenance-statements), which
ties each published tarball to the workflow run and commit that produced it.
Consumers can verify that cryptographically; a tarball published from a laptop
cannot carry it.

One-time setup:

1. Create a **granular access token** at
   <https://www.npmjs.com/settings/~/tokens>, scoped to the `@inksign` packages,
   with **"Bypass 2FA"** enabled. A classic automation token also works. Without
   the bypass, CI cannot publish on an account that enforces 2FA.
2. Add it as a repository secret named `NPM_TOKEN`:

   ```bash
   gh secret set NPM_TOKEN --repo harshwhql/inksign
   ```

3. In **Settings → Actions → General → Workflow permissions**, enable
   **"Allow GitHub Actions to create and approve pull requests"**, which the
   changesets action needs to open the release pull request.

After that, every change that affects a published package gets a changeset:

```bash
npx changeset
```

Merging to `main` opens a "Release packages" pull request that bumps versions
and writes changelogs. Merging that pull request publishes.

## Manual, from a laptop

Needed for the first release if the token is not set up yet. Publishes without
provenance, because provenance requires a supported CI environment.

```bash
npm run verify:packaging
```

Then, with a fresh code from your authenticator:

```bash
npm run publish:all -- --otp=123456
```

One command rather than six, because an OTP expires in about thirty seconds and
six separate prompts will outlive a single code. The example workspace is
marked private, so npm skips it.

Afterwards, tag the release:

```bash
git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
```
