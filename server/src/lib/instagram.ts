import { env } from "../config/env";

// Official "Instagram API with Instagram Login" (Business Login for Instagram) endpoints only.
export const GRAPH_HOST = "https://graph.instagram.com";
export const GRAPH = `${GRAPH_HOST}/${env.IG_API_VERSION}`;

// Removes anything that looks like a secret before it reaches logs, the database or the UI.
export function redact(input: string): string {
  return input
    .replace(/(access_token|client_secret|code)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/("(?:access_token|client_secret)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/\b(?:IG|EAA)[A-Za-z0-9_-]{20,}/g, "[token]");
}

export type IgErrorKind =
  | "auth_expired" // token expired -> account 'expired', user must reconnect
  | "auth_revoked" // token revoked / permission removed -> account 'revoked', user must reconnect
  | "rate_limit" // Meta throttling -> back off, do NOT hammer
  | "transient" // network / 5xx / "please retry" -> bounded retry with backoff
  | "permanent"; // anything else -> fail the job, no retry

export class IgError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly network = false
  ) {
    super(message);
    this.name = "IgError";
  }

  get kind(): IgErrorKind {
    if (this.network) return "transient";
    if (this.code === 190) {
      return this.subcode !== undefined && [458, 459, 460, 464, 467].includes(this.subcode) ? "auth_revoked" : "auth_expired";
    }
    if (this.code === 10 || this.code === 200) return "auth_revoked"; // permission missing / removed
    if (this.status === 429 || (this.code !== undefined && [4, 17, 32, 613, 80002].includes(this.code))) return "rate_limit";
    if (this.status >= 500 || this.code === 1 || this.code === 2) return "transient";
    return "permanent";
  }

  // True when Meta definitively answered with an error (so the request was NOT executed).
  get definitive(): boolean {
    // Codes 1/2 mean "unknown error, please retry": Meta may or may not have executed the request.
    return !this.network && this.status >= 400 && this.status < 500 && this.code !== 1 && this.code !== 2;
  }
}

type Json = Record<string, unknown>;

export async function igFetch<T>(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // Timeout / DNS / connection reset. The request MAY have reached Meta.
    throw new IgError(`Network error talking to Instagram (${(e as Error).name})`, 0, undefined, undefined, true);
  }
  const text = await res.text().catch(() => "");
  let data: Json = {};
  try {
    data = JSON.parse(text) as Json;
  } catch {
    /* non-JSON body */
  }
  const err = data.error as Json | string | undefined;
  if (!res.ok || err) {
    const e = typeof err === "object" && err ? err : undefined;
    const message = redact(String(e?.message ?? data.error_message ?? (typeof err === "string" ? err : `Instagram error ${res.status}`)));
    const rawCode = e?.code ?? data.code;
    const rawSub = e?.error_subcode;
    const code = typeof rawCode === "number" ? rawCode : undefined;
    const sub = typeof rawSub === "number" ? rawSub : undefined;
    throw new IgError(message, res.status, code, sub);
  }
  return data as T;
}

export function igPost<T>(path: string, params: Record<string, string>, timeoutMs = 30_000): Promise<T> {
  return igFetch<T>(
    `${GRAPH}/${path}`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) },
    timeoutMs
  );
}

export function igGet<T>(path: string, params: Record<string, string>, timeoutMs = 30_000): Promise<T> {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return igFetch<T>(url.toString(), {}, timeoutMs);
}

// Official refresh of a long-lived token (valid 60 days from refresh; token must be >= 24h old and not expired).
export function refreshLongLivedToken(token: string): Promise<{ access_token: string; expires_in: number }> {
  const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  return igFetch(url.toString());
}

// Short, safe text for the database / UI.
export function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redact(msg).slice(0, 400);
}
