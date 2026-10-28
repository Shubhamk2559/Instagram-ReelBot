import { env } from "../config/env";
import { pool } from "../db/pool";
import { sha256 } from "./security";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;
export const MAX_TG_BYTES = 20 * 1024 * 1024; // Telegram bots can download files up to 20 MB
export const telegramEnabled = TOKEN.length > 0;

// Code the user sends to the bot (/start CODE) to link their Telegram chat to their account.
export const pairCode = (userId: string) => sha256(`${userId}:${env.TOKEN_ENCRYPTION_KEY}`).slice(0, 8);

async function tg<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const d = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!r.ok || !d.ok) throw new Error(d.description ?? `Telegram error ${r.status}`);
  return d.result as T;
}

let botUser: string | null = null;
export async function botUsername(): Promise<string | null> {
  if (!telegramEnabled) return null;
  if (!botUser) {
    const me = await tg<{ username?: string }>("getMe").catch(() => ({}) as { username?: string });
    botUser = me.username ?? null;
  }
  return botUser;
}

export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const f = await tg<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!f.file_path) throw new Error("Telegram file not found");
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error(`Telegram download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

type TgFile = { file_id: string; file_unique_id: string; file_size?: number; mime_type?: string };
type Update = {
  update_id: number;
  message?: { chat: { id: number }; text?: string; video?: TgFile; document?: TgFile };
};

let capFn: () => number = () => 50;
let offset = 0;
let polling = false;

async function reply(chatId: number, text: string) {
  await tg("sendMessage", { chat_id: chatId, text }).catch(() => {});
}

async function handle(u: Update) {
  const m = u.message;
  if (!m) return;
  const chat = m.chat.id;

  if (m.text) {
    const match = /^\/start(?:\s+(\w+))?/.exec(m.text.trim());
    if (!match) return;
    if (!match[1]) return reply(chat, "App mein Telegram section ka code dikhega. Ye bhejo: /start CODE");
    const users = await pool.query<{ id: string }>("SELECT id FROM users");
    const owner = users.rows.find((x) => pairCode(x.id) === match[1].toLowerCase());
    if (!owner) return reply(chat, "Code galat hai.");
    await pool.query(
      "INSERT INTO telegram_links (chat_id, user_id) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET user_id = EXCLUDED.user_id",
      [chat, owner.id]
    );
    return reply(chat, "Linked. Ab videos yahan bhejo.");
  }

  const file = m.video ?? (m.document?.mime_type?.startsWith("video/") ? m.document : undefined);
  if (!file) return;
  const link = await pool.query<{ user_id: string }>("SELECT user_id FROM telegram_links WHERE chat_id = $1", [chat]);
  if (!link.rows[0]) return reply(chat, "Pehle app ka code bhejo: /start CODE");
  if ((file.file_size ?? 0) > MAX_TG_BYTES) return reply(chat, "Video 20 MB se badi hai, skip ki.");

  const uid = link.rows[0].user_id;
  const cap = capFn();
  const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM library WHERE user_id = $1", [uid]);
  if (count.rows[0].n >= cap) return reply(chat, `Library full hai (max ${cap}).`);

  const ins = await pool.query(
    `INSERT INTO library (user_id, tg_file_id, tg_unique_id, tg_size) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, tg_unique_id) DO NOTHING RETURNING id`,
    [uid, file.file_id, file.file_unique_id, file.file_size ?? null]
  );
  await reply(chat, ins.rows[0] ? `Added ${count.rows[0].n + 1} / ${cap}` : "Ye video pehle se library mein hai.");
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const updates = await tg<Update[]>("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] });
    for (const u of updates) {
      offset = u.update_id + 1;
      await handle(u).catch((e) => console.error("Telegram handler error:", (e as Error).message));
    }
  } catch (e) {
    console.error("Telegram poll error:", (e as Error).message);
  } finally {
    polling = false;
  }
}

export function startTelegram(cap: () => number): void {
  if (!telegramEnabled) {
    console.log("Telegram disabled (TELEGRAM_BOT_TOKEN not set)");
    return;
  }
  capFn = cap;
  setInterval(poll, 5_000);
  console.log("Telegram bot polling started");
}
