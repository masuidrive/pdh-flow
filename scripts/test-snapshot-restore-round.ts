// Focused contract test: confirm that XState v5 `createActor(machine,
// { snapshot })` does NOT re-fire entry actions on the restored state.
//
// The pdh-flow engine's crash-recovery semantics depend on this property:
// the parallel_group's `entry` action self-increments `context.round` based
// on aggregator judgement file count, but this MUST only fire on a fresh
// state transition, not when the engine is re-spawned from a persisted
// snapshot mid-aggregate. If entry fired on restore, the round would bump
// every restart, defeating frozen-judgement re-use and producing infinite
// re-evaluation loops.
//
// Run: npx tsx scripts/test-snapshot-restore-round.ts

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createActor, createMachine, assign } from "xstate";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok    ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
    failed++;
  }
}

// Build a worktree-ish directory with seed aggregator judgement files so the
// nextParallelGroupRound helper has something to count.
const worktree = mkdtempSync(join(tmpdir(), "pdh-snap-test-"));
const judgeDir = join(worktree, ".pdh-flow", "runs", "run-snap-test", "judgements");
mkdirSync(judgeDir, { recursive: true });
// Seed two existing aggregator judgements for group `g1`. Entry action
// should compute round = max(N) + 1 = 3 on fresh entry.
writeFileSync(join(judgeDir, "g1.aggregate__round-1.json"), "{}");
writeFileSync(join(judgeDir, "g1.aggregate__round-2.json"), "{}");

// Inline copy of the helper used by compile-machine.ts. Kept self-contained
// so the test doesn't depend on importing from build output.
function nextParallelGroupRound(groupId: string): number {
  const dir = judgeDir;
  if (!existsSync(dir)) return 1;
  const re = new RegExp(
    `^${groupId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.aggregate__round-(\\d+)\\.json$`,
  );
  let max = 0;
  for (const f of readdirSync(dir)) {
    const m = f.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

interface Ctx {
  round: number;
  enteredHistory: number[]; // every entry-action fire appends current round
}

// Minimal machine mimicking the shape compile-machine.ts produces: a
// top-level entry → parallel_group (entry: assign round) → child final.
const machine = createMachine({
  id: "snap-test",
  initial: "start",
  context: { round: 1, enteredHistory: [] } as Ctx,
  states: {
    start: {
      on: { GO: "group" },
    },
    group: {
      type: "parallel",
      entry: assign({
        round: () => nextParallelGroupRound("g1"),
        enteredHistory: ({ context }) => [
          ...(context as Ctx).enteredHistory,
          nextParallelGroupRound("g1"),
        ],
      }),
      states: {
        r1: {
          initial: "working",
          states: {
            working: { on: { COMPLETE: "done" } },
            done: { type: "final" },
          },
        },
      },
      onDone: "after",
    },
    after: { type: "final" },
  },
});

console.log("=== snapshot-restore-no-refire-entry contract ===\n");

// Phase 1: fresh actor, transition into parallel_group. Entry should fire once.
const a1 = createActor(machine, {
  inspect: (ev) => {
    if (ev.type === "@xstate.event") {
      console.log("  inspect event:", JSON.stringify((ev as any).event));
    }
    if (ev.type === "@xstate.snapshot") {
      console.log("  inspect snap value:", JSON.stringify((ev as any).snapshot?.value));
    }
  },
});
a1.start();
console.log("  debug: pre-GO value =", JSON.stringify(a1.getSnapshot().value));
a1.send({ type: "GO" });
const snap1 = a1.getSnapshot();
console.log("  debug: post-GO value =", JSON.stringify(snap1.value));
console.log("  debug: post-GO ctx =", JSON.stringify(snap1.context));
assert(
  `entry fired once (round=${snap1.context.round})`,
  snap1.context.round === 3,
  `expected round=3 (seed files 1+2 → next=3), got ${snap1.context.round}`,
);
assert(
  `enteredHistory has 1 entry (got [${snap1.context.enteredHistory.join(", ")}])`,
  snap1.context.enteredHistory.length === 1,
);

// Phase 2: persist + restore. Entry MUST NOT fire on restore.
const persisted = a1.getPersistedSnapshot();
const a2 = createActor(machine, { snapshot: persisted as never });
a2.start();
const snap2 = a2.getSnapshot();
assert(
  `restored round preserved (round=${snap2.context.round})`,
  snap2.context.round === 3,
  `entry re-fired on restore — round changed`,
);
assert(
  `restored enteredHistory preserved (len=${snap2.context.enteredHistory.length})`,
  snap2.context.enteredHistory.length === 1,
  `entry re-fired on restore — history grew`,
);

// Phase 3: extra safety — add a NEW aggregator file then restore again.
// If entry re-fires it would bump to round=4. Must stay at 3.
writeFileSync(join(judgeDir, "g1.aggregate__round-3.json"), "{}");
const a3 = createActor(machine, { snapshot: persisted as never });
a3.start();
const snap3 = a3.getSnapshot();
assert(
  `restore is inert even when on-disk state changed (round=${snap3.context.round})`,
  snap3.context.round === 3,
  `entry re-fired on restore — round read file count again`,
);

// Phase 4: cleanup
spawnSync("rm", ["-rf", worktree]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
