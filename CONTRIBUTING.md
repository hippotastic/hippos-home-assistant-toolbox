# Contributing

## Development

Install dependencies with:

```sh
pnpm install
```

Commit blueprint changes and the synchronized `blueprints/catalog.json` to `main`, then select the Development channel on a test Home Assistant instance. Development users receive those changes directly from `main`; Stable users do not receive them until they are included in a published release. New blueprints and deprecation tombstones follow the same process.

Run the canonical local validation suite:

```sh
pnpm validate
```

`pnpm validate` is the complete local check. It first synchronizes the generated blueprint catalog so changed sources and their SHA-256 hashes cannot drift apart. It then orders checks to fail early and quickly: ESLint and catalog consistency run first, followed by TypeScript and unit tests. Finally, one Vitest run starts a network-isolated Home Assistant container and executes both repository validation and blueprint runtime tests. Commit an updated `blueprints/catalog.json` alongside its blueprint changes. Do not run additional checks before or after a successful validation unless the working tree changed. The YAML linter reports lines longer than 140 characters as warnings.

GitHub Actions runs the Docker-free portion of the same validation flow. The full Home Assistant-backed suite remains local.

The shared validation and runtime container uses Docker networking mode `none`. No Python installation is required on the host; Python regression tests execute inside the Home Assistant container and are orchestrated by Vitest. See `test/README.md` for details.

Catalog maintenance and deprecation rules are documented in `tools/blueprint-catalog`.

## Releases

User-visible changes carry a Changeset. Pushes to `main` maintain a draft release pull request containing the next semantic version and generated changelog. Merging that pull request synchronizes the integration manifest, creates the matching Git tag, and publishes a GitHub Release. The Stable update channel reads blueprint content from that immutable release.
