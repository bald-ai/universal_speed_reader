"use client";

const TTS_BASE_URL = "http://127.0.0.1:7332";

export type TtsBookStatus =
  | { state: "missing" }
  | { state: "ready" }
  | { state: "preparing"; progress?: { doneParas: number; totalParas: number } }
  | { state: "error"; error?: string };

function isDebug(): boolean {
  try {
    // Enable by default; disable with localStorage debug:tts=0.
    const v = window.localStorage.getItem("debug:tts");
    return v !== "0";
  } catch {
    return false;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 1200): Promise<T> {
  const controller = new AbortController();
  const t = window.setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {}
      if (isDebug()) {
        // eslint-disable-next-line no-console
        console.log("[TTS][HTTP]", {
          url,
          method: init?.method ?? "GET",
          status: res.status,
          ok: res.ok,
          ms: Math.round(performance.now() - startedAt),
          body: body.slice(0, 400),
        });
      }
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as T;
    if (isDebug()) {
      // eslint-disable-next-line no-console
      console.log("[TTS][HTTP]", {
        url,
        method: init?.method ?? "GET",
        status: res.status,
        ok: res.ok,
        ms: Math.round(performance.now() - startedAt),
      });
    }
    return data;
  } catch (e) {
    if (isDebug()) {
      // eslint-disable-next-line no-console
      console.log("[TTS][HTTP][ERR]", {
        url,
        method: init?.method ?? "GET",
        ms: Math.round(performance.now() - startedAt),
        err: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  } finally {
    window.clearTimeout(t);
  }
}

export async function ttsHealth(timeoutMs = 600): Promise<boolean> {
  try {
    const data = await fetchJson<{ ok: boolean; version?: string; pid?: number }>(
      `${TTS_BASE_URL}/health`,
      undefined,
      timeoutMs
    );
    if (isDebug()) {
      // eslint-disable-next-line no-console
      console.log("[TTS][HTTP] health payload", data);
    }
    return true;
  } catch {
    return false;
  }
}

export async function getTtsBookStatus(bookId: string): Promise<TtsBookStatus> {
  return fetchJson<TtsBookStatus>(`${TTS_BASE_URL}/books/${encodeURIComponent(bookId)}/status`, undefined, 1200);
}

export async function prepareTtsBook(
  bookId: string,
  payload: {
    paragraphs: Array<{ paragraphId: number; tokens: string[] }>;
    pauseMsBetweenParagraphs?: number;
    force?: boolean;
  }
): Promise<{ ok: true; alreadyReady?: boolean; alreadyPreparing?: boolean }> {
  return fetchJson(`${TTS_BASE_URL}/books/${encodeURIComponent(bookId)}/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }, 120000);
}

export function getTtsTimingsUrl(bookId: string): string {
  return `${TTS_BASE_URL}/books/${encodeURIComponent(bookId)}/timings.json`;
}
