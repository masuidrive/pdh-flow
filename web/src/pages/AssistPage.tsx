import { useParams } from "react-router-dom";

export function AssistPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  return (
    <div className="alert alert-info">
      <span>
        Assist terminal page for session <span className="font-mono">{sessionId}</span> is not yet
        migrated to React. Use the legacy modal on the run page in the meantime.
      </span>
    </div>
  );
}
