# Home Assistant Blueprint Validator

This directory contains a lightweight integration smoke test for the repository's Home Assistant blueprints.

It builds a temporary Home Assistant configuration, installs the repository blueprints into that configuration, wires each blueprint into one fixture automation, and then runs Home Assistant's real configuration checker in Docker.

## What This Is

This is an integration-style validator with fixtures:

- `fixtures/configuration.yaml` is the minimal Home Assistant configuration.
- `fixtures/automations.yaml` contains one `use_blueprint` automation per blueprint.
- `validate.ts` copies the real blueprints into a temporary Home Assistant config directory and runs `hass --script check_config`.

It is not a unit test for runtime behavior. It validates that Home Assistant can load the blueprint-backed automations and that the generated automation configuration passes Home Assistant's schema checks.

## Usage

Run the validator from anywhere inside the repository:

```sh
pnpm validate
```

By default it uses:

```text
ghcr.io/home-assistant/home-assistant:stable
```

The Home Assistant container is started with `--network none`. The validation run cannot communicate with devices on the local network or with the internet.

The validator also uses Docker's `--pull never` policy by default, so running the validator does not implicitly download an image. Pull the image explicitly once when needed:

```sh
docker pull ghcr.io/home-assistant/home-assistant:stable
```

Alternatively, allow Docker to pull the image during validation:

```sh
pnpm validate --pull missing
```

To test against another Home Assistant image:

```sh
pnpm validate --image ghcr.io/home-assistant/home-assistant:beta
```

For a local syntax-only check that does not start Docker:

```sh
pnpm validate --syntax-only
```

To inspect the generated Home Assistant configuration:

```sh
pnpm validate --prepare-only
```

## Updating Fixtures

When a blueprint gains a new required input, add a matching value to the corresponding entry in `fixtures/automations.yaml`.

Prefer keeping fixture values explicit. The goal is to exercise the same `use_blueprint` shape that a real Home Assistant installation uses.
