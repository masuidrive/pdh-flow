// Provider-profile resolver.
//
// Replaces the old per-node `provider:` / `model:` fields on the flow YAML
// with a top-level `providers:` map. At engine start the caller picks a
// profile by name (--providers <profile>, default `default`). The engine
// then asks `resolveProvider(profile, nodeId, role)` for every invocation
// and dispatches to the right CLI based on the returned value.
//
// Lookup priority is fixed:
//   1. exact node-id  ← most specific
//   2. role
//   3. `default`      ← guaranteed to exist (schema-required)
//
// Designed so that:
//   - reviewer roles inside review_loop macros (devils_advocate / critical / …)
//     can be set once at profile level instead of per-reviewer-spec
//   - one specific node can still override its role's provider
//   - swapping the entire matrix (opus → codex) is a single `default:` swap

import type { Provider, ProviderProfile } from "../../types/index.ts";

export function resolveProvider(
  profile: ProviderProfile,
  nodeId: string,
  role?: string | null,
): Provider {
  // Cast: the generated type expresses the schema's pattern-property + required
  // `default` constraint, but it doesn't give us index-access on string keys.
  // We checked at validation time that the object only contains `Provider`
  // values, so the runtime lookup is safe.
  const p = profile as unknown as Record<string, Provider | undefined>;
  if (Object.prototype.hasOwnProperty.call(p, nodeId)) {
    const v = p[nodeId];
    if (v) return v;
  }
  if (role && Object.prototype.hasOwnProperty.call(p, role)) {
    const v = p[role];
    if (v) return v;
  }
  return p.default!;
}

/** Resolve a named profile out of a flow's top-level `providers` map.
 *  Throws when the named profile is absent. Used by the CLI / serve layer
 *  to translate the `--providers <name>` flag into the concrete profile
 *  object handed to the engine. */
export function pickProfile(
  providers: Record<string, ProviderProfile>,
  name: string,
): ProviderProfile {
  if (!Object.prototype.hasOwnProperty.call(providers, name)) {
    const available = Object.keys(providers).join(", ");
    throw new Error(
      `provider profile "${name}" not found in flow; available: ${available}`,
    );
  }
  return providers[name];
}
