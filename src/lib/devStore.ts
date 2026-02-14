const BASE = '/api/dev-store';

export async function devStoreGet<T>(key: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function devStoreSet(key: string, value: unknown): Promise<void> {
  try {
    await fetch(`${BASE}/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    // fire-and-forget — swallow errors
  }
}
