import { FormEvent, memo, useCallback, useEffect, useRef, useState } from "react";

type Acc = { id: string; username: string };
type Reel = { id: string; username: string; scheduled_at: string; status: string; error: string | null };
type Today = { published: number; scheduled: number; publishing: number; failed: number };
type PlanForm = {
  mode: "times" | "interval";
  times: string[];
  start: string;
  end: string;
  intervalMin: number;
  perRun: number;
  gapMin: number;
  staggerMin: number;
};
type Lib = {
  count: number;
  max: number;
  caption: string;
  coverUrl: string | null;
  accounts: number;
  plan: PlanForm & { slots: string[]; perDay: number; cap: number; tz: string; next: { time: string; tomorrow: boolean } | null };
  telegram: { enabled: boolean; linked: boolean; code: string; bot: string | null };
};

const MAX_COVER = 5 * 1024 * 1024;

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

// Only re-render when the data really changed (polling used to re-render everything every few seconds).
function useSame<T>(set: (v: T) => void) {
  const last = useRef("");
  return useCallback(
    (v: T) => {
      const j = JSON.stringify(v);
      if (j === last.current) return;
      last.current = j;
      set(v);
    },
    [set]
  );
}

const Num = memo(function Num({ label, value, min, max, onChange, hint }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; hint?: string }) {
  return (
    <label className="field">
      {label}
      <input type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
});

const PostRow = memo(function PostRow({ r, onDelete }: { r: Reel; onDelete: (id: string) => void }) {
  return (
    <li className="reel">
      <div className="info">
        <b>@{r.username}</b>
        <small>{new Date(r.scheduled_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
        {r.error && <small className="bad">{r.error}</small>}
      </div>
      <span className={`badge ${r.status}`}>{r.status}</span>
      {(r.status === "scheduled" || r.status === "failed") && (
        <button type="button" className="link bad-link" onClick={() => onDelete(r.id)}>Delete</button>
      )}
    </li>
  );
});

export default function Reels({ accounts: _accounts }: { accounts: Acc[] }) {
  const [lib, setLibRaw] = useState<Lib | null>(null);
  const [reels, setReelsRaw] = useState<Reel[] | null>(null);
  const [today, setTodayRaw] = useState<Today | null>(null);
  const setLib = useSame(setLibRaw);
  const setReels = useSame(setReelsRaw);
  const setToday = useSame(setTodayRaw);

  const [plan, setPlan] = useState<PlanForm | null>(null);
  const [planDirty, setPlanDirty] = useState(false);
  const [timeInput, setTimeInput] = useState("");
  const [pStatus, setPStatus] = useState("");
  const [pError, setPError] = useState("");
  const [pBusy, setPBusy] = useState(false);

  const [caption, setCaption] = useState<string | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [cKey, setCKey] = useState(0);
  const [cStatus, setCStatus] = useState("");
  const [cError, setCError] = useState("");
  const [cBusy, setCBusy] = useState(false);

  const [testCount, setTestCount] = useState(1);
  const dirtyRef = useRef(false);
  dirtyRef.current = planDirty;

  const loadLib = useCallback(() => {
    api<Lib>("/api/reels/library")
      .then((d) => {
        setLib(d);
        // Never overwrite what the user is typing in the plan form.
        if (!dirtyRef.current) {
          const { mode, times, start, end, intervalMin, perRun, gapMin, staggerMin } = d.plan;
          setPlan({ mode, times, start, end, intervalMin, perRun, gapMin, staggerMin });
        }
      })
      .catch(() => {});
  }, [setLib]);
  const loadReels = useCallback(() => {
    api<{ reels: Reel[]; today: Today }>("/api/reels")
      .then((d) => {
        setReels(d.reels);
        setToday(d.today);
      })
      .catch(() => setReels([]));
  }, [setReels, setToday]);

  // Light polling: only while the tab is visible, one slow timer for both.
  useEffect(() => {
    loadLib();
    loadReels();
    const tick = () => {
      if (document.hidden) return;
      loadReels();
      loadLib();
    };
    const t = setInterval(tick, 30_000);
    const onVis = () => !document.hidden && tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadLib, loadReels]);

  const edit = useCallback((patch: Partial<PlanForm>) => {
    setPlan((p) => (p ? { ...p, ...patch } : p));
    setPlanDirty(true);
    setPStatus("");
    setPError("");
  }, []);

  function addTime() {
    const v = timeInput.trim();
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) return setPError("Time HH:MM mein likho (jaise 10:30)");
    const t = `${v.padStart(5, "0")}`;
    if (plan && !plan.times.includes(t)) edit({ times: [...plan.times, t].sort() });
    setTimeInput("");
  }

  async function savePlan(e: FormEvent) {
    e.preventDefault();
    if (!plan) return;
    setPBusy(true);
    setPError("");
    setPStatus("");
    try {
      await api("/api/reels/plan", { method: "PUT", body: JSON.stringify(plan) });
      setPlanDirty(false);
      dirtyRef.current = false;
      setPStatus("Saved");
      loadLib();
    } catch (err) {
      setPError((err as Error).message);
    } finally {
      setPBusy(false);
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setCError("");
    setCStatus("");
    if (cover && cover.type !== "image/jpeg") return setCError("Cover JPG hona chahiye");
    if (cover && cover.size > MAX_COVER) return setCError("Cover 5 MB se chhota hona chahiye");
    setCBusy(true);
    try {
      if (cover) {
        const res = await fetch("/api/reels/library/cover", {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          credentials: "same-origin",
          body: cover,
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error((d as { error?: string }).error ?? "Cover upload failed");
        }
      }
      await api("/api/reels/library/settings", {
        method: "PUT",
        body: JSON.stringify({ caption: caption ?? lib?.caption ?? "" }),
      });
      setCover(null);
      setCKey((k) => k + 1);
      setCStatus("Saved");
      loadLib();
    } catch (err) {
      setCError((err as Error).message);
    } finally {
      setCBusy(false);
    }
  }

  async function resetAll() {
    if (!window.confirm("Library, caption, cover aur saari posts delete ho jayengi. Continue?")) return;
    try {
      await api("/api/reels/library/reset", { method: "POST" });
      setCaption(null);
    } catch (err) {
      window.alert((err as Error).message);
    }
    loadLib();
    loadReels();
  }

  async function testPost() {
    if (!window.confirm(`Har account par ${testCount} reel abhi post hogi. Continue?`)) return;
    try {
      const d = await api<{ created: number }>("/api/reels/library/test", {
        method: "POST",
        body: JSON.stringify({ count: testCount }),
      });
      window.alert(d.created === 0 ? "Kuch nahi bana. Library khali hai, aaj ke videos use ho chuke hain, ya koi active account nahi." : `${d.created} post shuru hui`);
    } catch (err) {
      window.alert((err as Error).message);
    }
    loadReels();
  }

  const removePost = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this post?")) return;
      try {
        await api(`/api/reels/${id}`, { method: "DELETE" });
      } catch (err) {
        window.alert((err as Error).message);
      }
      loadReels();
    },
    [loadReels]
  );

  const tgl = lib?.telegram;
  const previewSlots = plan && lib ? lib.plan.slots : [];

  return (
    <>
      {/* 1. Overview */}
      <section className="card">
        <div className="card-head">
          <div className="icon">📊</div>
          <div className="t">
            <h2>Overview</h2>
            <small>{lib ? `${lib.plan.tz} time` : " "}</small>
          </div>
        </div>
        {lib ? (
          <>
            <div className="tiles four">
              <div className="tile"><b>{lib.count}</b><small>Videos</small></div>
              <div className="tile"><b>{lib.accounts}</b><small>Accounts</small></div>
              <div className="tile"><b>{today?.published ?? 0}</b><small>Aaj posted</small></div>
              <div className="tile"><b>{(today?.scheduled ?? 0) + (today?.publishing ?? 0)}</b><small>Baaki</small></div>
            </div>
            <p className="muted">
              {lib.plan.next ? `Agla posting: ${lib.plan.next.tomorrow ? "kal " : ""}${lib.plan.next.time}` : "Koi slot set nahi"}
              {(today?.failed ?? 0) > 0 ? ` · ${today!.failed} failed` : ""}
            </p>
          </>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </section>

      {/* 2. Plan */}
      <section className="card">
        <div className="card-head">
          <div className="icon">🗓️</div>
          <div className="t">
            <h2>Posting Plan</h2>
            <small>Time, interval aur ek baar mein kitni reels</small>
          </div>
        </div>
        {plan && lib ? (
          <form className="form" onSubmit={savePlan}>
            <div className="seg">
              <button type="button" className={plan.mode === "times" ? "on" : ""} onClick={() => edit({ mode: "times" })}>Fixed times</button>
              <button type="button" className={plan.mode === "interval" ? "on" : ""} onClick={() => edit({ mode: "interval" })}>Har X minute</button>
            </div>

            {plan.mode === "times" ? (
              <>
                <div className="chips">
                  {plan.times.map((t) => (
                    <button type="button" className="chip x" key={t} onClick={() => edit({ times: plan.times.filter((x) => x !== t) })}>
                      ⏰ {t} ✕
                    </button>
                  ))}
                  {plan.times.length === 0 && <span className="muted">Koi time nahi</span>}
                </div>
                <div className="row">
                  <input type="time" value={timeInput} onChange={(e) => setTimeInput(e.target.value)} />
                  <button type="button" className="btn" onClick={addTime}>Add</button>
                </div>
              </>
            ) : (
              <div className="grid3">
                <label className="field">Start<input type="time" value={plan.start} onChange={(e) => edit({ start: e.target.value })} /></label>
                <label className="field">End<input type="time" value={plan.end} onChange={(e) => edit({ end: e.target.value })} /></label>
                <Num label="Har (min)" value={plan.intervalMin} min={15} max={720} onChange={(n) => edit({ intervalMin: n })} />
              </div>
            )}

            <div className="grid3">
              <Num label="Ek baar mein (per account)" value={plan.perRun} min={1} max={10} onChange={(n) => edit({ perRun: n })} />
              <Num label="Reels ke beech (min)" value={plan.gapMin} min={0} max={240} onChange={(n) => edit({ gapMin: n })} />
              <Num label="Accounts ke beech (min)" value={plan.staggerMin} min={0} max={120} onChange={(n) => edit({ staggerMin: n })} />
            </div>

            <p className="muted small">
              {previewSlots.length} slot × {plan.perRun} reel = {previewSlots.length * plan.perRun} reels / account / din (limit {lib.plan.cap}).
              Har account ko alag video milti hai, aur ek video ek din mein sirf ek baar.
              {planDirty ? " Save karna baaki hai." : ""}
            </p>
            {pError && <p className="msg bad">{pError}</p>}
            {pStatus && <p className="msg good">{pStatus}</p>}
            <button className="btn full" disabled={pBusy || !planDirty}>{pBusy ? "Please wait..." : "Save plan"}</button>
          </form>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </section>

      {/* 3. Telegram + library count */}
      <section className="card">
        <div className="card-head">
          <div className="icon">✈️</div>
          <div className="t">
            <h2>Videos (Telegram)</h2>
            <small>{lib?.count ?? 0} / {lib?.max ?? 0} library mein</small>
          </div>
        </div>
        {tgl && !tgl.enabled && <p className="msg bad">Koyeb mein TELEGRAM_BOT_TOKEN set nahi hai.</p>}
        {tgl && tgl.enabled && tgl.linked && <p className="msg good">Telegram linked. Videos bot ko bhejte jao (max 20 MB each).</p>}
        {tgl && tgl.enabled && !tgl.linked && (
          <ol className="steps">
            <li><span>Telegram mein <b>@{tgl.bot ?? "apna bot"}</b> kholo</span></li>
            <li><span>Ye message bhejo: <code>/start {tgl.code}</code></span></li>
            <li><span>Phir videos bhejo</span></li>
          </ol>
        )}
      </section>

      {/* 4. Cover and caption */}
      <section className="card">
        <div className="card-head">
          <div className="icon">🖼️</div>
          <div className="t">
            <h2>Cover and Caption</h2>
            <small>{"Caption mein {Option A|Option B|Option C} likho: har reel par ek alag option lagega (repeat caption spam jaisa lagta hai)"}</small>
          </div>
        </div>
        <form className="form" onSubmit={saveSettings} key={`c${cKey}`}>
          {lib?.coverUrl && <img className="thumb cover-preview" src={lib.coverUrl} alt="" loading="lazy" decoding="async" />}
          <label className="field">
            Cover image (sirf JPG, 9:16 best, naya chunoge to purana replace hoga)
            <input type="file" accept="image/jpeg" onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
          </label>
          <textarea
            placeholder="Caption, jaise: {Wait for it|Watch till the end|New reel} #reels"
            rows={4}
            maxLength={2200}
            value={caption ?? lib?.caption ?? ""}
            onChange={(e) => setCaption(e.target.value)}
          />
          {cError && <p className="msg bad">{cError}</p>}
          {cStatus && <p className="msg good">{cStatus}</p>}
          <button className="btn mint full" disabled={cBusy}>{cBusy ? "Please wait..." : "Save caption and cover"}</button>
        </form>
      </section>

      {/* 5. Test */}
      <section className="card">
        <div className="card-head">
          <div className="icon">🧪</div>
          <div className="t">
            <h2>Test</h2>
            <small>Har account par {testCount} reel abhi (alag alag video)</small>
          </div>
        </div>
        <div className="row">
          <input
            type="number"
            min={1}
            max={5}
            value={testCount}
            onChange={(e) => setTestCount(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
          />
          <button type="button" className="btn pink" onClick={testPost}>Test post now</button>
        </div>
      </section>

      {/* 6. Recent posts (short list) */}
      <section className="card">
        <div className="card-head">
          <div className="icon">📮</div>
          <div className="t">
            <h2>Recent posts</h2>
            <small>Last 12 · har 30 second mein refresh</small>
          </div>
        </div>
        {reels === null ? (
          <p className="muted">Loading...</p>
        ) : reels.length === 0 ? (
          <div className="empty"><span className="big">🌱</span>No posts yet.</div>
        ) : (
          <ul className="status">
            {reels.map((r) => (
              <PostRow key={r.id} r={r} onDelete={removePost} />
            ))}
          </ul>
        )}
      </section>

      {/* 7. Danger zone */}
      <section className="card">
        <div className="card-head">
          <div className="icon">⚠️</div>
          <div className="t">
            <h2>Danger zone</h2>
            <small>Ye undo nahi hota</small>
          </div>
        </div>
        <button type="button" className="btn danger full" onClick={resetAll}>
          Delete library and posts
        </button>
      </section>
    </>
  );
}
