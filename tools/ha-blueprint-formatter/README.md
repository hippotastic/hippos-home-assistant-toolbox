# Home Assistant Blueprint Formatter

Formats explicitly annotated, Jinja-heavy folded YAML scalars so the source
stays readable and Home Assistant's blueprint importer can still serialize them
without escaped `\n` sequences.

## Usage

Format blueprints in-place:

```sh
pnpm format:blueprints
```

Check formatting without writing files:

```sh
pnpm format:blueprints --check
```

Fail the check when formatting warnings remain:

```sh
pnpm format:blueprints --check --fail-on-warnings
```

Keep checking when blueprint files change:

```sh
pnpm format:blueprints --watch
```

By default, the formatter checks all YAML files in `blueprints/automation`.
Pass one or more paths to limit it to specific files:

```sh
pnpm format:blueprints --check blueprints/automation/irrigation_scheduler.yaml
```

## Formatting Rules

The formatter follows the style worked out for these blueprints:

- use folded scalars (`>-`) for multiline Jinja templates
- add at least one Jinja block or comment tag to opt a scalar into formatting
- keep YAML indentation flat inside the scalar
- move visual nesting into the Jinja tag itself, for example `{%-   if ... %}`
- pad Jinja block tags and Jinja comments to 80 characters
- keep free text content, but remove visual YAML indentation that would make
  folded scalars preserve line breaks
- account for Home Assistant's single-quoted YAML dump, where `'` becomes `''`
- write formatted Jinja comments with a visible `//` marker
- wrap long Jinja comments across multiple Jinja comment lines
- warn when a Jinja line is still longer than the target width after Home
  Assistant's YAML quoting behavior is considered

Prefer double quotes for Jinja string literals inside formatted blocks. Home
Assistant usually dumps imported templates as single-quoted YAML scalars, so
single quotes inside the template are doubled and can trigger unexpected wraps.

## Diagnostics

Warnings use a VS Code problem matcher friendly line-only format:

```text
/path/to/blueprint.yaml:302: warning: Jinja template content has HA-dumped length 107, target is 80; single quotes add 4 characters after HA import [ha-blueprint-format/line-length]
```

Known diagnostic codes:

- `ha-blueprint-format/line-length`: a Jinja line still exceeds the configured
  target width after Home Assistant's dump behavior is considered
- `ha-blueprint-format/multiline-code`: a multiline Jinja code tag was left
  unchanged because collapsing it would exceed the target width
- `ha-blueprint-format/multiline-output`: a multiline Jinja output tag was left
  unchanged and may import with escaped newlines
- `ha-blueprint-format/not-formatted`: `--check` found a file whose formatted
  output differs from the source

## VS Code

This repository includes a `.vscode/tasks.json` task that runs the formatter
watcher when the workspace folder opens. VS Code may ask once whether automatic
tasks are allowed for this folder. After the task has started, formatter
warnings show up in the Problems panel and as editor diagnostics. They are
updated when blueprint files are saved.

The task uses a background problem matcher:

```json
{
  "label": "Check blueprint formatting",
  "type": "shell",
  "command": "pnpm format:blueprints --watch",
  "isBackground": true,
  "problemMatcher": {
    "owner": "ha-blueprint-formatter",
    "source": "ha-blueprint-formatter",
    "fileLocation": "absolute",
    "pattern": {
      "regexp": "^(.*):(\\d+):\\s+(warning|error|info):\\s+(.*)\\s+\\[(.*)\\]$",
      "file": 1,
      "line": 2,
      "severity": 3,
      "message": 4,
      "code": 5
    },
    "background": {
      "activeOnStart": true,
      "beginsPattern": "^ha-blueprint-formatter: begin$",
      "endsPattern": "^ha-blueprint-formatter: end$"
    }
  }
}
```

## Scope

The formatter deliberately avoids semantic Jinja refactoring. It does not
rename variables, split expressions into intermediate variables, or decide
which serialized fields may change.

If it reports `ha-blueprint-format/multiline-code`, simplify that template by
hand. Usually the best fix is to introduce local intermediate variables while
keeping serialized keys, namespace members, and helper-facing fields unchanged.
