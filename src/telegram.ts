import { request, FormData } from "undici";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { log, err } from "./log.js";

const TOKEN = process.env.TG_TOKEN || "";
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  err("telegram", "TG_TOKEN not set");
}

export interface SendOpts {
  chatId: string;
  threadId?: string;
  text?: string;
  parseMode?: "MarkdownV2" | "HTML" | "Markdown";
  disableNotification?: boolean;
}

async function postSend(body: Record<string, unknown>): Promise<{ ok: boolean; description?: string; result?: { message_id: number } }> {
  const res = await request(`${API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.body.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
}

/**
 * Send a message and return the resulting message_id (or null on failure).
 * Used when caller needs to delete the message later (e.g. /watch_digest
 * auto-cleanup after 60s).
 */
export async function sendMessageReturningId(opts: SendOpts): Promise<number | null> {
  if (!TOKEN) return null;
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text || "",
    disable_web_page_preview: true,
  };
  if (opts.threadId) body.message_thread_id = Number(opts.threadId);
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.disableNotification) body.disable_notification = true;
  try {
    let data = await postSend(body);
    if (!data.ok) {
      const desc = data.description || "";
      if (opts.parseMode && /can't parse|entities/i.test(desc)) {
        const { parse_mode: _pm, ...plain } = body;
        void _pm;
        data = await postSend(plain);
      }
    }
    if (!data.ok) {
      err("telegram", `sendMessageReturningId failed: ${data.description}`);
      return null;
    }
    return data.result?.message_id ?? null;
  } catch (e) {
    err("telegram", "sendMessageReturningId exception", e);
    return null;
  }
}

/**
 * Delete a message by id. Bot must have rights (own messages always OK;
 * other users' messages require admin + "Can Delete Messages" perm in
 * supergroup). Logs but does not throw on failure.
 */
export async function deleteMessage(chatId: string, messageId: number): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const res = await request(`${API}/deleteMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    const data = (await res.body.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      log("telegram", `deleteMessage ${messageId} skipped: ${data.description}`);
      return false;
    }
    return true;
  } catch (e) {
    err("telegram", "deleteMessage exception", e);
    return false;
  }
}

export async function sendMessage(opts: SendOpts): Promise<boolean> {
  if (!TOKEN) return false;
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text || "",
    disable_web_page_preview: true,
  };
  if (opts.threadId) body.message_thread_id = Number(opts.threadId);
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.disableNotification) body.disable_notification = true;

  try {
    let data = await postSend(body);
    if (!data.ok) {
      // Parse-mode failure (unbalanced `_` `*` `[` `` ` `` in user data we
      // didn't escape) returns "can't parse entities". Retry once without
      // parse_mode — better to send raw than silently drop the alert.
      const desc = data.description || "";
      if (opts.parseMode && /can't parse|entities/i.test(desc)) {
        err("telegram", `markdown parse failed; retrying as plain: ${desc}`);
        const { parse_mode: _pm, ...plain } = body;
        void _pm;
        data = await postSend(plain);
      }
      if (!data.ok) {
        err("telegram", `sendMessage failed: ${data.description}`);
        return false;
      }
    }
    return true;
  } catch (e) {
    err("telegram", "sendMessage exception", e);
    return false;
  }
}

export async function sendDocument(opts: {
  chatId: string;
  threadId?: string;
  filePath: string;
  caption?: string;
}): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const buf = readFileSync(opts.filePath);
    const fd = new FormData();
    fd.append("chat_id", opts.chatId);
    if (opts.threadId) fd.append("message_thread_id", opts.threadId);
    if (opts.caption) fd.append("caption", opts.caption);
    fd.append(
      "document",
      new Blob([new Uint8Array(buf)], { type: "text/csv" }),
      basename(opts.filePath),
    );

    const res = await request(`${API}/sendDocument`, {
      method: "POST",
      body: fd,
    });
    const data = (await res.body.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      err("telegram", `sendDocument failed: ${data.description}`);
      return false;
    }
    log("telegram", `sent ${basename(opts.filePath)}`);
    return true;
  } catch (e) {
    err("telegram", "sendDocument exception", e);
    return false;
  }
}

/**
 * Register the bot's command list via setMyCommands. Telegram caches
 * this per-bot scope=default; calls are idempotent. Call once at
 * tg-control startup so the command menu syncs after every deploy.
 *
 * `command` must be lowercase + digits + underscore, max 32 chars.
 * `description` 1-256 chars.
 */
export async function setMyCommands(
  commands: { command: string; description: string }[],
): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const res = await request(`${API}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    const data = (await res.body.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      err("telegram", `setMyCommands failed: ${data.description}`);
      return false;
    }
    log("telegram", `setMyCommands: registered ${commands.length} commands`);
    return true;
  } catch (e) {
    err("telegram", "setMyCommands exception", e);
    return false;
  }
}

export async function notifyErrors(text: string): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_ERRORS;
  if (!chat) return;
  await sendMessage({ chatId: chat, threadId: thread || undefined, text });
}
