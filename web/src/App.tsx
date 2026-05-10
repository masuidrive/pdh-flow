import { Link, Route, Routes } from "react-router-dom";
import { TopPage } from "./pages/TopPage";
import { TicketPage } from "./pages/TicketPage";
import { EpicPage } from "./pages/EpicPage";
import { RunPage } from "./pages/RunPage";
import { AssistPage } from "./pages/AssistPage";

export function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="navbar bg-base-100 shadow">
        <div className="flex-1 px-4">
          <Link to="/" className="text-xl font-semibold">
            pdh-flow v2
          </Link>
        </div>
      </header>
      <main className="flex-1 p-4">
        <Routes>
          <Route path="/" element={<TopPage />} />
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
