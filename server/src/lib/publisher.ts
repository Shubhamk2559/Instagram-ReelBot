import { env } from "../config/env";
import { pool } from "../db/pool";
import { IgError, describeError, getPublishingQuota, igGet, igPost, refreshLongLivedToken } from "./instagram";
import { decryptToken, encryptToken, sha256 } from "./security";
import { startTelegram } from "./telegram";
import { DAILY_CAP, LIBRARY_MAX, TZ, loadPlan, localNow, slotKey, slotsOf, type Plan } from "./plan";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Safety limits ----
const MAX_ATTEMPTS = 3; // container-creation attempts per post (only safe, pre-publish steps are retried)
const MAX_PARALLEL = 3; // different Instagram accounts processed at once (one post per account at a time)
const STALE_MINUTES = 10; // an in-flight post with no heartbeat for this long is recovered
const MISSED_HOURS = 12; // a waiting post older than this is dropped instead of posting very late
// Meta recommends checking container status about once a minute for at most ~5 minutes. We start a bit earlier, then slow down.
const POLL_DELAYS_S = [20, 30, 60, 60, 60, 60, 60, 60, 60, 60];

const GRACE_MIN = 60; // a slot is still fired up to this many minutes late (e.g. after a restart)

// Creates posting jobs for ONE user from the library. Rules (these protect the Meta developer app):
//  * accounts of the same user never get the same video: each account gets different videos,
//  * a video is used at most ONCE per day per user (never twice on one account, never on two accounts) - also enforced by a DB unique index,
//  * videos rotate fairly: the one posted longest ago (or never) goes first, so the whole library is used before any repeat,
//  * posts are spread out: `gapMin` between reels of one account, `staggerMin` between accounts.
export async function release(perAccount: number, userId: string, planOverride?: Plan): Promise<number> {
  if (perAccount <= 0) return 0;
  const plan = planOverride ?? (await loadPlan(userId));
  const accounts = await pool.query<{ id: string }>(
    `SELECT id FROM instagram_accounts WHERE status = 'active' AND user_id = $1 ORDER BY connected_at, id`,
    [userId]
  );
  const { date } = localNow();
  let created = 0;
  for (let idx = 0; idx < accounts.rows.length; idx++) {
    const a = accounts.rows[idx];
    // Sequential on purpose: each INSERT is visible to the next account's "already used today" check.
    const r = await pool.query(
      `WITH pick AS (
         SELECT k.user_id, k.video_url, k.video_public_id, k.tg_file_id,
                COALESCE(k.tg_file_id, k.video_url) AS vkey,
                row_number() OVER (ORDER BY lu.last_used NULLS FIRST, k.created_at, k.id) AS rn
         FROM library k
         LEFT JOIN LATERAL (
           SELECT max(r.created_at) AS last_used FROM reels r
           WHERE r.user_id = k.user_id AND r.status <> 'failed'
             AND COALESCE(r.video_key, r.tg_file_id, r.video_url) = COALESCE(k.tg_file_id, k.video_url)
         ) lu ON true
         WHERE k.user_id = $1::uuid
           AND COALESCE(k.tg_file_id, k.video_url) IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM reels r
             WHERE r.user_id = k.user_id
               AND COALESCE(r.video_key, r.tg_file_id, r.video_url) = COALESCE(k.tg_file_id, k.video_url)
               AND COALESCE(r.post_day, (r.created_at AT TIME ZONE $6::text)::date) = $5::date
           )
         ORDER BY lu.last_used NULLS FIRST, k.created_at, k.id
         LIMIT $3::int
       )
       INSERT INTO reels (user_id, instagram_account_id, video_url, video_public_id, tg_file_id, cover_url, caption,
                          status, scheduled_at, video_key, post_day)
       SELECT p.user_id, $2::uuid, p.video_url, p.video_public_id, p.tg_file_id,
              CASE WHEN s.cover_token IS NOT NULL THEN $4::text || s.cover_token || '.jpg' END,
              COALESCE(s.caption, ''), 'scheduled',
              now() + make_interval(mins => (((p.rn - 1) * $7::int + $8::int) + floor(random() * 8)::int)::int), -- small random jitter: posts never land at identical clock times
              p.vkey, $5::date
       FROM pick p
       LEFT JOIN queue_settings s ON s.user_id = p.user_id
       ON CONFLICT DO NOTHING`,
      [userId, a.id, perAccount, `${env.APP_BASE_URL}/api/public/cover/`, date, TZ, plan.gapMin, idx * plan.staggerMin]
    );
    created += r.rowCount ?? 0;
  }
  return created;
}

async function promoteSlots() {
  const { date, minutes } = localNow();
  const users = await pool.query<{ user_id: string }>("SELECT DISTINCT user_id FROM instagram_accounts WHERE status = 'active'");
  let claimedAny = false;
  for (const u of users.rows) {
    const plan = await loadPlan(u.user_id);
    for (const s of slotsOf(plan)) {
      if (minutes < s || minutes - s > GRACE_MIN) continue;
      const key = slotKey(u.user_id, date, s);
      // Atomic claim: only one instance/tick can ever create the posts for a slot.
      const claimed = await pool.query(
        "INSERT INTO queue_runs (slot_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING slot_key",
        [key]
      );
      if (!claimed.rows[0]) continue;
      claimedAny = true;
      try {
        const n = await release(plan.perRun, u.user_id, plan);
        console.log(`Slot ${key}: created ${n} post(s)`);
      } catch (err) {
        // release() is one INSERT per account, so un-claiming the slot is safe and lets the next tick retry.
        console.error(`Slot ${key} failed, will retry:`, describeError(err));
        await pool.query("DELETE FROM queue_runs WHERE slot_key = $1", [key]).catch(() => {});
      }
    }
  }
  if (claimedAny) {
    await pool.query("DELETE FROM queue_runs WHERE ran_at < now() - interval '30 days'");
    await pool.query("DELETE FROM reels WHERE status IN ('published', 'failed') AND created_at < now() - interval '60 days'");
  }
}

// ---------------------------------------------------------------------------
// Publishing
//
// State machine (a row only moves forward through atomic compare-and-set UPDATEs):
//
//   scheduled -> publishing -> container_created -> publish_requested -> published
//                    |               |                    |
//                    +---------------+--------------------+--> failed
//
// * publishing          : creating the Instagram upload container (nothing public yet -> safe to retry)
// * container_created   : container exists, waiting for Instagram to finish processing (safe to resume)
// * publish_requested   : media_publish was SENT. It is NEVER sent a second time for this post.
// ---------------------------------------------------------------------------
type Job = {
  id: string;
  video_url: string | null;
  tg_file_id: string | null;
  cover_url: string | null;
  caption: string;
  ig_container_id: string | null;
  attempts: number;
  status: string;
  account_id: string;
  instagram_user_id: string;
  access_token_encrypted: string;
  token_expires_at: Date | null;
  account_status: string;
};

const cols = (t: string) =>
  `${t}.id, ${t}.video_url, ${t}.tg_file_id, ${t}.cover_url, ${t}.caption, ${t}.ig_container_id, ${t}.attempts, ${t}.status,
   a.id AS account_id, a.instagram_user_id, a.access_token_encrypted, a.token_expires_at, a.status AS account_status`;

// A failure that must not be retried.
class JobFailure extends Error {}

const backoffSeconds = (attempts: number) => Math.min(30 * 60, 120 * 2 ** Math.max(attempts - 1, 0));

async function setAccountState(accountId: string, status: "expired" | "revoked", reason: string) {
  // Only flips an ACTIVE account, so a dead token is recorded once instead of being retried forever.
  await pool.query("UPDATE instagram_accounts SET status = $2, last_error = $3 WHERE id = $1 AND status = 'active'", [
    accountId,
    status,
    reason.slice(0, 400),
  ]);
}

// Puts a post back in the waiting list. Only valid BEFORE media_publish succeeded or was refused by Meta.
async function requeue(jobId: string, delaySeconds: number, burnAttempt: boolean, reason: string) {
  await pool.query(
    `UPDATE reels SET status = 'scheduled', ig_container_id = NULL,
       scheduled_at = now() + make_interval(secs => $2::int),
       attempts = GREATEST(attempts - $3::int, 0), error = $4
     WHERE id = $1 AND status IN ('publishing', 'container_created', 'publish_requested')`,
    [jobId, delaySeconds, burnAttempt ? 0 : 1, reason.slice(0, 400)]
  );
}

async function failJob(jobId: string, message: string) {
  await pool.query("UPDATE reels SET status = 'failed', error = $2 WHERE id = $1 AND status <> 'published'", [
    jobId,
    message.slice(0, 500),
  ]);
}

async function markPublished(job: Job, mediaId: string | null) {
  await pool.query(
    "UPDATE reels SET status = 'published', ig_media_id = $1, published_at = now(), error = NULL WHERE id = $2",
    [mediaId, job.id]
  );
  await pool.query("UPDATE instagram_accounts SET last_used_at = now(), last_error = NULL WHERE id = $1", [job.account_id]);
}

// After Instagram throttles an account, push ALL its waiting posts back so we stop calling the API.
async function pauseAccount(accountId: string, minutes: number) {
  await pool.query(
    `UPDATE reels SET scheduled_at = GREATEST(scheduled_at, now() + make_interval(mins => $2::int))
     WHERE instagram_account_id = $1 AND status = 'scheduled'`,
    [accountId, minutes]
  );
}

async function underDailyCap(accountId: string): Promise<boolean> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reels
     WHERE instagram_account_id = $1
       AND ((status = 'published' AND published_at > now() - interval '24 hours')
            OR status IN ('container_created', 'publish_requested'))`,
    [accountId]
  );
  return r.rows[0].n < DAILY_CAP;
}

// "{Wait for it|Watch till the end}" -> one random option per post, so identical captions are not repeated on every Reel.
function spin(text: string): string {
  let out = text;
  for (let i = 0; i < 20 && /\{[^{}]*\|[^{}]*\}/.test(out); i++) {
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, g: string) => {
      const opts = g.split("|");
      return opts[Math.floor(Math.random() * opts.length)].trim();
    });
  }
  return out.slice(0, 2200);
}

async function createContainer(job: Job, token: string): Promise<string> {
  const params: Record<string, string> = {
    media_type: "REELS",
    caption: spin(job.caption),
    share_to_feed: "true",
    access_token: token,
  };
  if (job.tg_file_id) {
    // Video lives in Telegram. Instagram fetches it from our own signed public link, which proxies Telegram.
    const sig = sha256(`video:${job.id}:${env.TOKEN_ENCRYPTION_KEY}`).slice(0, 32);
    params.video_url = `${env.APP_BASE_URL}/api/public/video/${job.id}/${sig}.mp4`;
  } else if (job.video_url) {
    params.video_url = job.video_url;
  } else {
    throw new JobFailure("This post has no video attached.");
  }
  if (job.cover_url) params.cover_url = job.cover_url;
  const r = await igPost<{ id?: string }>(`${job.instagram_user_id}/media`, params);
  if (!r.id) throw new JobFailure("Instagram did not return an upload id.");
  return r.id;
}

// Gentle polling with a heartbeat so other instances know this job is alive.
async function waitUntilFinished(jobId: string, containerId: string, token: string): Promise<"finished" | "published"> {
  for (const delay of POLL_DELAYS_S) {
    await sleep(delay * 1000);
    await pool.query("UPDATE reels SET updated_at = now() WHERE id = $1", [jobId]);
    let s: { status_code?: string; status?: string };
    try {
      s = await igGet<{ status_code?: string; status?: string }>(containerId, {
        fields: "status_code,status",
        access_token: token,
      });
    } catch (e) {
      if (e instanceof IgError && e.kind === "transient") continue; // temporary hiccup: just check again later
      throw e;
    }
    if (s.status_code === "FINISHED") return "finished";
    if (s.status_code === "PUBLISHED") return "published";
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
      throw new JobFailure(`Instagram could not process the video (${s.status ?? s.status_code}).`);
    }
  }
  throw new JobFailure("Instagram took too long to process the video.");
}

// The outcome of media_publish is unknown (timeout / connection lost / 5xx). Never re-send it: ask Instagram instead.
// This function never throws and never re-queues: from here a post can only become published or failed.
async function reconcile(job: Job, containerId: string, token: string, checks: number, gapSeconds: number) {
  for (let i = 0; i < checks; i++) {
    if (gapSeconds > 0) await sleep(gapSeconds * 1000);
    try {
      const s = await igGet<{ status_code?: string }>(containerId, { fields: "status_code", access_token: token });
      if (s.status_code === "PUBLISHED") {
        await markPublished(job, null);
        return;
      }
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") break;
    } catch (e) {
      if (e instanceof IgError && (e.kind === "auth_expired" || e.kind === "auth_revoked")) {
        await setAccountState(job.account_id, e.kind === "auth_expired" ? "expired" : "revoked", "Instagram connection expired. Please reconnect.").catch(() => {});
        break;
      }
    }
  }
  await failJob(
    job.id,
    "Instagram did not confirm this post. It was NOT retried automatically (to avoid a duplicate). Check your Instagram profile."
  ).catch(() => {});
}

async function processJob(job: Job): Promise<void> {
  if (job.account_status !== "active") {
    await requeue(job.id, 60, false, "Waiting for Instagram reconnect.");
    return;
  }
  if (job.token_expires_at && new Date(job.token_expires_at).getTime() < Date.now()) {
    await setAccountState(job.account_id, "expired", "Instagram connection expired. Please reconnect.");
    await requeue(job.id, 60, false, "Waiting for Instagram reconnect.");
    return;
  }

  let token: string;
  try {
    token = decryptToken(job.access_token_encrypted);
  } catch {
    await setAccountState(job.account_id, "revoked", "Saved connection could not be read. Please reconnect Instagram.");
    await requeue(job.id, 60, false, "Waiting for Instagram reconnect.");
    return;
  }

  // 1) Create the upload container (skipped when resuming a post that already has one).
  let containerId = job.ig_container_id;
  if (!containerId) {
    if (!(await underDailyCap(job.account_id))) {
      await requeue(job.id, 3600, false, "Daily Instagram publishing limit reached; will try again later.");
      return;
    }
    // Ask Meta how much of the 24h publishing quota is really used (also counts posts made outside this app).
    const quota = await getPublishingQuota(job.instagram_user_id, token);
    if (quota && quota.used >= Math.min(quota.total - 5, DAILY_CAP * 3)) {
      await requeue(job.id, 3600, false, "Instagram publishing quota nearly used up; will try again later.");
      return;
    }
    containerId = await createContainer(job, token);
    const saved = await pool.query(
      "UPDATE reels SET status = 'container_created', ig_container_id = $1 WHERE id = $2 AND status = 'publishing' RETURNING id",
      [containerId, job.id]
    );
    if (!saved.rows[0]) return; // post changed under us: do nothing, never publish
  }

  // 2) Wait for Instagram to process the video.
  const state = await waitUntilFinished(job.id, containerId, token);
  if (state === "published") {
    await markPublished(job, null);
    return;
  }

  // 3) Atomic hand-off: only ONE worker can move container_created -> publish_requested, so only one can publish.
  const claim = await pool.query(
    "UPDATE reels SET status = 'publish_requested' WHERE id = $1 AND status = 'container_created' RETURNING id",
    [job.id]
  );
  if (!claim.rows[0]) return;

  let mediaId: string | null = null;
  try {
    const pub = await igPost<{ id?: string }>(
      `${job.instagram_user_id}/media_publish`,
      { creation_id: containerId, access_token: token },
      60_000
    );
    mediaId = pub.id ?? null;
  } catch (err) {
    if (err instanceof IgError && !err.definitive) {
      // Unknown outcome: it may have worked. Check, never re-send.
      await reconcile(job, containerId, token, 3, 20);
      return;
    }
    throw err; // Meta explicitly refused: nothing was published
  }
  await markPublished(job, mediaId);
}

async function handleError(job: Job, err: unknown) {
  const msg = describeError(err);
  if (err instanceof JobFailure) return failJob(job.id, msg);

  if (err instanceof IgError) {
    switch (err.kind) {
      case "auth_expired":
      case "auth_revoked": {
        const expired = err.kind === "auth_expired";
        console.error(`Account ${job.account_id}: ${expired ? "token expired" : "access revoked"} (${msg})`);
        await setAccountState(
          job.account_id,
          expired ? "expired" : "revoked",
          expired
            ? "Instagram connection expired. Please reconnect."
            : "Instagram access was removed or a permission is missing. Please reconnect."
        );
        // Wait for the user to reconnect. No retry loop: waiting posts are skipped while the account is not active.
        return requeue(job.id, 60, false, "Waiting for Instagram reconnect.");
      }
      case "rate_limit":
        console.error(`Account ${job.account_id}: Instagram rate limit (${msg}). Pausing 30 minutes.`);
        await pauseAccount(job.account_id, 30);
        return requeue(job.id, 30 * 60, false, "Instagram rate limit; will try again later.");
      case "transient":
        if (job.attempts < MAX_ATTEMPTS) {
          return requeue(job.id, backoffSeconds(job.attempts), true, `Temporary Instagram problem, retrying: ${msg}`);
        }
        return failJob(job.id, msg);
      default:
        return failJob(job.id, msg);
    }
  }
  console.error(`Reel ${job.id} unexpected error:`, msg);
  const cur = await pool.query<{ status: string }>("SELECT status FROM reels WHERE id = $1", [job.id]).catch(() => null);
  // If media_publish was already sent, leave it for the stale-job reconciler (it may really be published).
  if (cur?.rows[0]?.status === "publish_requested") return;
  return failJob(job.id, `Unexpected error: ${msg}`);
}

let active = 0;

function launch(jobs: Job[], fn: (job: Job) => Promise<void>) {
  for (const job of jobs) {
    active++;
    fn(job)
      .catch((e) => console.error(`Reel ${job.id} crashed:`, describeError(e)))
      .finally(() => {
        active--;
      });
  }
}

async function runJob(job: Job): Promise<void> {
  try {
    await processJob(job);
    const done = await pool.query<{ status: string }>("SELECT status FROM reels WHERE id = $1", [job.id]);
    if (done.rows[0]?.status === "published") console.log(`Published reel ${job.id}`);
  } catch (err) {
    await handleError(job, err);
  }
}

// Post whose publish result was never recorded (crash/restart): ask Instagram once, never re-publish.
async function runReconcile(job: Job): Promise<void> {
  try {
    if (!job.ig_container_id) return await failJob(job.id, "Interrupted while publishing. Check your Instagram profile.");
    await reconcile(job, job.ig_container_id, decryptToken(job.access_token_encrypted), 1, 0);
  } catch (err) {
    console.error(`Reel ${job.id} reconcile error:`, describeError(err));
    await failJob(job.id, "Instagram did not confirm this post. Check your Instagram profile.").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Housekeeping that runs every tick (database only, no Instagram calls)
// ---------------------------------------------------------------------------
async function housekeeping() {
  await pool.query(
    `UPDATE instagram_accounts SET status = 'expired', last_error = 'Instagram connection expired. Please reconnect.'
     WHERE status = 'active' AND token_expires_at IS NOT NULL AND token_expires_at < now()`
  );
  await pool.query(
    `UPDATE reels SET status = 'failed',
       error = 'Missed: Instagram was not ready in time. This video will post again at its next slot.'
     WHERE status = 'scheduled' AND scheduled_at < now() - make_interval(hours => $1::int)`,
    [MISSED_HOURS]
  );
}

// Jobs left in-flight by a crash / restart / Koyeb redeploy.
async function recoverStale() {
  // a) Interrupted while creating the container: nothing was published, safe to retry (bounded, with backoff).
  await pool.query(
    `UPDATE reels SET
       status = CASE WHEN attempts >= $1::int THEN 'failed' ELSE 'scheduled' END,
       ig_container_id = NULL,
       scheduled_at = now() + make_interval(secs => LEAST(1800, 120 * (2 ^ GREATEST(attempts - 1, 0)))::int),
       error = CASE WHEN attempts >= $1::int THEN 'Interrupted while preparing the upload. Not retried further.'
                    ELSE 'Interrupted (restart), retrying safely.' END
     WHERE status = 'publishing' AND updated_at < now() - make_interval(mins => $2::int)`,
    [MAX_ATTEMPTS, STALE_MINUTES]
  );

  // b) Container exists but nobody is polling it: give up after too many resumes, otherwise resume (no new container).
  await pool.query(
    `UPDATE reels SET status = 'failed', error = 'Instagram processing was interrupted too many times.'
     WHERE status = 'container_created' AND attempts >= 5 AND updated_at < now() - make_interval(mins => $1::int)`,
    [STALE_MINUTES]
  );
  const resume = await pool.query<Job>(
    `WITH s AS (
       SELECT id FROM reels
       WHERE status = 'container_created' AND attempts < 5 AND updated_at < now() - make_interval(mins => $1::int)
       ORDER BY updated_at LIMIT 3 FOR UPDATE SKIP LOCKED
     ), u AS (
       UPDATE reels r SET updated_at = now(), attempts = r.attempts + 1 FROM s WHERE r.id = s.id RETURNING r.*
     )
     SELECT ${cols("u")} FROM u JOIN instagram_accounts a ON a.id = u.instagram_account_id`,
    [STALE_MINUTES]
  );
  launch(resume.rows, runJob);

  // c) media_publish was sent but the result was never saved: check once, NEVER publish again.
  const recon = await pool.query<Job>(
    `WITH s AS (
       SELECT id FROM reels
       WHERE status = 'publish_requested' AND updated_at < now() - make_interval(mins => $1::int)
       ORDER BY updated_at LIMIT 3 FOR UPDATE SKIP LOCKED
     ), u AS (
       UPDATE reels r SET updated_at = now() FROM s WHERE r.id = s.id RETURNING r.*
     )
     SELECT ${cols("u")} FROM u JOIN instagram_accounts a ON a.id = u.instagram_account_id`,
    [STALE_MINUTES]
  );
  launch(recon.rows, runReconcile);
}

// ---------------------------------------------------------------------------
// Token renewal: the official refresh endpoint, ~once per 40 days per account.
// ---------------------------------------------------------------------------
async function refreshTokens() {
  const { rows } = await pool.query<{ id: string; access_token_encrypted: string }>(
    `UPDATE instagram_accounts a SET last_refresh_attempt_at = now()
     WHERE a.id IN (
       SELECT id FROM instagram_accounts
       WHERE status = 'active' AND token_expires_at IS NOT NULL
         AND token_expires_at > now() AND token_expires_at < now() + interval '20 days'
         AND COALESCE(token_refreshed_at, connected_at) < now() - interval '25 hours'
         AND (last_refresh_attempt_at IS NULL OR last_refresh_attempt_at < now() - interval '12 hours')
       ORDER BY token_expires_at LIMIT 3 FOR UPDATE SKIP LOCKED
     )
     RETURNING a.id, a.access_token_encrypted`
  );
  for (const a of rows) {
    try {
      const fresh = await refreshLongLivedToken(decryptToken(a.access_token_encrypted));
      await pool.query(
        `UPDATE instagram_accounts SET access_token_encrypted = $2,
           token_expires_at = now() + make_interval(secs => $3::int), token_refreshed_at = now(), last_error = NULL
         WHERE id = $1 AND status = 'active'`,
        [a.id, encryptToken(fresh.access_token), fresh.expires_in]
      );
      console.log(`Renewed Instagram token for account ${a.id}`);
    } catch (err) {
      if (err instanceof IgError && (err.kind === "auth_expired" || err.kind === "auth_revoked")) {
        await setAccountState(
          a.id,
          err.kind === "auth_expired" ? "expired" : "revoked",
          "Instagram connection expired or was revoked. Please reconnect."
        );
      } else {
        // Not retried for 12 hours (see last_refresh_attempt_at): no retry storm.
        console.error(`Token renewal failed for account ${a.id} (retry in 12h):`, describeError(err));
      }
    }
  }
}

// Claims at most ONE waiting post per account (and only for accounts with nothing in flight).
async function claimDue(limit: number): Promise<Job[]> {
  const { rows } = await pool.query<Job>(
    `WITH cand AS (
       SELECT DISTINCT ON (r.instagram_account_id) r.id, r.scheduled_at, r.created_at
       FROM reels r
       JOIN instagram_accounts a ON a.id = r.instagram_account_id AND a.status = 'active'
       WHERE r.status = 'scheduled' AND r.scheduled_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM reels x
           WHERE x.instagram_account_id = r.instagram_account_id
             AND x.status IN ('publishing', 'container_created', 'publish_requested')
         )
       ORDER BY r.instagram_account_id, r.scheduled_at, r.created_at
     ), due AS (
       SELECT r.id FROM reels r JOIN cand ON cand.id = r.id
       ORDER BY cand.scheduled_at, cand.created_at
       LIMIT $1
       FOR UPDATE OF r SKIP LOCKED
     ), upd AS (
       UPDATE reels r SET status = 'publishing', attempts = r.attempts + 1, error = NULL
       FROM due WHERE r.id = due.id AND r.status = 'scheduled'
       RETURNING r.*
     )
     SELECT ${cols("upd")} FROM upd JOIN instagram_accounts a ON a.id = upd.instagram_account_id`,
    [limit]
  );
  return rows;
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await housekeeping();
    await promoteSlots();
    await refreshTokens();
    await recoverStale();
    const room = MAX_PARALLEL - active;
    if (room > 0) launch(await claimDue(room), runJob);
  } catch (err) {
    console.error("Publisher tick error:", describeError(err));
  } finally {
    ticking = false;
  }
}

export function startPublisher(): () => void {
  console.log(`Plans are per user (dashboard). tz ${TZ} | daily cap ${DAILY_CAP}/account | library max ${LIBRARY_MAX}`);
  startTelegram(() => LIBRARY_MAX);
  const timer = setInterval(tick, 30_000);
  setTimeout(tick, 5_000);
  return () => clearInterval(timer);
}
