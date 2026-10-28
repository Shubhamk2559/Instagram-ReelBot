import crypto from "crypto";
import { Request, Response, Router } from "express";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { newToken } from "../lib/security";
import { wrap } from "./auth";

// Callbacks Meta requires before an app can go Live (Business Login for Instagram settings):
//   Deauthorize callback URL        -> {APP_BASE_URL}/api/meta/deauthorize
//   Data deletion request URL       -> {APP_BASE_URL}/api/meta/data-deletion
//   Privacy policy URL              -> {APP_BASE_URL}/privacy
//   Terms of service URL            -> {APP_BASE_URL}/terms
export const metaRouter = Router();
export const pagesRouter = Router();

function parseSignedRequest(raw: unknown): { user_id?: string | number } | null {
  if (typeof raw !== "string") return null;
  const [sig, payload] = raw.split(".");
  if (!sig || !payload) return null;
  const expected = crypto.createHmac("sha256", env.INSTAGRAM_APP_SECRET).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// Deleting the account row also removes its encrypted token and all of its waiting/failed/published post rows (ON DELETE CASCADE).
async function eraseInstagramData(igId: string): Promise<number> {
  const r = await pool.query("DELETE FROM instagram_accounts WHERE instagram_user_id = $1 OR app_scoped_id = $1", [igId]);
  return r.rowCount ?? 0;
}

metaRouter.post(
  "/deauthorize",
  wrap(async (req: Request, res: Response) => {
    const data = parseSignedRequest(req.body?.signed_request);
    if (!data?.user_id) return res.status(400).json({ error: "Invalid signed_request" });
    await eraseInstagramData(String(data.user_id));
    res.json({ ok: true });
  })
);

metaRouter.post(
  "/data-deletion",
  wrap(async (req: Request, res: Response) => {
    const data = parseSignedRequest(req.body?.signed_request);
    if (!data?.user_id) return res.status(400).json({ error: "Invalid signed_request" });
    const igId = String(data.user_id);
    const code = newToken(12);
    await pool.query("INSERT INTO deletion_requests (code, ig_user_id) VALUES ($1, $2)", [code, igId]);
    await eraseInstagramData(igId);
    await pool.query("UPDATE deletion_requests SET completed_at = now() WHERE code = $1", [code]);
    res.json({ url: `${env.APP_BASE_URL}/api/meta/data-deletion-status?code=${code}`, confirmation_code: code });
  })
);

metaRouter.get(
  "/data-deletion-status",
  wrap(async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const { rows } = await pool.query<{ completed_at: Date | null }>("SELECT completed_at FROM deletion_requests WHERE code = $1", [code]);
    res.set("Cache-Control", "no-store");
    if (!rows[0]) return res.status(404).type("html").send(page("Deletion request", "<p>No deletion request found for this code.</p>"));
    res
      .type("html")
      .send(page("Deletion request", rows[0].completed_at ? "<p>Your Instagram connection data has been deleted.</p>" : "<p>Your request is being processed.</p>"));
  })
);

function esc(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  const nav = `<nav><a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a> · <a href="/contact">Contact</a> · <a href="/">Open app</a></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - Reel Scheduler</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.6rem}nav{font-size:.9rem;margin-bottom:1.5rem}footer{margin-top:2.5rem;font-size:.85rem;color:#666}</style></head>
<body>${nav}<h1>${title}</h1>${body}<footer>Reel Scheduler uses the official Instagram API (Instagram API with Instagram Login). It is not affiliated with or endorsed by Meta or Instagram.</footer></body></html>`;
}

// Public contact address shown on every policy page. Set SUPPORT_EMAIL in the hosting environment (Meta checks that it works).
const SUPPORT = esc(process.env.SUPPORT_EMAIL || "");
if (!SUPPORT) console.warn("WARNING: SUPPORT_EMAIL is not set. Meta requires a working contact address on the privacy policy page.");
const contactLine = SUPPORT ? `<a href="mailto:${SUPPORT}">${SUPPORT}</a>` : "(contact address not configured)";
const UPDATED = "28 October 2026";

pagesRouter.get("/about", (_req, res) => {
  res.type("html").send(
    page(
      "About Reel Scheduler",
      `<p>Reel Scheduler is a tool for Instagram <b>Business and Creator (professional) accounts</b>. The account owner uploads their own videos, chooses a posting plan, and the app publishes those Reels to the connected account at the chosen times.</p>
<h2>How it works</h2>
<ol><li>Create an account and press <b>Connect Instagram</b>. You sign in on Instagram's own login screen; we never see or store your Instagram password.</li>
<li>Allow the two permissions requested (below).</li>
<li>Add your videos, an optional caption and cover image, and choose posting times.</li>
<li>The app publishes your Reels through the official Instagram API. You can disconnect at any time.</li></ol>
<h2>Permissions used</h2>
<ul><li><b>instagram_business_basic</b>: shows which account is connected (ID and username).</li>
<li><b>instagram_business_content_publish</b>: publishes the Reels that you scheduled.</li></ul>
<p>We do not read messages or comments, do not follow, like or comment for you, and do not collect data about your followers.</p>
<h2>Built-in limits</h2>
<p>To follow Instagram's rules the app caps posts per account per day, never posts the same video twice on a day, spaces posts out, and stops when Instagram reports a rate limit.</p>
<h2>Contact</h2><p>${contactLine}</p>`
    )
  );
});

pagesRouter.get("/privacy", (_req, res) => {
  res.type("html").send(
    page(
      "Privacy Policy",
      `<p><i>Last updated: ${UPDATED}</i></p>
<p>Reel Scheduler lets you schedule Reels on Instagram professional accounts that you own and connect yourself.</p>
<h2>What we collect</h2>
<p>Your email address and a hashed password for logging in; your Instagram professional account ID and username; an encrypted Instagram access token; and the videos, captions and cover image you add for scheduling, together with the status of each scheduled post. We never receive your Instagram password.</p>
<h2>How we use it</h2>
<p>Only to publish the content you scheduled to the Instagram account you connected, and to operate and secure the service. We do not sell your data, do not share it with third parties for their own purposes, and do not use it for advertising or profiling.</p>
<h2>Service providers</h2>
<p>Your videos and data are processed by the hosting, database and media-storage providers needed to run the service, only on our instructions. Instagram (Meta) receives the content you schedule in order to publish it.</p>
<h2>Instagram permissions</h2>
<p>We request <b>instagram_business_basic</b> (to identify your account) and <b>instagram_business_content_publish</b> (to publish the Reels you schedule). Nothing else.</p>
<h2>Retention</h2>
<p>Access tokens and scheduled posts are kept while your account is connected. Finished and failed post records are removed automatically after 60 days. Disconnecting an account deletes its token and its scheduled posts immediately.</p>
<h2>Deleting your data</h2>
<p>Disconnect the account inside the app, or remove the app in Instagram (Settings &gt; Apps and websites); both delete your stored token and scheduled posts automatically. Full instructions are on the <a href="/data-deletion">data deletion page</a>. You can also email ${contactLine}.</p>
<h2>Security</h2><p>Tokens are encrypted at rest, passwords are hashed, and all traffic uses HTTPS.</p>
<h2>Children</h2><p>The service is not intended for people under 18.</p>
<h2>Contact</h2><p>${contactLine}</p>`
    )
  );
});

pagesRouter.get("/terms", (_req, res) => {
  res.type("html").send(
    page(
      "Terms of Service",
      `<p><i>Last updated: ${UPDATED}</i></p>
<p>By using Reel Scheduler you confirm that you own or are authorised to manage every Instagram account you connect.</p>
<h2>Acceptable use</h2>
<p>You must follow Instagram's Terms of Use, Community Guidelines and the Meta Platform Terms. Spam, repetitive or duplicate content posted to inflate reach, content you do not have rights to, and automated engagement (likes, follows, comments, messages) are not allowed. We may disconnect accounts or suspend access that breaks these rules.</p>
<h2>Limits</h2><p>Publishing is limited per account per day to stay within Instagram's limits. Posts may be delayed or skipped if Instagram throttles or rejects them.</p>
<h2>Your content</h2><p>You keep all rights to your videos. You are responsible for having the rights to everything you schedule.</p>
<h2>No warranty</h2><p>The service is provided as is. Instagram may change or limit its API at any time.</p>
<h2>Contact</h2><p>${contactLine}</p>`
    )
  );
});

pagesRouter.get("/data-deletion", (_req, res) => {
  res.type("html").send(
    page(
      "Data Deletion Instructions",
      `<p>You can delete the data Reel Scheduler holds about your Instagram account at any time, in either of two ways. Both are processed automatically.</p>
<h2>Option 1: inside the app</h2>
<p>Log in, open the Instagram section and press <b>Disconnect</b> next to the account. Its access token and all of its scheduled and past post records are deleted immediately.</p>
<h2>Option 2: from Instagram</h2>
<ol><li>Open Instagram: <b>Settings &gt; Apps and websites</b> (or Website permissions).</li><li>Find <b>Reel Scheduler</b> and press <b>Remove</b>.</li></ol>
<p>Instagram then notifies us and we delete the stored token and posts for that account. You receive a confirmation code, and the status can be checked at <code>/api/meta/data-deletion-status?code=YOUR_CODE</code>.</p>
<h2>Delete everything, including your login</h2>
<p>To also delete your email and login, email ${contactLine} from the address you registered with. We will confirm deletion.</p>`
    )
  );
});

pagesRouter.get("/contact", (_req, res) => {
  res.type("html").send(page("Contact", `<p>Questions, support or data requests: ${contactLine}</p>`));
});
