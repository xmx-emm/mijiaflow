# Releasing

MijiaFlow publishes to npm as [`mijiaflow`](https://www.npmjs.com/package/mijiaflow)
from the GitHub Actions release workflow.

## One-Time Setup

Choose one of the two authentication paths for
[.github/workflows/release.yml](../.github/workflows/release.yml):

- **npm token:** create a granular access token on npmjs.com with read/write
  access to the `mijiaflow` package, and store it as the `NPM_TOKEN` secret of
  the GitHub repository.
- **Trusted publishing:** on the npm package settings page, add a Trusted
  Publisher pointing at this GitHub repository and the `release.yml` workflow,
  then remove the `NODE_AUTH_TOKEN` env line from the publish step.

The very first `0.x` publish must be done manually once (`npm login`, then
`npm publish` from a clean checkout) unless the token path is used, because
trusted publishing can only be configured for an existing package.

## Release Steps

1. Update the `version` field in [package.json](../package.json).
2. Move the `Unreleased` heading in [CHANGELOG.md](../CHANGELOG.md) to the new
   version with the release date.
3. Run `npm run verify` and commit; the committed `mcp/dist/server.js` must be
   the freshly built bundle (`git diff --exit-code -- mcp/dist` must pass).
4. Tag and push: `git tag v<version> && git push origin main --tags`.
5. The release workflow re-verifies, checks the tag against `package.json`,
   and runs `npm publish --provenance --access public`.

## Manual Fallback

`npm publish` from a clean checkout does the same thing locally:
`prepublishOnly` runs the full verification, and the `files` allowlist keeps
the tarball limited to the bundle, the READMEs, LICENSE, and `docs/`.

## After Publishing

- `npx -y mijiaflow@latest --version` must print the new version.
- Connect from a real MCP client (for example Cursor or Claude Desktop) with
  the standard `npx -y mijiaflow` configuration and confirm the ten tools,
  three prompts, and four guide resources are listed.
