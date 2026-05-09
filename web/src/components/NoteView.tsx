export function NoteView({ note }: { note: string }) {
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">note</h2>
        <pre className="pre-wrap text-xs bg-base-200 p-3 rounded max-h-[600px] overflow-auto">{note}</pre>
      </div>
    </div>
  );
}
