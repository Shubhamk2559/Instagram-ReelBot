import path from "path";
import fs from "fs";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { pool } from "./db/pool";
import { sha256 } from "./lib/security";
import { downloadTelegramFile } from "./lib/telegram";
import { healthRouter } from "./routes/health";
import { authRouter, originGuard } from "./routes/auth";
import { instagramRouter } from "./routes/instagram";
import { metaRouter, pagesRouter } from "./routes/meta";
import { reelsRouter } from "./routes/reels";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind Koyeb's proxy
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "img-src": ["'self'", "data:"],
        },
      },
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "20kb" })); // Meta callbacks send signed_request as form data

  app.use("/api", originGuard);
  app.use("/api", healthRouter);

  // Public link Instagram uses to fetch the fixed cover image (token is unguessable).
  app.get("/api/public/cover/:file", async (req, res, next) => {
    try {
      const token = req.params.file.replace(/\.jpe?g$/i, "");
      const { rows } = await pool.query<{ cover_data: Buffer | null }>(
        "SELECT cover_data FROM queue_settings WHERE cover_token = $1",
        [token]
      );
      if (!rows[0]?.cover_data) return res.status(404).end();
      res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" });
      res.send(rows[0].cover_data);
    } catch (err) {
      next(err);
    }
  });

  // Public link Instagram uses to fetch a video. We pull it from Telegram and pass it on.
  app.get("/api/public/video/:id/:file", async (req, res, next) => {
    try {
      const id = req.params.id;
      const sig = req.params.file.replace(/\.mp4$/i, "");
      const ok = /^[0-9a-f-]{36}$/i.test(id) && sig === sha256(`video:${id}:${env.TOKEN_ENCRYPTION_KEY}`).slice(0, 32);
      if (!ok) return res.status(404).end();
      const { rows } = await pool.query<{ tg_file_id: string | null }>(
        "SELECT tg_file_id FROM reels WHERE id = $1",
        [id]
      );
      if (!rows[0]?.tg_file_id) return res.status(404).end();
      const bytes = await downloadTelegramFile(rows[0].tg_file_id);
      res.set({ "Content-Type": "video/mp4", "Content-Length": String(bytes.length) });
      res.end(bytes);
    } catch (err) {
      next(err);
    }
  });

  app.use("/api/meta", metaRouter); // deauthorize + data deletion callbacks (signature-verified, no login)
  app.use(pagesRouter); // /privacy and /terms (required by Meta to go Live)
  app.use("/api/auth", authRouter);
  app.use("/api/instagram", instagramRouter);
  app.use("/api/reels", reelsRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // Serve the built frontend (same origin as the API).
  const webDist = path.resolve(__dirname, "../../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
