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

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.6rem}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

const SUPPORT = process.env.SUPPORT_EMAIL || "support@example.com"; // set SUPPORT_EMAIL in Koyeb

pagesRouter.get("/privacy", (_req, res) => {
  res.type("html").send(
    page(
      "Privacy Policy",
      `<p>Reel Scheduler lets you schedule Reels on Instagram professional accounts that you own and connect yourself.</p>
<h2>What we collect</h2>
<p>Your email address, a hashed password, your Instagram professional account ID and username, an encrypted Instagram access token, and the videos, captions and cover image you add for scheduling.</p>
<h2>How we use it</h2>
<p>Only to publish the content you scheduled to the Instagram account you connected. We do not sell or share your data and do not use it for advertising.</p>
<h2>Instagram permissions</h2>
<p>We request <b>instagram_business_basic</b> (to identify your account) and <b>instagram_business_content_publish</b> (to publish the Reels you schedule). Nothing else.</p>
<h2>Deleting your data</h2>
<p>Disconnect the account inside the app, or remove the app in Instagram (Settings &gt; Apps and websites). Both delete your stored token and scheduled posts. You can also email ${SUPPORT}.</p>
<h2>Contact</h2><p>${SUPPORT}</p>`
    )
  );
});

pagesRouter.get("/terms", (_req, res) => {
  res.type("html").send(
    page(
      "Terms of Service",
      `<p>By using Reel Scheduler you confirm that you own or are authorised to manage every Instagram account you connect.</p>
<h2>Acceptable use</h2>
<p>You must follow Instagram's Terms of Use, Community Guidelines and the Meta Platform Terms. Spam, repetitive or duplicate content posted to inflate reach, content you do not have rights to, and automated engagement are not allowed. We may disconnect accounts or suspend access that breaks these rules.</p>
<h2>Limits</h2><p>Publishing is limited per account per day to stay within Instagram's limits.</p>
<h2>No warranty</h2><p>The service is provided as is. Instagram may change or limit its API at any time.</p>
<h2>Contact</h2><p>${SUPPORT}</p>`
    )
  );
});
