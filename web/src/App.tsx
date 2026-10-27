import { FormEvent, useCallback, useEffect, useState } from "react";
import Reels from "./Reels";

type User = { id: string; email: string };
type Account = {
  id: string;
  username: string;
  account_type: string | null;
  status: "active" | "expired" | "revoked" | string;
  token_expires_at: string | null;
  connected_at: string;
  last_used_at: string | null;
  last_error: string | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Something went wrong");
  return data as T;
}

const NOTICES: Record<string, { text: string; ok: boolean }> = {
  connected: { text: "Instagram connected. Ab scheduled Reels isi connection se post honge, dobara connect nahi karna.", ok: true },
  denied: { text: "Instagram authorization was cancelled or permission was denied.", ok: false },
  taken: { text: "That Instagram account is already linked to another user.", ok: false },
  invalid_state: { text: "This connection attempt expired or was already used. Press Connect Instagram once more.", ok: false },
  invalid_code: { text: "Instagram rejected the login code (expired or already used). Press Connect Instagram once more.", ok: false },
  missing_permission: { text: "Instagram permission for publishing was not granted. Please connect again and allow all requested permissions.", ok: false },
  not_professional: { text: "This Instagram account is not a Professional (Business or Creator) account. Switch it to Professional in Instagram settings first.", ok: false },
  dev_mode: { text: "Instagram account is not available to this app in the current Development Mode. Add it as an Instagram Tester in Meta and accept the invite in Instagram (Apps and websites > Tester invites).", ok: false },
  meta_rejected: { text: "Meta rejected this authorization. If the app is in Development Mode, make sure this account is an accepted Instagram Tester.", ok: false },
  network: { text: "Could not reach Instagram right now. Please try again in a minute.", ok: false },
  wait: { text: "A connection attempt just started. Please wait a few seconds before trying again.", ok: false },
  error: { text: "Could not connect Instagram. Please try again.", ok: false },
};

function AuthForm({ onDone }: { onDone: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { user } = await api<{ user: User }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onDone(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap auth">
      <div className="hero">
        <div className="icon">🎬</div>
        <h1>Reel Scheduler</h1>
        <p className="muted">{mode === "login" ? "Welcome back! Log in to continue" : "Create your account in a few seconds"}</p>
      </div>
      <form className="card form" onSubmit={submit}>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <input
          type="password"
          placeholder="Password (min 10 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
        {error && <p className="msg bad">{error}</p>}
        <button className="btn full" disabled={busy}>{busy ? "Please wait..." : mode === "login" ? "Log in" : "Sign up"}</button>
      </form>
      <div style={{ textAlign: "center" }}>
        <button className="link" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>
          {mode === "login" ? "New here? Create an account" : "Already have an account? Log in"}
        </button>
      </div>
    </main>
  );
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(() => {
    api<{ accounts: Account[] }>("/api/instagram/accounts")
      .then((d) => setAccounts(d.accounts))
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    load();
    const key = new URLSearchParams(window.location.search).get("instagram");
    if (key) setNotice(NOTICES[key] ?? NOTICES.error);
    if (key) window.history.replaceState({}, "", "/");
    // If the browser restores this page from the back button, make the connect button usable again.
    const reset = () => setConnecting(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, [load]);

  async function disconnect(id: string) {
    if (!window.confirm("Disconnect this Instagram account? Its waiting posts will be removed too.")) return;
    await api(`/api/instagram/accounts/${id}`, { method: "DELETE" }).catch(() => {});
    load();
  }

  // One explicit click = one OAuth attempt. The page itself never redirects to Instagram on its own.
  function startConnect() {
    if (connecting) return;
    setConnecting(true);
    window.location.href = "/api/instagram/connect";
  }

  const hasAccounts = Boolean(accounts && accounts.length > 0);
  const needsReconnect = Boolean(accounts && accounts.some((a) => a.status !== "active"));

  return (
    <main className="wrap">
      <header className="card top">
        <div className="row">
          <div className="brand">
            <div className="icon">🎬</div>
            <div className="name">
              <h1>Reel Scheduler</h1>
              <small className="muted">{user.email}</small>
            </div>
          </div>
          <button className="link" onClick={onLogout}>Log out</button>
        </div>
      </header>

      {notice && <p className={`msg ${notice.ok ? "good" : "bad"}`}>{notice.text}</p>}

      <section className="card">
        <div className="card-head">
          <div className="icon">📸</div>
          <div className="t">
            <h2>Instagram</h2>
            <small>Ek baar connect karo, connection save rehta hai</small>
          </div>
        </div>

        {accounts === null ? (
          <p className="muted">Loading...</p>
        ) : accounts.length === 0 ? (
          <div className="empty">
            <span className="big">🔌</span>
            Abhi koi account connected nahi hai.
          </div>
        ) : (
          <ul className="status">
            {accounts.map((a) => {
              const ok = a.status === "active";
              return (
                <li key={a.id}>
                  <div className="left">
                    <div className="avatar">{a.username.slice(0, 1).toUpperCase()}</div>
                    <div className="name">
                      <b>@{a.username}</b>
                      {ok ? (
                        <small className="ok">● Connected{a.account_type ? ` · ${a.account_type.toLowerCase()}` : ""}</small>
                      ) : (
                        <small className="bad">⚠ Connection {a.status === "revoked" ? "was removed" : "expired"}</small>
                      )}
                    </div>
                  </div>
                  <div className="actions">
                    {!ok && (
                      <button className="btn pink" disabled={connecting} onClick={startConnect}>Reconnect Instagram</button>
                    )}
                    <button className="link bad-link" onClick={() => disconnect(a.id)}>Disconnect</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {needsReconnect && (
          <p className="msg bad">Posting paused for accounts that need reconnecting. Reconnect karte hi waiting posts apne aap chalu ho jayengi.</p>
        )}

        {accounts !== null && (
          <button className="btn full" disabled={connecting} onClick={startConnect}>
            {connecting ? "Opening Instagram..." : hasAccounts ? "＋ Connect another account" : "Connect Instagram"}
          </button>
        )}
      </section>

      {hasAccounts && <Reels accounts={accounts!} />}
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then((d) => setUser(d.user))
      .catch(() => setUser(null));
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }

  if (user === undefined) return <main className="wrap"><p className="muted" style={{ textAlign: "center", marginTop: "30vh" }}>Loading...</p></main>;
  return user ? <Dashboard user={user} onLogout={logout} /> : <AuthForm onDone={setUser} />;
}
