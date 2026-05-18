import type { FlowSchema } from '@poly/types';

/**
 * Mirrors the failure routes encoded in pdh-flow.yaml:
 *   - review_loop's `on_aborted`
 *   - gate_step's `rejected` output
 *   - provider_step / system_step's `on_failure`
 *
 * Returns a map of `stageId → rollbackTargetStageId`. Only stages that have
 * a meaningful rollback are listed. The visualization disables the "fail"
 * button on stages outside this map.
 */
export function buildFailPaths(schema: FlowSchema): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [id, node] of Object.entries(schema.nodes)) {
    if ('macro' in node && node.macro === 'review_loop') {
      // The macro itself fails to on_aborted. We also wire the synthesized
      // aggregator (`<id>.aggregate`) to the same target — it's the
      // station the user actually sees as "failing".
      if (node.on_aborted) {
        out[id] = node.on_aborted;
        out[`${id}.aggregate`] = node.on_aborted;
      }
    } else if ('type' in node && node.type === 'gate_step') {
      if (node.outputs?.rejected) out[id] = node.outputs.rejected;
    } else if ('type' in node && node.type === 'system_step') {
      if (node.on_failure) out[id] = node.on_failure;
    } else if ('type' in node && node.type === 'provider_step') {
      if (node.on_failure) out[id] = node.on_failure;
    }
  }
  return out;
}
