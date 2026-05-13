import { loadFlow } from "../../src/engine/load-flow.ts";
import { expandFlow } from "../../src/engine/expand-macro.ts";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
for (const flowId of ["pdh-c-v2", "pdh-d"]) {
  for (const variant of ["full", "light"]) {
    try {
      const flow = loadFlow({ repoPath: repo, flowId });
      const flat = expandFlow(flow, { variant });
      const reviewers = Object.keys(flat.nodes).filter((id) => {
        if (id.endsWith(".aggregate") || id.endsWith(".repair")) return false;
        return id.includes(".") && /\d+$/.test(id);
      });
      console.log(`${flowId}:${variant} — ${Object.keys(flat.nodes).length} nodes, reviewers=[${reviewers.join(", ")}]`);
    } catch (e) {
      console.error(`${flowId}:${variant} FAIL: ${e.message}`);
    }
  }
}
