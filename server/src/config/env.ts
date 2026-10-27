import path from "path";
import dotenv from "dotenv";
import { z } from "zod";

// Load .env from repo root in local dev; in production real env vars are used.
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// Koyeb values are often pasted with stray spaces or quotes; Instagram then rejects the app as "Invalid platform app".
const clean = (v: string) => v.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
const cleaned = (msg: string) => z.string().transform(clean).pipe(z.string().min(1, msg));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  APP_BASE_URL: z
    .string()
    .transform(clean)
    .pipe(z.string().url())
    .transform((v) => v.replace(/\/+$/, ""))
    .default("http://localhost:8000"),
  INSTAGRAM_APP_ID: cleaned("INSTAGRAM_APP_ID is required"),
  INSTAGRAM_APP_SECRET: cleaned("INSTAGRAM_APP_SECRET is required"),
  TOKEN_ENCRYPTION_KEY: z.string().min(32, "TOKEN_ENCRYPTION_KEY must be at least 32 characters"),
  // Instagram Graph API version. v21.0 is retired by Meta on 2027-01-21; v25.0 is supported until 2028.
  // Set IG_API_VERSION=v21.0 in Koyeb to roll back instantly if ever needed.
  IG_API_VERSION: z.string().regex(/^v\d+\.\d+$/, "IG_API_VERSION must look like v25.0").default("v25.0"),
  CLOUDINARY_CLOUD_NAME: z.string().min(1, "CLOUDINARY_CLOUD_NAME is required"),
  CLOUDINARY_API_KEY: z.string().min(1, "CLOUDINARY_API_KEY is required"),
  CLOUDINARY_API_SECRET: z.string().min(1, "CLOUDINARY_API_SECRET is required"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

if (env.NODE_ENV === "production" && /localhost|127\.0\.0\.1/.test(env.APP_BASE_URL)) {
  console.warn("WARNING: APP_BASE_URL points to localhost. Set it to your public Koyeb URL, or Instagram login will fail.");
}
