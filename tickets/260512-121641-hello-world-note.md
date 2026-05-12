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

