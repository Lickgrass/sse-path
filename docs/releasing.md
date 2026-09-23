# Releasing to npm

The manual [release workflow](../.github/workflows/release.yml) is disabled unless the repository variable `ENABLE_NPM_PUBLISH` is exactly `true`. Adding this file does not enable publishing, create tags, or configure npm or GitHub. Normal CI and tag pushes never publish.

## Maintainer setup

1. Keep the gate unset while reviewing this workflow. Create a GitHub environment named `npm`; configure required reviewers and restrict deployment tags. An environment name alone does not require approval. Protect `main`, release tags, and workflow changes through repository settings.
2. Configure the npm package's GitHub trusted publisher for organization `Lickgrass`, repository `sse-path`, workflow filename `release.yml`, and environment `npm`. Enable direct `npm publish`: newly configured publishers can default to staging-only permission. Use GitHub-hosted runners, npm 11.5.1 or newer, and Node 22.14 or newer. Do not add an npm token to GitHub secrets. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
3. If the unpublished package has no settings page on which to configure its publisher, leave this workflow disabled. A Lickgrass package owner must bootstrap the first package through a separately reviewed, explicitly authorized interactive publication, then configure trusted publishing for subsequent versions. A local initial publish does not gain CI provenance from this workflow. Do not publish a placeholder solely to bypass setup.
4. Confirm the repository and package are public and `repository.url` matches `Lickgrass/sse-path`. Review npm's [provenance prerequisites](https://docs.npmjs.com/generating-provenance-statements/). Only then set `ENABLE_NPM_PUBLISH=true` for an authorized release.

## Release procedure

1. Update `package.json`, the lockfile, `src/version.ts`, and the changelog together. Merge the reviewed change into `main`, with CI passing. Create an immutable stable `vX.Y.Z` tag at that reviewed commit.
2. Manually dispatch `release.yml` **from that tag**, with the same tag as its `release_tag` input. A branch dispatch, mismatched tag, or commit outside `main` is rejected. For example, replace the version below with the reviewed release:

   ```sh
   gh workflow run release.yml --repo Lickgrass/sse-path --ref vX.Y.Z -f release_tag=vX.Y.Z
   ```

3. The validation job installs with lifecycle scripts disabled, runs the complete check suite and dependency audit, then packs and installs an archive in an isolated offline consumer. Version tests and package smoke checks require the source constant, CLI, manifest, and archive version to agree. That exact tested archive is retained with a SHA-256 digest.
4. Review the validation result and any configured `npm` environment approval. The separate publishing job downloads the immutable artifact ID from this run, verifies its filename and SHA-256, and publishes those bytes with `--access public --provenance --ignore-scripts`. It does not check out source, install package dependencies, or rebuild. Only this job receives `id-token: write`.
5. After success, verify the registry version, package contents, and provenance on npm. Do not claim a release succeeded merely because the workflow was dispatched. Restore the gate to an unset or false value when publication should be disabled.

Already-published versions cannot be overwritten. Correct a failed candidate before publishing a new reviewed version; do not move a published release tag.

## Retain a tested archive locally

This command builds and tests a package without publishing. The destination must not already exist:

```sh
npm run check:package -- --out-dir /absolute/path/to/new-release-directory
```

It writes the tested `.tgz` and `metadata.json`, including the SHA-256. An existing destination is refused. This local package check verifies the consumer installation and exports; run `npm run check` and `npm audit --package-lock-only --audit-level=low` as well before considering a release. Local checks do not exercise GitHub OIDC, environment protections, or npm publication.
