# Contributing

## Development

Install dependencies with:

```sh
pnpm install
```

Commit blueprint changes and the synchronized `blueprints/catalog.json` to `main`, then select the Development channel on a test Home Assistant instance. Development users receive those changes directly from `main`; Stable users do not receive them until they are included in a published release. New blueprints and deprecation tombstones follow the same process.

Before creating a commit, run the canonical local validation suite and require it to pass:

```sh
pnpm validate
```

`pnpm validate` is the complete local check. It synchronizes the generated blueprint catalog, then runs ESLint, catalog consistency and compatibility against `origin/main`, TypeScript, and unit tests. Next, the official hassfest and HACS containers validate the integration and repository. Finally, one Vitest run starts a network-isolated Home Assistant container and executes both repository validation and blueprint runtime tests. Every stage must pass before a commit. Commit an updated `blueprints/catalog.json` alongside its blueprint changes. The YAML linter reports lines longer than 140 characters as warnings.

Reserve full validation for commits, rather than every reply or handoff. During development, use focused checks when needed. Changes to the validation pipeline itself require exercising that pipeline. After a successful validation, do not repeat checks unless the working tree changed or new evidence calls the result into question.

Docker and network access are required. HACS uses `GH_TOKEN`, `GITHUB_TOKEN`, or the existing `gh auth login` session to read GitHub metadata. The validators read local files, including untracked additions and deletions, so a push is not required to validate a change. See `test/README.md` for the container and authentication details.

GitHub Actions runs lint, catalog checks, TypeScript, unit tests, hassfest, and HACS. The full Home Assistant-backed suite remains local. Before deploying a pushed commit to the user's Home Assistant, verify that the GitHub Validate workflow for that exact commit passed.

The shared validation and runtime container uses Docker networking mode `none`. No Python installation is required on the host; Python regression tests execute inside the Home Assistant container and are orchestrated by Vitest. See `test/README.md` for details.

Catalog maintenance and deprecation rules are documented in `tools/blueprint-catalog`.

## Releases

User-visible changes carry a Changeset. Pushes to `main` maintain a draft release pull request containing the next semantic version and generated changelog. Merging that pull request synchronizes the integration manifest, creates the matching Git tag, and publishes a GitHub Release. The Stable update channel reads blueprint content from that immutable release.
