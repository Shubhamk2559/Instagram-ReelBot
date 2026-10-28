import { z } from "zod";
import { pool } from "../db/pool";

// ---- Global settings (Koyeb env vars) ----
export const TZ = process.env.POST_TZ || "Asia/Kolkata";
// Meta allows 100 API posts per account per 24h, but staying far below looks natural and protects the app.
// Default is 5/day per account (hard max 25). Raise IG_DAILY_POST_CAP only if you really need to.
export const DAILY_CAP = Math.max(1, Math.min(25, Math.floor(Number(process.env.IG_DAILY_POST_CAP) || 5)));
// How many videos the library may hold (Telegram uploads stop after this).
export const LIBRARY_MAX = Math.max(1, Math.min(2000, Math.floor(Number(process.env.LIBRARY_MAX) || 500)));
export const MAX_SLOTS = 48;

export type Plan = {
  mode: "times" | "interval";
  times: string[]; // fixed posting times (mode "times")
  start: string; // window start (mode "interval")
  end: string; // window end (mode "interval")
  intervalMin: number; // minutes between runs (mode "interval")
  perRun: number; // reels per account per run
  gapMin: number; // minutes between reels of the same account inside one run
  staggerMin: number; // minutes between accounts inside one run
};

const hhmm = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export const toMinutes = (v: string): number => {
  const m = hhmm.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
export const label = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const normTime = (v: string) => label(toMinutes(v));

// Defaults used until the user saves a plan in the dashboard (old env vars still work as defaults).
function defaultPlan(): Plan {
  const times = (process.env.POST_SLOTS || "10:00,19:00")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => hhmm.test(s))
    .map(normTime);
  return {
    mode: "times",
    times: times.length ? times : ["10:00", "19:00"],
    start: "09:00",
    end: "21:00",
    intervalMin: 120,
    perRun: Math.max(1, Math.min(10, Math.floor(Number(process.env.POST_BATCH_SIZE) || 1))),
    gapMin: 15,
    staggerMin: 3,
  };
}

export function slotsOf(p: Plan): number[] {
  const out = new Set<number>();
  if (p.mode === "times") {
    for (const t of p.times) out.add(toMinutes(t));
  } else {
    const s = toMinutes(p.start);
    const e = toMinutes(p.end);
    for (let m = s; m <= e && out.size < MAX_SLOTS; m += Math.max(1, p.intervalMin)) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

export const planSchema = z.object({
  mode: z.enum(["times", "interval"]),
  times: z.array(z.string().regex(hhmm, "Time HH:MM format mein do (jaise 10:30)")).max(MAX_SLOTS).default([]),
  start: z.string().regex(hhmm, "Start time galat hai").default("09:00"),
  end: z.string().regex(hhmm, "End time galat hai").default("21:00"),
  intervalMin: z.number().int().min(15, "Interval kam se kam 15 minute").max(720).default(120),
  perRun: z.number().int().min(1, "Ek baar mein kam se kam 1").max(10, "Ek baar mein max 10"),
  gapMin: z.number().int().min(0).max(240).default(0),
  staggerMin: z.number().int().min(0).max(120).default(0),
});

// Returns a clean plan, or an error message to show the user.
export function checkPlan(input: unknown): { plan: Plan } | { error: string } {
  const r = planSchema.safeParse(input);
  if (!r.success) return { error: r.error.issues[0].message };
  const p: Plan = {
    ...r.data,
    times: [...new Set(r.data.times.map(normTime))].sort(),
    start: normTime(r.data.start),
    end: normTime(r.data.end),
  };
  if (p.mode === "times" && p.times.length === 0) return { error: "Kam se kam ek posting time chahiye." };
  if (p.mode === "interval" && toMinutes(p.end) < toMinutes(p.start)) return { error: "End time start time ke baad hona chahiye." };
  const slots = slotsOf(p).length;
  if (slots === 0) return { error: "Is plan mein koi slot nahi bana." };
  const perDay = slots * p.perRun;
  if (perDay > DAILY_CAP) {
    return { error: `Plan se ek account par roz ${perDay} reels banti hain, safety limit ${DAILY_CAP} hai. Slots ya "ek baar mein" kam karo.` };
  }
  return { plan: p };
}

export async function loadPlan(userId: string): Promise<Plan> {
  const { rows } = await pool.query(
    `SELECT mode, times, start_time, end_time, interval_min, per_run, gap_min, stagger_min FROM post_plan WHERE user_id = $1`,
    [userId]
  );
  const r = rows[0];
  if (!r) return defaultPlan();
  return {
    mode: r.mode === "interval" ? "interval" : "times",
    times: String(r.times).split(",").map((s) => s.trim()).filter((s) => hhmm.test(s)),
    start: r.start_time,
    end: r.end_time,
    intervalMin: r.interval_min,
    perRun: r.per_run,
    gapMin: r.gap_min,
    staggerMin: r.stagger_min,
  };
}

export async function savePlan(userId: string, p: Plan): Promise<void> {
  await pool.query(
    `INSERT INTO post_plan (user_id, mode, times, start_time, end_time, interval_min, per_run, gap_min, stagger_min)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, times = EXCLUDED.times, start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time, interval_min = EXCLUDED.interval_min, per_run = EXCLUDED.per_run,
       gap_min = EXCLUDED.gap_min, stagger_min = EXCLUDED.stagger_min, updated_at = now()`,
    [userId, p.mode, p.times.join(","), p.start, p.end, p.intervalMin, p.perRun, p.gapMin, p.staggerMin]
  );
  // Slots that already passed today are marked done, so saving a new plan never fires a burst of "missed" posts.
  const { date, minutes } = localNow();
  for (const s of slotsOf(p)) {
    if (s <= minutes) {
      await pool.query("INSERT INTO queue_runs (slot_key) VALUES ($1) ON CONFLICT DO NOTHING", [slotKey(userId, date, s)]);
    }
  }
}

export const slotKey = (userId: string, date: string, minutes: number) => `${userId} ${date} ${label(minutes)}`;

export function localNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

// Next posting time for the dashboard.
export function nextSlot(p: Plan): { time: string; tomorrow: boolean } | null {
  const slots = slotsOf(p);
  if (!slots.length) return null;
  const { minutes } = localNow();
  const later = slots.find((s) => s > minutes);
  return later !== undefined ? { time: label(later), tomorrow: false } : { time: label(slots[0]), tomorrow: true };
}
