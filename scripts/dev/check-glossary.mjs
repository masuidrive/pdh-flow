import { renderPrompt } from "../../src/engine/prompts/render.ts";

const targets = [
  "gate-summary",
  "gate-summary-environment",
  "gate-summary-plan",
  "gate-summary-verification",
  "gate-summary-close",
  "assist",
  "planner",
  "implementer",
  "reviewer",
  "final-verifier",
  "epic-verifier",
  "purpose-validator",
  "qa-tester",
];

for (const name of targets) {
  try {
    const out = renderPrompt(name, {
      nodeId: "test",
      round: 1,
      ticket: "",
      note: "",
      brief: "",
      role: "test",
      checkpoints: [],
      intent: "test",
      evidenceDir: "evidence",
      mode: "default",
    });
    const has = out.includes("用語 / Vocabulary") ? "✓" : "✗";
    console.log(`${has} ${name}.j2 (${out.length} chars)`);
  } catch (e) {
    console.log(`✗ ${name}.j2 — render error: ${e.message}`);
  }
}
