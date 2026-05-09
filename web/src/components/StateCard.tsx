import type { RunSummary } from "../types/api";
import { StateBadge } from "./Badges";

export function StateCard({ s }: { s: RunSummary }) {
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">State</h2>
        <dl className="grid grid-cols-3 gap-y-1 text-sm">
          <dt className="opacity-60">Ticket</dt>
          <dd className="col-span-2 font-mono text-xs">{s.ticket_id ?? "-"}</dd>
          <dt className="opacity-60">Flow</dt>
          <dd className="col-span-2 font-mono text-xs">
            {s.flow ?? "-"} / {s.variant ?? "-"}
          </dd>
          <dt className="opacity-60">Current</dt>
          <dd className="col-span-2">
            <StateBadge state={s.current_state} />
          </dd>
          <dt className="opacity-60">Round</dt>
          <dd className="col-span-2">{s.round}</dd>
          <dt className="opacity-60">Last decision</dt>
          <dd className="col-span-2 font-mono text-xs">{s.last_guardian_decision ?? "-"}</dd>
          <dt className="opacity-60">Saved at</dt>
          <dd className="col-span-2 text-xs opacity-70">{s.saved_at ?? "-"}</dd>
        </dl>
      </div>
    </div>
  );
}
