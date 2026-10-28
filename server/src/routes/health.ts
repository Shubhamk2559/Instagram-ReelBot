import { Router } from "express";
import { pool } from "../db/pool";

export const healthRouter = Router();

// Liveness: process is up. Used as the Koyeb health check.
healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness: process can reach the database.
healthRouter.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "up" });
  } catch {
    res.status(503).json({ status: "error", database: "down" });
  }
});
