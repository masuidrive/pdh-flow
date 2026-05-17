import { parse } from 'yaml';
import { Z_STEP, DEFAULT_CHARACTER } from '@poly/config';
import type {
  CharacterKind,
  CharactersMap,
  FlowSchema,
  GateStepNode,
  ProvidersProfile,
  ReviewLoopMacroNode,
  ReviewerSpec,
  Stage,
  StageType,
  StationKind,
  SystemStepNode,
  TerminalNode,
  Worker,
  ProviderStepNode,
} from '@poly/types';

// =============================================================================
// Yaml → Stage[] transformer.
//
// Macro nodes (`macro: review_loop`) expand into TWO synthesized stages:
//   - a parallel station with N reviewers
//   - an aggregate station (the macro's `aggregator.role`)
//
// The repair step is left out of the linear visualization — failures route
// backwards via FAIL_PATHS in failPaths.ts instead.
// =============================================================================

export function parseFlow(yamlText: string): FlowSchema {
  return parse(yamlText) as FlowSchema;
}

export interface LoadFlowOptions {
  variant: string;            // e.g. 'full' | 'light'
  profile: string;            // e.g. 'default' | 'codex'
  fallbackCharacter?: CharacterKind;
}

export function loadFlow(
  yamlText: string,
  opts: LoadFlowOptions,
): { stages: Stage[]; schema: FlowSchema } {
  const schema = parseFlow(yamlText);
  const stages = buildStages(schema, opts);
  return { schema, stages };
}

// =============================================================================
// Internal — stage construction
// =============================================================================

function resolveModel(
  profile: ProvidersProfile,
  nodeId: string,
  role: string | null,
): string {
  // Lookup priority: node-id > role > default. (See pdh-flow.yaml comment.)
  if (profile[nodeId]) return profile[nodeId] as string;
  if (role && profile[role]) return profile[role] as string;
  return profile.default;
}

function resolveCount(spec: ReviewerSpec['count'], variant: string): number {
  if (typeof spec === 'number') return spec;
  return spec[variant] ?? 0;
}

function resolveCharacter(
  map: CharactersMap | undefined,
  role: string,
  fallback: CharacterKind,
): CharacterKind {
  return map?.[role] ?? fallback;
}

function nameplate(role: string, model: string): string {
  return `${role} · ${model}`;
}

function computeRadius(workers: Worker[]): number {
  if (workers.length <= 1) return 1.3;
  let maxAbs = 0;
  for (const w of workers) {
    if (Math.abs(w.x) > maxAbs) maxAbs = Math.abs(w.x);
  }
  return Math.max(1.5, maxAbs + 0.6);
}

/** Distribute N workers evenly across a station, returning their local x offsets. */
function spreadWorkers(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  // Cap at 2.7 to keep parallel reviewers visibly grouped on one pad.
  const maxAbs = Math.min(2.7, 0.9 + (n - 2) * 0.9);
  const step = (2 * maxAbs) / (n - 1);
  return Array.from({ length: n }, (_, i) => -maxAbs + i * step);
}

interface BuildContext {
  schema: FlowSchema;
  profile: ProvidersProfile;
  variant: string;
  charMap: CharactersMap | undefined;
  fallbackChar: CharacterKind;
  zCur: number;
}

function buildStages(
  schema: FlowSchema,
  { variant, profile: profileName, fallbackCharacter = DEFAULT_CHARACTER }: LoadFlowOptions,
): Stage[] {
  const profile = schema.providers[profileName] ?? schema.providers.default;
  if (!profile) {
    throw new Error(`Provider profile "${profileName}" not found in yaml`);
  }
  const variantSpec = schema.variants[variant];
  if (!variantSpec) {
    throw new Error(`Variant "${variant}" not found in yaml`);
  }

  const ctx: BuildContext = {
    schema,
    profile,
    variant,
    charMap: schema.characters,
    fallbackChar: fallbackCharacter,
    zCur: 0,
  };

  const stages: Stage[] = [];
  const visited = new Set<string>();
  let cursor: string | null = variantSpec.initial;

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = schema.nodes[cursor];
    if (!node) {
      throw new Error(`Node "${cursor}" referenced but not defined in yaml`);
    }

    const next = expandNode(cursor, node, ctx, stages);
    cursor = next;
  }

  return stages;
}

/**
 * Convert one yaml node into one (or more, for macros) stages.
 * Returns the id of the next node to walk to, or null on terminal.
 */
function expandNode(
  id: string,
  node: FlowSchema['nodes'][string],
  ctx: BuildContext,
  out: Stage[],
): string | null {
  // --- review_loop macro --------------------------------------------------
  if ('macro' in node && node.macro === 'review_loop') {
    return expandReviewLoop(id, node, ctx, out);
  }

  // --- terminal ----------------------------------------------------------
  if ('type' in node && node.type === 'terminal') {
    const t = node as TerminalNode;
    ctx.zCur += Z_STEP;
    out.push({
      id,
      label: t.reason ?? 'terminal',
      sub: `outcome: ${t.outcome}`,
      role: `terminal · ${t.outcome}`,
      type: 'terminal',
      stationKind: 'terminal',
      workers: [],
      x: 0,
      z: ctx.zCur,
      radius: 1.3,
    });
    return null;
  }

  // --- gate_step ---------------------------------------------------------
  if ('type' in node && node.type === 'gate_step') {
    const g = node as GateStepNode;
    ctx.zCur += Z_STEP;
    const charKind = resolveCharacter(ctx.charMap, g.approver_role, 'door');
    const worker: Worker = {
      char: charKind,
      label: g.approver_role,
      x: 0,
      z: ctx.zCur,
    };
    const workers = [worker];
    out.push({
      id,
      label: g.label ?? '',
      sub: g.summary ?? '',
      role: `gate_step · ${g.approver_role}`,
      type: 'gate',
      stationKind: 'gate',
      workers,
      x: 0,
      z: ctx.zCur,
      radius: computeRadius(workers),
    });
    return g.outputs.approved ?? null;
  }

  // --- system_step -------------------------------------------------------
  if ('type' in node && node.type === 'system_step') {
    const s = node as SystemStepNode;
    ctx.zCur += Z_STEP;
    const fields: string[] = [`system_step · action: ${s.action}`];
    if (s.params?.script) fields.push(`script: ${String(s.params.script)}`);
    if (s.params?.keep_worktree !== undefined) {
      fields.push(`keep_worktree: ${String(s.params.keep_worktree)}`);
    }
    out.push({
      id,
      label: s.label ?? '',
      sub: s.summary ?? fields.join(' · '),
      role: `system_step · ${s.action}`,
      type: 'system',
      stationKind: 'system',
      workers: [],
      x: 0,
      z: ctx.zCur,
      radius: 1.3,
    });
    return s.on_done;
  }

  // --- provider_step -----------------------------------------------------
  if ('type' in node && node.type === 'provider_step') {
    const p = node as ProviderStepNode;
    ctx.zCur += Z_STEP;
    const charKind = resolveCharacter(ctx.charMap, p.role, ctx.fallbackChar);
    const model = resolveModel(ctx.profile, id, p.role);
    const worker: Worker = {
      char: charKind,
      label: p.role,
      x: 0,
      z: ctx.zCur,
    };
    const workers = [worker];
    out.push({
      id,
      label: p.label ?? '',
      sub: p.summary ?? '',
      role: nameplate(p.role, model),
      type: 'work',
      stationKind: 'normal',
      workers,
      x: 0,
      z: ctx.zCur,
      radius: computeRadius(workers),
    });
    return resolveOnDone(p.on_done, ctx.variant);
  }

  return null;
}

function resolveOnDone(
  onDone: string | Record<string, string>,
  variant: string,
): string | null {
  if (typeof onDone === 'string') return onDone;
  return onDone[variant] ?? null;
}

// =============================================================================
// review_loop macro expansion
// =============================================================================

function expandReviewLoop(
  id: string,
  node: ReviewLoopMacroNode,
  ctx: BuildContext,
  out: Stage[],
): string | null {
  // 1. Flatten reviewers into a worker list (respecting CountSpec).
  type RawReviewer = { role: string; char: CharacterKind };
  const raw: RawReviewer[] = [];
  for (const rev of node.reviewers) {
    const n = resolveCount(rev.count, ctx.variant);
    const char = resolveCharacter(ctx.charMap, rev.role, ctx.fallbackChar);
    for (let i = 0; i < n; i++) raw.push({ role: rev.role, char });
  }

  // 2. Parallel station for the reviewers.
  ctx.zCur += Z_STEP;
  const xs = spreadWorkers(raw.length);
  const reviewerZ = ctx.zCur;
  const reviewerWorkers: Worker[] = raw.map((r, i) => ({
    char: r.char,
    label: r.role,
    x: xs[i] ?? 0,
    z: reviewerZ,
  }));
  const reviewerRoleList = node.reviewers
    .map((r) => {
      const n = resolveCount(r.count, ctx.variant);
      return n > 1 ? `${r.role} × ${n}` : r.role;
    })
    .filter((s) => !s.endsWith(' × 0'))
    .join(' / ');
  out.push({
    id,
    label: node.label ?? '',
    sub: node.summary ?? '',
    role: `review_loop · ${reviewerRoleList}`,
    type: 'parallel',
    stationKind: 'review',
    workers: reviewerWorkers,
    x: 0,
    z: reviewerZ,
    radius: computeRadius(reviewerWorkers),
  });

  // 3. Aggregator station (synthesized — no yaml top-level node here).
  ctx.zCur += Z_STEP;
  const aggregatorId = `${id}__aggregator`;
  const aggRole = node.aggregator.role;
  const aggChar = resolveCharacter(ctx.charMap, aggRole, 'aggregator');
  const aggModel = resolveModel(ctx.profile, aggregatorId, aggRole);
  const aggWorkers: Worker[] = [
    { char: aggChar, label: aggRole, x: 0, z: ctx.zCur },
  ];
  out.push({
    id: aggregatorId,
    // Synthesized — no yaml label / summary. Show macro provenance.
    label: 'aggregate',
    sub: `macro: review_loop · aggregator.role: ${aggRole}`,
    role: nameplate(aggRole, aggModel),
    type: 'aggregate',
    stationKind: 'aggregator',
    workers: aggWorkers,
    x: 0,
    z: ctx.zCur,
    radius: computeRadius(aggWorkers),
  });

  return node.on_pass;
}

// Re-export the StageType/StationKind unions so callers can switch on them
// without re-importing from @/types.
export type { Stage, StageType, StationKind, Worker };
