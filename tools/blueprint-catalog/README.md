# Blueprint Catalog

The catalog is the published contract between this repository and the Home
Assistant integration. It records stable blueprint IDs, repository paths,
domains, lifecycle states, and canonical SHA-256 hashes.

## Synchronize

Run this after adding or editing a blueprint:

```sh
pnpm catalog:sync
```

The canonical `pnpm validate` command runs this synchronization automatically
before checking the repository. The standalone command remains useful while
editing or when only the generated catalog should be refreshed.

The command scans `blueprints/automation`, `blueprints/script`, and
`blueprints/template`, then updates `blueprints/catalog.json`. New files receive
a stable ID derived from their path. Existing IDs are never changed
automatically.

An active catalog entry whose source file disappeared is treated as an error.
This prevents accidental remote deletion.

## Check

Run the read-only CI check with:

```sh
pnpm catalog:check
```

It fails if catalog metadata or hashes are stale, paths and IDs are invalid, or
the serialized catalog is not deterministic.

CI can additionally compare the catalog contract with an older Git revision:

```sh
pnpm catalog:check --base origin/main
```

This prevents stable IDs and paths from changing and prevents deprecated
tombstones from being deleted or reactivated.

## Deprecate

To retire a blueprint without deleting it from users' Home Assistant instances:

1. Change its catalog `status` from `active` to `deprecated`.
2. Optionally add `deprecated_message` and `replacement`.
3. Remove the blueprint source file.
4. Run `pnpm catalog:sync` and `pnpm catalog:check`.

The tombstone stays in the catalog permanently. Installed files remain local,
and affected users receive an issue they can ignore.

## Hash Contract

Before hashing, both the TypeScript tooling and Home Assistant integration:

1. Decode the file as UTF-8.
2. Normalize CRLF and CR line endings to LF.
3. Remove ASCII whitespace from the beginning and end of the complete file.
4. Calculate SHA-256 over the resulting UTF-8 bytes.

Whitespace inside the YAML document remains significant.

## Update Channels

The integration reads the catalog from the latest published release for the
Stable channel and directly from `main` for the opt-in Development channel. Run
`pnpm catalog:sync` after changing blueprints and commit the updated catalog
alongside them.

Test the Development channel in Home Assistant before publishing a release.
Stable IDs and deprecation tombstones remain part of the same catalog history.
