import { Link, NavLink, Route, Routes } from "react-router-dom";
import { TopPage } from "./pages/TopPage";
import { TicketPage } from "./pages/TicketPage";
import { EpicPage } from "./pages/EpicPage";
import { EpicListPage } from "./pages/EpicListPage";
import { RunPage } from "./pages/RunPage";
import { AssistPage } from "./pages/AssistPage";
import { useSSEConnectionStatus } from "./lib/sse";

export function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="navbar bg-base-100 shadow">
        <div className="flex-1 px-4 flex items-center gap-3">
          <Link to="/" className="text-xl font-semibold">
            pdh-flow v2
          </Link>
        </div>
        <nav className="flex gap-1 items-center pr-4" role="tablist">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `btn btn-sm btn-ghost ${isActive ? "btn-active" : ""}`}
          >
            Tickets
          </NavLink>
          <NavLink
            to="/epics"
            className={({ isActive }) => `btn btn-sm btn-ghost ${isActive ? "btn-active" : ""}`}
          >
            Epics
          </NavLink>
          <ConnectionDot />
        </nav>
      </header>
      <main className="flex-1 p-4">
        <Routes>
          <Route path="/" element={<TopPage />} />
          <Route path="/epics" element={<EpicListPage />} />
          <Route path="/tickets/:slug" element={<TicketPage />} />
          <Route path="/epics/:slug" element={<EpicPage />} />
          <Route path="/runs/:runId/*" element={<RunPage />} />
          <Route path="/assist/:sessionId" element={<AssistPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="alert alert-warning">
      <span>Route not found</span>
    </div>
  );
}

// Always-on indicator wired to /api/runs-events (the global change
// stream). Green = SSE alive, real-time invalidations flowing. Red +
// "disconnected" = stream dropped; React Query data may be stale until
// the next manual refresh or successful reconnect.
function ConnectionDot() {
  const { connected } = useSSEConnectionStatus("/api/runs-events");
  return (
    <span
      className="ml-2 inline-flex items-center gap-1.5 text-xs"
      title={connected ? "real-time updates active" : "real-time updates dropped — reconnecting…"}
      aria-live="polite"
      aria-label={connected ? "connected" : "disconnected"}
    >
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full ${
          connected ? "bg-success" : "bg-error animate-pulse"
        }`}
      />
      {connected ? null : <span className="text-error font-medium">disconnected</span>}
    </span>
  );
}
