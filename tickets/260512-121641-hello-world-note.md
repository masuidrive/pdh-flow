# Work Notes for 260512-121641-hello-world

## Implementation Details

...

## Task 1

...

## Task N

...


## Reviewer note #N

...

## assist (round 1)

## Status

- User-visible change: add a new v2 CLI subcommand, `pdh-flow hello [--name <name>]`. Expected behaviour is: `pdh-flow hello` prints exactly `hello, world\n`; `pdh-flow hello --name <name>` prints `hello, <name>\n`; `--name ""` falls back to `world`; and `hello` appears in the top-level CLI help/usage output.
- Initial scope assumptions: this should stay confined to the CLI layer, likely a new [src/cli/hello.ts](/home/masuidrive/Develop/pdh/pdh-flow/src/cli/hello.ts) plus wiring in [src/cli/index.ts](/home/masuidrive/Develop/pdh/pdh-flow/src/cli/index.ts). I am assuming no engine, flow, web UI, provider, schema, or packaging/publish work is required beyond making the source CLI behave correctly.
- AC hygiene: the acceptance criteria are already clean observable product behaviour. The process requirements are separate under Tasks: `npm run check`, `npm run test:all`, and developer approval belong in the process checklist, not in product AC.
- AC verification classification: AC-1 `pdh-flow hello` exact stdout + exit 0: `unit-test-sufficient`.
- AC verification classification: AC-2 `pdh-flow hello --name Yuichiro` exact stdout + exit 0: `unit-test-sufficient`.
- AC verification classification: AC-3 `pdh-flow hello --name ""` falls back to `hello, world\n`: `unit-test-sufficient`.
- AC verification classification: AC-4 `pdh-flow` and `pdh-flow help` list `hello`: `unit-test-sufficient`.
- `real-env-required` items: none. No external credentials, API keys, network access, real provider auth, or special hardware/environment should be needed for this ticket.
- Next investigation: confirm the smallest existing test hook for CLI behaviour in `test:all`, and verify the exact empty-string handling path around `parseSubcommandArgs` so AC-3 is implemented and tested precisely.


## investigate_plan (round 1)

## investigate_plan (round 1)

Blast radius is small and now fixed: this change stays in the v2 CLI layer plus the deterministic test suite. No engine, flow YAML, schema, web UI, generated types, or package/bin wiring changes are needed if we reuse the existing `test:validate` path.

**Pattern analysis**
- v2 CLI commands are split one-file-per-subcommand under `src/cli/`, with `src/cli/index.ts` kept as a thin dispatcher plus shared help text.
- Leaf commands parse flags with `parseSubcommandArgs()` and write directly to `stdout`/`stderr`; top-level `main()` owns exit-code behavior.
- Deterministic tests live in `scripts/test-*.ts` with local `assert()/section()` helpers and run through shell wrappers under `npm run test:all`.
- Important constraint: `src/cli/index.ts` ends with top-level `await main()`. That makes direct import of CLI modules a trap in tests, because importing a handler that depends on `index.ts` can execute the CLI at module load. For this ticket, the safe codebase-native pattern is spawn-based CLI assertions.

**Concrete implementation path**
- Add `src/cli/hello.ts` as a new leaf handler.
- Wire `hello` into `src/cli/index.ts` dispatch and help text.
- Add one new CLI section to `scripts/test-validate.ts` that spawns `node src/cli/index.ts ...` for AC-1..AC-4.
- Keep scope tight: no new test runner, no `package.json` edits, no refactor of `parseSubcommandArgs()` out of `index.ts`.

**Files / ownership**
- `implementer` owns [src/cli/hello.ts](/home/masuidrive/Develop/pdh/pdh-flow/src/cli/hello.ts)
  New handler exporting `cmdHello(argv)`. Parse optional `--name`, emit exactly `hello, <target>\n`, and fall back to `"world"` when `--name` is absent or the parsed value is `""`.
  Gotcha: keep it side-effect free other than `stdout`; do not add custom exit handling or broader validation.

- `implementer` owns [src/cli/index.ts](/home/masuidrive/Develop/pdh/pdh-flow/src/cli/index.ts)
  Add the import, `SUBCOMMANDS.hello`, and one manual help stanza so both `pdh-flow` and `pdh-flow help` surface it through the existing `cmdHelp()` path.
  Gotcha: help formatting is hand-aligned text, not generated. Make the diff surgical and avoid reordering unrelated commands.

- `implementer` owns [scripts/test-validate.ts](/home/masuidrive/Develop/pdh/pdh-flow/scripts/test-validate.ts)
  Add a `CLI: hello` section using `spawnSync("node", ["src/cli/index.ts", ...], { cwd: REPO, encoding: "utf8" })`.
  Gotcha: do not import CLI modules here; spawn the entrypoint instead so top-level `await main()` does not interfere with test bootstrap.

**Test strategy**
- AC-1: spawn `node src/cli/index.ts hello`; assert exit `0` and stdout exactly `hello, world\n`.
- AC-2: spawn `node src/cli/index.ts hello --name Yuichiro`; assert exit `0` and stdout exactly `hello, Yuichiro\n`.
- AC-3: spawn `node src/cli/index.ts hello --name ""`; assert exit `0` and stdout exactly `hello, world\n`.
- AC-4: spawn `node src/cli/index.ts` and `node src/cli/index.ts help`; assert exit `0` and that both outputs include a `hello` subcommand line.
- Error-case posture: no new `hello`-specific error-path tests are needed. This subcommand has no required args; shared invalid-option behavior already belongs to the existing `parseArgs` + top-level CLI error path, and widening scope there is unnecessary for this ticket.

**AC verification plan**
- AC-1: `unit-test-sufficient`
- AC-2: `unit-test-sufficient`
- AC-3: `unit-test-sufficient`
- AC-4: `unit-test-sufficient`
- Verification commands:
  - `source /home/masuidrive/.nvm/nvm.sh && npm run check`
  - `source /home/masuidrive/.nvm/nvm.sh && npm run test:all`
- `real-env-required` ACs: none.
- Extra env vars / credentials needed: none. No provider auth, API keys, network access, or external services are involved.

**Risks + mitigations**
- Risk: import-based CLI tests accidentally run `main()` during module load.
  Mitigation: verify behavior only through spawned CLI processes.
- Risk: help-output tests become brittle if full usage text changes later.
  Mitigation: assert presence of the `hello` line, not the entire help snapshot.
- Risk: over-normalizing `--name` changes semantics beyond the ticket.
  Mitigation: implement only the specified boundary: absent or empty string falls back to `"world"`; otherwise preserve the provided value.
- Risk: adding a new test harness or script inflates blast radius.
  Mitigation: extend `scripts/test-validate.ts`, which is already in `test:all`.

