import { env } from "./config/env";
import { createApp } from "./app";
import { pool } from "./db/pool";
import { startPublisher } from "./lib/publisher";

const server = createApp().listen(env.PORT, "0.0.0.0", () => {
  console.log(`Server listening on :${env.PORT} (${env.NODE_ENV})`);
});

const stopPublisher = startPublisher();

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  stopPublisher();
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
