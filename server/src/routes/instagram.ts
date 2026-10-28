import { Response, Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { GRAPH, GRAPH_HOST, IgError, describeError, igFetch, redact } from "../lib/instagram";
import { encryptToken, newToken, sha256 } from "../lib/security";
import { requireAuth, wrap } from "./auth";

// Minimum permissions needed to read the account and publish Reels. Nothing else is requested.
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
const REQUIRED_PUBLISH_SCOPE = "instagram_business_content_publish";
// Must match "Valid OAuth Redirect URIs" in Meta (Instagram > API setup with Instagram login > Business login settings) exactly.
const REDIRECT_URI = `${env.APP_BASE_URL}/api/instagram/callback`;
const CONNECT_COOLDOWN_SECONDS = 10;

export const instagramRouter = Router();
instagramRouter.use(requireAuth);

function back(res: Response, key: string) {
  res.set("Cache-Control", "no-store");
  return res.redirect(`/?instagram=${key}`);
}

// ---------------------------------------------------------------------------
// Step 1: user clicks "Connect Instagram" -> official Instagram login/consent screen.
// Happens ONCE per account (and again only if the connection expires/is revoked).
// ---------------------------------------------------------------------------
instagramRouter.get(
  "/connect",
  wrap(async (req, res) => {
    const uid = req.user!.id;

    // Anti-loop: ignore double clicks / prefetch / accidental repeats.
    const recent = await pool.query(
      `SELECT 1 FROM oauth_states WHERE user_id = $1 AND created_at > now() - ($2 || ' seconds')::interval LIMIT 1`,
      [uid, String(CONNECT_COOLDOWN_SECONDS)]
    );
    if (recent.rows[0]) return back(res, "wait");

    const state = newToken();
    await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");
    await pool.query(
      "INSERT INTO oauth_states (user_id, state_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')",
      [uid, sha256(state)]
    );

    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id", env.INSTAGRAM_APP_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(","));
    url.searchParams.set("state", state);
    // App ID and redirect URL are not secrets; logged so a mismatch with Meta's settings is easy to spot.
    console.log(`Instagram connect: client_id=${env.INSTAGRAM_APP_ID} redirect_uri=${REDIRECT_URI}`);
    res.set("Cache-Control", "no-store");
    res.redirect(url.toString());
  })
);

// ---------------------------------------------------------------------------
// Step 2: Instagram redirects back with ?code&state (or ?error...).
// ---------------------------------------------------------------------------
instagramRouter.get(
  "/callback",
  wrap(async (req, res) => {
    const q = req.query;
    const code = typeof q.code === "string" ? q.code : undefined;
    const state = typeof q.state === "string" ? q.state : undefined;
    const uid = req.user!.id;

    // State is single-use, expires in 10 minutes and must belong to the logged-in user (CSRF protection).
    // Consumed first, even on error, so a reloaded/replayed callback can never trigger a second exchange.
    let stateOk = false;
    if (state) {
      const used = await pool.query(
        "DELETE FROM oauth_states WHERE state_hash = $1 AND user_id = $2 AND expires_at > now() RETURNING id",
        [sha256(state), uid]
      );
      stateOk = Boolean(used.rows[0]);
    }

    // User pressed cancel / denied permission on Instagram's screen.
    if (q.error) {
      const reason = String(q.error_reason ?? q.error);
      return back(res, /denied|access_denied/i.test(reason) ? "denied" : "meta_rejected");
    }
    if (!code || !state) return back(res, "error");
    if (!stateOk) return back(res, "invalid_state");

    try {
      // 1) code -> short-lived token (1 hour). Codes are single-use.
      const shortRes = await igFetch<{
        access_token?: string;
        user_id?: string | number;
        permissions?: string;
        data?: { access_token?: string; user_id?: string | number; permissions?: string }[];
      }>("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.INSTAGRAM_APP_ID,
          client_secret: env.INSTAGRAM_APP_SECRET,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
          code,
        }),
      });
      const short = shortRes.data?.[0] ?? shortRes;
      if (!short.access_token) return back(res, "meta_rejected");

      // Granted permissions are reported by Meta; make sure publishing was really granted.
      const granted = String(short.permissions ?? "");
      if (granted && !granted.split(",").map((s) => s.trim()).includes(REQUIRED_PUBLISH_SCOPE)) {
        return back(res, "missing_permission");
      }

      // 2) short-lived -> long-lived token (~60 days, refreshed automatically by the publisher).
      const longUrl = new URL(`${GRAPH_HOST}/access_token`);
      longUrl.searchParams.set("grant_type", "ig_exchange_token");
      longUrl.searchParams.set("client_secret", env.INSTAGRAM_APP_SECRET);
      longUrl.searchParams.set("access_token", short.access_token);
      const long = await igFetch<{ access_token: string; expires_in: number }>(longUrl.toString());

      // 3) Which professional account is this?
      const meUrl = new URL(`${GRAPH}/me`);
      meUrl.searchParams.set("fields", "user_id,username,account_type");
      meUrl.searchParams.set("access_token", long.access_token);
      const me = await igFetch<{ user_id?: string; id?: string; username?: string; account_type?: string }>(meUrl.toString());

      const igUserId = String(me.user_id ?? me.id ?? short.user_id ?? "");
      if (!igUserId || !me.username) return back(res, "error");
      const appScopedId = String(me.id ?? short.user_id ?? "") || null; // Meta callbacks may report this id instead of user_id
      if (/personal/i.test(me.account_type ?? "")) return back(res, "not_professional");

      // 4) Save encrypted. One Instagram account can belong to only one scheduler user.
      const saved = await pool.query(
        `INSERT INTO instagram_accounts
           (user_id, instagram_user_id, username, account_type, access_token_encrypted,
            token_expires_at, token_refreshed_at, scopes, status, last_error, app_scoped_id)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval, now(), $7, 'active', NULL, $8)
         ON CONFLICT (instagram_user_id) DO UPDATE SET
           username = EXCLUDED.username,
           account_type = EXCLUDED.account_type,
           access_token_encrypted = EXCLUDED.access_token_encrypted,
           token_expires_at = EXCLUDED.token_expires_at,
           token_refreshed_at = now(),
           last_refresh_attempt_at = NULL,
           scopes = EXCLUDED.scopes,
           app_scoped_id = EXCLUDED.app_scoped_id,
           status = 'active',
           last_error = NULL
         WHERE instagram_accounts.user_id = EXCLUDED.user_id
         RETURNING id`,
        [uid, igUserId, me.username, me.account_type ?? null, encryptToken(long.access_token), String(long.expires_in), SCOPES.join(","), appScopedId]
      );
      if (!saved.rows[0]) return back(res, "taken");
      return back(res, "connected");
    } catch (err) {
      const msg = describeError(err);
      console.error("Instagram connect failed:", msg);
      if (err instanceof IgError && err.network) return back(res, "network");
      if (/authorization code|code (has|is) (been )?(used|expired|invalid)|invalid.*code/i.test(msg)) return back(res, "invalid_code");
      if (/developer role|tester|not authorized|invalid platform app|development mode/i.test(msg)) return back(res, "dev_mode");
      return back(res, "meta_rejected");
    }
  })
);

// ---------------------------------------------------------------------------
// Connected accounts. Tokens are NEVER returned.
// "state" tells the UI what to show: connected | expired | revoked.
// ---------------------------------------------------------------------------
instagramRouter.get(
  "/accounts",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, username, account_type, auth_type, token_expires_at, connected_at, last_used_at, last_error,
              CASE
                WHEN status = 'active' AND token_expires_at IS NOT NULL AND token_expires_at < now() THEN 'expired'
                ELSE status
              END AS status
       FROM instagram_accounts WHERE user_id = $1 ORDER BY connected_at DESC`,
      [req.user!.id]
    );
    res.json({
      accounts: rows.map((a) => ({ ...a, last_error: a.last_error ? redact(String(a.last_error)) : null })),
    });
  })
);

// ---------------------------------------------------------------------------
// Session ID login (unofficial, no Meta developer app needed).
// The Session ID is saved encrypted as "pending"; the reelbot worker verifies it,
// fills in the real username and flips the account to "active" (or "expired" with a reason).
// ---------------------------------------------------------------------------
const MAX_SESSION_ACCOUNTS = 10;

// Accepts "sessionid=...; ..." / quoted / URL-encoded / decoded input. Returns the cookie form (":" as %3A) or null.
function cleanSessionId(raw: string): string | null {
  let s = raw.trim().replace(/^["']+|["']+$/g, "");
  s = s.replace(/^sessionid\s*=\s*/i, "").replace(/;.*$/, "").trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as typed */
  }
  if (!/^\d{4,}:[A-Za-z0-9_.:-]{10,400}$/.test(s)) return null;
  return s.replace(/:/g, "%3A");
}

instagramRouter.post(
  "/session",
  wrap(async (req, res) => {
    const parsed = z.object({ sessionid: z.string().min(20).max(800) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Session ID paste karo (instagram.com ki 'sessionid' cookie value)." });
    const sid = cleanSessionId(parsed.data.sessionid);
    if (!sid) return res.status(400).json({ error: "Ye session ID jaisa nahi lag raha. Poori 'sessionid' cookie value paste karo (jaise 1234567890%3Aabc...)." });

    const uid = req.user!.id;
    const count = await pool.query("SELECT count(*)::int AS n FROM instagram_accounts WHERE user_id = $1 AND auth_type = 'session'", [uid]);
    if (count.rows[0].n >= MAX_SESSION_ACCOUNTS) {
      return res.status(400).json({ error: `Ek user ke liye max ${MAX_SESSION_ACCOUNTS} session accounts. Pehle koi disconnect karo.` });
    }
    await pool.query(
      `INSERT INTO instagram_accounts
         (user_id, instagram_user_id, username, account_type, access_token_encrypted, status, auth_type)
       VALUES ($1, $2, 'Verify ho raha hai...', 'session', $3, 'pending', 'session')`,
      [uid, `pending-${newToken(9)}`, encryptToken(sid)]
    );
    res.json({ ok: true });
  })
);

// Disconnect = delete the saved account and its token (its waiting posts are removed with it).
instagramRouter.delete(
  "/accounts/:id",
  wrap(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid id" });
    await pool.query("DELETE FROM instagram_accounts WHERE id = $1 AND user_id = $2", [id.data, req.user!.id]);
    res.json({ ok: true });
  })
);
