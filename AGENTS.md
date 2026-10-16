# Repository rules

## Validation and commits

- Before creating any commit, run `pnpm validate` against the final working tree and require every stage to pass. This includes catalog synchronization and compatibility, lint, types, unit tests, hassfest, HACS, and the Home Assistant suite. Individual checks are not a substitute.
- Reserve full validation for commits. Do not run it before every reply or handoff. During ongoing work, run only focused checks needed to verify the changes; editing the validation pipeline itself requires exercising that pipeline.
- After a successful validation, do not repeat checks unless the working tree changed or new evidence calls the result into question. Include generated catalog changes in the commit.
- When asked to commit, also push to the currently checked-out branch unless explicitly told otherwise. Do not switch branches for this.
- Before deploying a pushed commit to the user's Home Assistant, verify that the GitHub Validate workflow for that exact commit passed.
- Run authenticated `gh` commands outside the sandbox so they use the host's valid GitHub login. Local HACS validation also needs Docker and network access.
