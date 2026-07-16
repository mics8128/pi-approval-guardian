# Publishing to npm

This document is for maintainers of `pi-approval-guardian`. Users normally install the package with `pi install npm:pi-approval-guardian` and do not need these steps.

## Current registry status

At the time this guide was written:

- npm package name: `pi-approval-guardian`
- npm owner logged in locally: `mics8128`
- the package name was available (`npm view pi-approval-guardian` returned `E404`)
- `npm pack --dry-run` successfully produced a package preview

Registry state can change. Recheck the name immediately before the first release.

## Requirements

- Node.js 22.19 or newer
- npm account with 2FA enabled
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
- `docs/PUBLISHING.md`
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

Start a clean Pi session and run a harmless `printf` test plus a controlled denied-action test before moving the release tag.

## Versioning

Use semantic versioning:

- **patch**: compatible bug or documentation fix
- **minor**: compatible feature, new guarded action, or new configuration option
- **major**: breaking configuration, behavior, package, or compatibility change

From a clean branch:

```bash
npm version patch   # or minor / major
npm run check
git push --follow-tags
```

For prereleases:

```bash
npm version prerelease --preid=beta
npm publish --tag beta --access public
```

Do not publish prereleases under `latest`.

## Trusted publishing with GitHub Actions

After the first package exists, configure a trusted publisher on npmjs.com for:

- owner: `mics8128`
- repository: `pi-approval-guardian`
- workflow: `publish.yml`
- GitHub environment: `npm`

The repository includes `.github/workflows/publish.yml`. It uses GitHub OIDC and requires:

```yaml
permissions:
  contents: read
  id-token: write
```

No long-lived npm publish token is required. Trusted publishing requires a supported npm CLI and a GitHub-hosted runner. For public packages from public repositories, npm generates provenance automatically.

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
- [ ] Create and push the version tag.
- [ ] Publish interactively or through the trusted-publishing workflow.
- [ ] Verify npm metadata and provenance.
- [ ] Install the exact published version in a clean Pi environment.
- [ ] Run allow, deny, timeout/failure-message, and sensitive-path smoke tests.

## Emergency handling

Do not try to overwrite a bad npm version; npm does not allow it. Publish a corrected patch release and deprecate the affected version if necessary:

```bash
npm deprecate pi-approval-guardian@<bad-version> "Use <fixed-version>; this release is defective."
```

Unpublishing has strict npm policy limitations and can break consumers. Prefer deprecation and a prompt fixed release.
