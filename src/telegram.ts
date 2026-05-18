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
    const res = await request(`${API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.body.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      err("telegram", `sendMessage failed: ${data.description}`);
      return false;
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

export async function notifyErrors(text: string): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_ERRORS;
  if (!chat) return;
  await sendMessage({ chatId: chat, threadId: thread || undefined, text });
}
