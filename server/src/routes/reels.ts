import express, { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { release } from "../lib/publisher";
import { DAILY_CAP, LIBRARY_MAX, TZ, checkPlan, loadPlan, localNow, nextSlot, label, savePlan, slotsOf } from "../lib/plan";
import { newToken } from "../lib/security";
import { botUsername, pairCode, telegramEnabled } from "../lib/telegram";
import { requireAuth, wrap } from "./auth";

export const reelsRouter = Router();
reelsRouter.use(requireAuth);

// ---- Library ----
reelsRouter.get(
  "/library",
  wrap(async (req, res) => {
    const uid = req.user!.id;
    const [cnt, st, acc, link, plan] = await Promise.all([
      pool.query("SELECT count(*)::int AS n FROM library WHERE user_id = $1", [uid]),
      pool.query("SELECT caption, cover_token FROM queue_settings WHERE user_id = $1", [uid]),
      pool.query("SELECT count(*)::int AS n FROM instagram_accounts WHERE user_id = $1 AND status = 'active'", [uid]),
      pool.query("SELECT 1 FROM telegram_links WHERE user_id = $1 LIMIT 1", [uid]),
      loadPlan(uid),
    ]);
    const token = st.rows[0]?.cover_token as string | undefined;
    const slots = slotsOf(plan).map(label);
    res.json({
      count: cnt.rows[0].n,
      max: LIBRARY_MAX,
      caption: st.rows[0]?.caption ?? "",
      coverUrl: token ? `/api/public/cover/${token}.jpg` : null,
      accounts: acc.rows[0].n,
      plan: { ...plan, slots, perDay: slots.length * plan.perRun, cap: DAILY_CAP, tz: TZ, next: nextSlot(plan) },
      telegram: {
        enabled: telegramEnabled,
        linked: link.rows.length > 0,
        code: pairCode(uid),
        bot: await botUsername(),
      },
    });
  })
);

// Save the posting plan (times or interval, reels per run, gaps).
reelsRouter.put(
  "/plan",
  wrap(async (req, res) => {
    const r = checkPlan(req.body);
    if ("error" in r) return res.status(400).json({ error: r.error });
    await savePlan(req.user!.id, r.plan);
    res.json({ ok: true });
  })
);

const settingsSchema = z.object({
  caption: z.string().max(2200, "Caption can be at most 2200 characters").default(""),
});

reelsRouter.put(
  "/library/settings",
  wrap(async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    await pool.query(
      `INSERT INTO queue_settings (user_id, caption) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET caption = EXCLUDED.caption, updated_at = now()`,
      [req.user!.id, parsed.data.caption]
    );
    res.json({ ok: true });
  })
);

// The fixed cover (JPG). Instagram fetches it from our public /api/public/cover/<token>.jpg link.
reelsRouter.put(
  "/library/cover",
  express.raw({ type: "image/jpeg", limit: "5mb" }),
  wrap(async (req, res) => {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
      return res.status(400).json({ error: "Please choose a JPG image (max 5 MB)" });
    }
    await pool.query(
      `INSERT INTO queue_settings (user_id, cover_data, cover_token) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET cover_data = EXCLUDED.cover_data, cover_token = EXCLUDED.cover_token, updated_at = now()`,
      [req.user!.id, body, newToken(16)]
    );
    res.json({ ok: true });
  })
);

// Deletes this user's library, settings and all posts. (Videos live in Telegram, nothing else to clean.)
reelsRouter.post(
  "/library/reset",
  wrap(async (req, res) => {
    const uid = req.user!.id;
    await pool.query("DELETE FROM reels WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM library WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM queue_settings WHERE user_id = $1", [uid]);
    res.json({ ok: true });
  })
);

// Test: post the first N library videos right now (to every connected account).
reelsRouter.post(
  "/library/test",
  wrap(async (req, res) => {
    const parsed = z.object({ count: z.number().int().min(1).max(5) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid count" });
    // Double-click / repeat guard: never create a second batch while posts are still waiting or being published.
    const pending = await pool.query(
      `SELECT 1 FROM reels WHERE user_id = $1
       AND status IN ('scheduled', 'publishing', 'container_created', 'publish_requested') LIMIT 1`,
      [req.user!.id]
    );
    if (pending.rows[0]) {
      return res.status(409).json({ error: "Pehle ki posts abhi chal rahi hain. Unke khatam hone ka wait karo, phir test karo." });
    }
    const n = await release(parsed.data.count, req.user!.id);
    res.json({ created: n });
  })
);

reelsRouter.delete(
  "/library/:id",
  wrap(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid id" });
    const r = await pool.query("DELETE FROM library WHERE id = $1 AND user_id = $2", [id.data, req.user!.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  })
);

// ---- Posts: only a short summary + the latest few (keeps the dashboard light) ----
reelsRouter.get(
  "/",
  wrap(async (req, res) => {
    const uid = req.user!.id;
    const { date } = localNow();
    const [list, today] = await Promise.all([
      pool.query(
        `SELECT r.id, r.scheduled_at, r.error, a.username,
                CASE WHEN r.status IN ('container_created', 'publish_requested') THEN 'publishing' ELSE r.status END AS status
         FROM reels r JOIN instagram_accounts a ON a.id = r.instagram_account_id
         WHERE r.user_id = $1
         ORDER BY r.scheduled_at DESC, r.created_at ASC LIMIT 12`,
        [uid]
      ),
      pool.query(
        `SELECT CASE WHEN status IN ('container_created', 'publish_requested', 'publishing') THEN 'publishing' ELSE status END AS s,
                count(*)::int AS n
         FROM reels
         WHERE user_id = $1 AND (scheduled_at AT TIME ZONE $2::text)::date = $3::date
         GROUP BY 1`,
        [uid, TZ, date]
      ),
    ]);
    const t: Record<string, number> = { published: 0, scheduled: 0, publishing: 0, failed: 0 };
    for (const r of today.rows) t[r.s] = (t[r.s] ?? 0) + r.n;
    res.json({ reels: list.rows, today: t });
  })
);

// Removes a waiting or failed post only. The video stays in the library.
reelsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid id" });
    const r = await pool.query(
      "DELETE FROM reels WHERE id = $1 AND user_id = $2 AND status IN ('scheduled', 'failed')",
      [id.data, req.user!.id]
    );
    if (!r.rowCount) return res.status(409).json({ error: "This post can't be deleted right now" });
    res.json({ ok: true });
  })
);
