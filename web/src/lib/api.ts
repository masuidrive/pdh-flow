export async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${r.statusText} on ${path}: ${body.slice(0, 300)}`);
  }
  return r.json() as Promise<T>;
}

export async function fetchText(path: string): Promise<string> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}`);
  return r.text();
}

export async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const eb = (await r.json().catch(() => ({}))) as { error?: string } & T;
  if (!r.ok) throw new Error(eb.error ?? `HTTP ${r.status}`);
  return eb;
}

export async function postEmpty<T = unknown>(path: string): Promise<T> {
  const r = await fetch(path, { method: "POST" });
  const eb = (await r.json().catch(() => ({}))) as { error?: string } & T;
  if (!r.ok) throw new Error(eb.error ?? `HTTP ${r.status}`);
  return eb;
}
