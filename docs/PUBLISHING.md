# Publishing to npm

This document is for maintainers of `pi-approval-guardian`. Users normally install the package with `pi install npm:pi-approval-guardian` and do not need these steps.

## Requirements

- Node.js 22.19 or newer
- npm account with 2FA enabled
- npm 11.15.0 or newer for `npm trust`
- permission to publish `pi-approval-guardian`
- clean Git worktree on the release commit
- all translated READMEs updated together

Official references:

- [Creating and publishing packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish)
- [`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack)
- [`npm version`](https://docs.npmjs.com/cli/v11/commands/npm-version)
- [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Provenance statements](https://docs.npmjs.com/generating-provenance-statements)

## Package contents

`package.json#files` is the publication allowlist. A release includes:

- `extensions/`
- `src/`
- `README.md` and localized `README.*.md` files
- `docs/PUBLISHING.md` and `docs/REFERENCE.md`
- MIT `LICENSE`
- `LICENSES/Apache-2.0.txt` and `NOTICE` for adapted OpenAI Codex Guardian materials
- npm-required package metadata

Tests, local configuration, `.pi-subagents`, Git metadata, and development-only files must not appear in the tarball.

## First publication

The first release normally needs an interactive publish because npm trusted publishing cannot be configured for a package that does not exist yet.

```bash
npm login
npm whoami
npm view pi-approval-guardian name version

npm ci
npm run check
npm run package:check
npm run publish:check
```

Review the complete file list printed by `npm pack --dry-run`. Check that no credentials, local configuration, session logs, or unrelated files are included.

When ready:

```bash
npm publish --access public
```

Complete the npm 2FA prompt when requested. A local interactive publish does not produce npm provenance; configure trusted publishing immediately after the first release so later GitHub-hosted releases receive provenance automatically. Published npm versions are immutable, so do not publish until the tarball, version, Git commit, and README are final.

After publication:

```bash
npm view pi-approval-guardian name version dist-tags repository --json
pi install npm:pi-approval-guardian@<version>
```

Start a clean Pi session and run a harmless `printf` test plus a controlled denied-action test. For the bootstrap release, create and push the version tag only after these checks. The publish workflow detects an already-published immutable version and skips republishing it; later versions are published by OIDC when their tag is pushed.

## Versioning

Use semantic versioning:

- **patch**: compatible bug or documentation fix
- **minor**: compatible feature, new guarded action, or new configuration option
- **major**: breaking configuration, behavior, package, or compatibility change

Prepare the version on a release branch:

```bash
npm version patch --no-git-tag-version   # or minor / major
npm run check
npm run package:check
```

Commit the version change, open a pull request, wait for required CI, and merge it into `main`. Create and push the matching `v<version>` tag from the merged release commit. The tag triggers the trusted-publishing workflow.

For prereleases:

```bash
npm version prerelease --preid=beta
npm publish --tag beta --access public
```

Do not publish prereleases under `latest`.

## Trusted publishing with GitHub Actions

After the first package exists, use npm 11.15.0 or newer to configure the publisher:

```bash
npm install --global npm@^11.15.0
npm trust github pi-approval-guardian \
  --file publish.yml \
  --repository mics8128/pi-approval-guardian \
  --environment npm \
  --allow-publish \
  --yes
```

The equivalent npmjs.com fields are:

- owner/user: `mics8128`
- repository: `pi-approval-guardian`
- workflow filename: `publish.yml`
- GitHub environment: `npm`
- permission: publish

The repository includes `.github/workflows/publish.yml`. It uses GitHub OIDC and requires:

```yaml
permissions:
  contents: read
  id-token: write
```

No long-lived npm publish token is required. Trusted publishing requires a supported npm CLI and a GitHub-hosted runner. For public packages from public repositories, npm generates provenance automatically.

An HTTP 400 from `npm trust` after successful 2FA commonly means the local npm CLI is older than 11.15.0 or the required `--allow-publish` permission was omitted. Check `npm --version`, upgrade, and retry with the command above.

Once trusted publishing is proven, configure npm package publishing access to require 2FA and disallow traditional automation tokens, then revoke unused write tokens.

## Release checklist

- [ ] Review all source and dependency changes.
- [ ] Update `CHANGELOG.md` when one is added.
- [ ] Update every localized README.
- [ ] Confirm `NOTICE`, the Apache-2.0 license copy, and the attribution header in `src/policy.ts` remain present.
- [ ] Confirm `package.json` and `package-lock.json` versions match.
- [ ] Run `npm ci`.
- [ ] Run `npm run check`.
- [ ] Run `npm run package:check` and inspect every packed file.
- [ ] Run `npm run publish:check`.
- [ ] Confirm the Git worktree is clean.
- [ ] For the first release: publish interactively, verify/install/smoke-test, then create and push the tag.
- [ ] For later releases: create and push the version tag so the trusted-publishing workflow publishes it.
- [ ] Verify npm metadata and provenance when available.
- [ ] Install the exact published version in a clean Pi environment.
- [ ] Run allow, deny, timeout/failure-message, and sensitive-path smoke tests.

## pi.dev package gallery

`pi.dev/packages` automatically indexes public npm packages whose keywords include `pi-package`; no separate submission is required. Before publishing, confirm:

- `package.json#keywords` contains `pi-package`;
- `package.json#pi.extensions` points to `./extensions/index.ts`;
- `pi -e .` loads the local package successfully;
- the packed file list contains no credentials or local configuration.

After npm publication and registry verification, allow time for the npm search index and gallery catalog to refresh. The package detail route may work before catalog search does. Check both:

```bash
npm search pi-approval-guardian
```

- `https://pi.dev/packages/pi-approval-guardian`
- `https://pi.dev/packages?name=pi-approval-guardian`

If the direct detail route works but `npm search` and the catalog list do not, no package-author action is normally required; wait for npm search indexing and the next Pi catalog refresh.

## Emergency handling

Do not try to overwrite a bad npm version; npm does not allow it. Publish a corrected patch release and deprecate the affected version if necessary:

```bash
npm deprecate pi-approval-guardian@<bad-version> "Use <fixed-version>; this release is defective."
```

Unpublishing has strict npm policy limitations and can break consumers. Prefer deprecation and a prompt fixed release.
