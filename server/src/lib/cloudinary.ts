import crypto from "crypto";
import { env } from "../config/env";

function sign(params: Record<string, string | number>): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + env.CLOUDINARY_API_SECRET).digest("hex");
}

// Lets the browser upload straight to Cloudinary without exposing our secret.
export function signUpload(folder: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    folder,
    signature: sign({ folder, timestamp }),
  };
}

// Best-effort cleanup of one asset.
export async function destroyAsset(publicId: string, resourceType: "video" | "image"): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: env.CLOUDINARY_API_KEY,
    signature: sign({ public_id: publicId, timestamp }),
  });
  await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/destroy`, {
    method: "POST",
    body,
  }).catch(() => {});
}

// Deletes EVERYTHING under a folder prefix (videos and images), including leftovers not in the database.
export async function destroyByPrefix(prefix: string): Promise<void> {
  const auth = Buffer.from(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`).toString("base64");
  for (const type of ["video", "image"] as const) {
    for (let i = 0; i < 10; i++) {
      const url = `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/${type}/upload?prefix=${encodeURIComponent(prefix)}`;
      const r = await fetch(url, { method: "DELETE", headers: { Authorization: `Basic ${auth}` } }).catch(() => null);
      if (!r || !r.ok) {
        console.error(`Cloudinary prefix delete (${type}) failed:`, r?.status);
        break;
      }
      const d = (await r.json().catch(() => ({}))) as { partial?: boolean };
      if (!d.partial) break;
    }
  }
}
