import { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { hashPassword, newToken, sha256, verifyPassword } from "../lib/security";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
    }
  }
}

const COOKIE = "sid";
const SESSION_DAYS = 30;
const isProd = env.NODE_ENV === "production";
const cookieOpts = { httpOnly: true, secure: isProd, sameSite: "lax" as const, path: "/" };

// Wraps async handlers so errors reach the Express error handler.
export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

// Blocks cross-site state-changing requests.
export function originGuard(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !isProd) return next();
  const origin = req.headers.origin;
  if (origin && origin !== new URL(env.APP_BASE_URL).origin) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// Simple in-memory limiter (per instance) for login/signup.
const hits = new Map<string, { count: number; reset: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset < now) {
    hits.set(key, { count: 1, reset: now + 15 * 60_000 });
    return next();
  }
  if (++entry.count > 10) return res.status(429).json({ error: "Too many attempts. Try again later." });
  next();
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const token = getCookie(req, COOKIE);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  pool
    .query<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)]
    )
    .then(({ rows }) => {
      if (!rows[0]) return res.status(401).json({ error: "Not authenticated" });
      req.user = rows[0];
      next();
    })
    .catch(next);
};

async function startSession(res: Response, userId: string) {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [userId, sha256(token), String(SESSION_DAYS)]
  );
  res.cookie(COOKIE, token, { ...cookieOpts, maxAge: SESSION_DAYS * 86_400_000 });
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

export const authRouter = Router();

authRouter.post("/signup", rateLimit, wrap(async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, password } = parsed.data;
  try {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, await hashPassword(password)]
    );
    await startSession(res, rows[0].id);
    res.status(201).json({ user: { id: rows[0].id, email } });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    throw err;
  }
}));

authRouter.post("/login", rateLimit, wrap(async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid email or password" });
  const { email, password } = parsed.data;
  const { rows } = await pool.query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE lower(email) = $1",
    [email]
  );
  const user = rows[0];
  // Always run a hash comparison so timing doesn't reveal if the email exists.
  const ok = await verifyPassword(password, user?.password_hash ?? "scrypt$00$00");
  if (!user || !ok) return res.status(401).json({ error: "Invalid email or password" });
  await startSession(res, user.id);
  res.json({ user: { id: user.id, email } });
}));

authRouter.post("/logout", wrap(async (req, res) => {
  const token = getCookie(req, COOKIE);
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
}));

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});
