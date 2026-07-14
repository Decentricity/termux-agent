#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const stateDir = process.env.TERMUX_AGENT_STATE_DIR || process.env.TELEGRAM_CODEX_STATE_DIR || path.join(os.homedir(), ".termux-agent");
const tokenPath = path.join(stateDir, "token");
const messagesPath = path.join(stateDir, "messages.jsonl");
const seenPath = path.join(stateDir, "seen.json");
const metaPath = path.join(stateDir, "meta.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const allowedUpdates = ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query", "my_chat_member", "chat_member"];

function usage() {
  return `tg-codex - minimal Telegram Bot API CLI for Codex

Usage:
  tg-codex save-token --token <bot-token>
  tg-codex status
  tg-codex sync [--seconds 30]
  tg-codex daemon [--verbose]
  tg-codex check [--seconds 20] [--limit 25] [--since-minutes 1440] [--chat-id <id>]
  tg-codex recent [--limit 25] [--since-minutes 1440] [--chat-id <id>]
  tg-codex chats [--all] [--since-minutes 10080]
  tg-codex send --chat-id <id> --text <message> [--reply-to-message-id <id>]
  tg-codex delete-webhook [--drop-pending]

Notes:
  Bot API polling only sees messages delivered to the bot.
  Do not delete an existing webhook unless you intend this CLI to own polling.
`;
}

function getArg(name, fallback = undefined) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function ensureState() {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(stateDir, 0o700);
  } catch {
    // Ignore chmod failures on storage layers that do not support POSIX modes.
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function validateToken(token) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error("Telegram bot token does not look valid.");
  }
}

async function saveToken() {
  await ensureState();
  const token = getArg("--token", "").trim();
  validateToken(token);
  await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  try {
    await fs.chmod(tokenPath, 0o600);
  } catch {
    // Ignore chmod failures on storage layers that do not support POSIX modes.
  }
  console.log(`Saved Telegram bot token to ${tokenPath}`);
}

async function readToken() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || (await fs.readFile(tokenPath, "utf8"))).trim();
  validateToken(token);
  return token;
}

async function api(method, payload = {}, options = {}) {
  const token = await readToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram API ${method} failed with HTTP ${res.status}`);
  }
  return body.result;
}

function messageText(msg) {
  if (!msg) return "";
  return (
    msg.text ||
    msg.caption ||
    msg.sticker?.emoji ||
    msg.poll?.question ||
    msg.location && "[location]" ||
    msg.contact && `[contact ${msg.contact.phone_number || ""}]` ||
    msg.photo && "[photo]" ||
    msg.video && "[video]" ||
    msg.voice && "[voice]" ||
    msg.audio && "[audio]" ||
    msg.document && `[document ${msg.document.file_name || ""}]` ||
    msg.animation && "[animation]" ||
    msg.video_note && "[video_note]" ||
    ""
  );
}

function contentType(msg) {
  if (!msg) return "unknown";
  for (const key of ["text", "photo", "video", "voice", "audio", "document", "sticker", "location", "contact", "poll", "animation", "video_note"]) {
    if (msg[key]) return key;
  }
  return "message";
}

function senderName(user = {}) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id || "unknown");
}

function chatLabel(chat = {}) {
  return chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id || "");
}

function summarizeMemberUpdate(update, kind) {
  const memberUpdate = update[kind] || {};
  const chat = memberUpdate.chat || {};
  const from = memberUpdate.from || {};
  const timestamp = memberUpdate.date || Math.floor(Date.now() / 1000);
  const oldStatus = memberUpdate.old_chat_member?.status || "unknown";
  const newStatus = memberUpdate.new_chat_member?.status || "unknown";
  const changedUser = memberUpdate.new_chat_member?.user || memberUpdate.old_chat_member?.user || {};
  return {
    updateId: update.update_id,
    kind,
    timestamp,
    isoTime: new Date(timestamp * 1000).toISOString(),
    chatId: chat.id,
    chatType: chat.type || "",
    chatLabel: chatLabel(chat),
    fromId: from.id,
    fromUsername: from.username || "",
    fromName: senderName(from),
    targetId: changedUser.id,
    targetUsername: changedUser.username || "",
    targetName: senderName(changedUser),
    type: kind,
    text: `${oldStatus}->${newStatus}`,
    summary: `[${kind} ${oldStatus}->${newStatus} ${senderName(changedUser)}]`
  };
}

function summarizeUpdate(update) {
  const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
  if (msg) {
    const chat = msg.chat || {};
    const from = msg.from || msg.sender_chat || {};
    const timestamp = msg.date || Math.floor(Date.now() / 1000);
    const text = messageText(msg);
    return {
      updateId: update.update_id,
      kind: update.edited_message || update.edited_channel_post ? "edited_message" : "message",
      timestamp,
      isoTime: new Date(timestamp * 1000).toISOString(),
      chatId: chat.id,
      chatType: chat.type || "",
      chatLabel: chatLabel(chat),
      messageId: msg.message_id,
      fromId: from.id,
      fromUsername: from.username || "",
      fromName: senderName(from),
      type: contentType(msg),
      text,
      summary: text || `[${contentType(msg)}]`
    };
  }
  if (update.callback_query) {
    const cq = update.callback_query;
    const chat = cq.message?.chat || {};
    const from = cq.from || {};
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      updateId: update.update_id,
      kind: "callback_query",
      timestamp,
      isoTime: new Date(timestamp * 1000).toISOString(),
      chatId: chat.id,
      chatType: chat.type || "",
      chatLabel: chat.title || chat.username || String(chat.id || ""),
      messageId: cq.message?.message_id,
      fromId: from.id,
      fromUsername: from.username || "",
      fromName: senderName(from),
      type: "callback_query",
      text: cq.data || "",
      summary: cq.data || "[callback_query]"
    };
  }
  if (update.my_chat_member) return summarizeMemberUpdate(update, "my_chat_member");
  if (update.chat_member) return summarizeMemberUpdate(update, "chat_member");
  return {
    updateId: update.update_id,
    kind: "unknown",
    timestamp: Math.floor(Date.now() / 1000),
    isoTime: new Date().toISOString(),
    summary: "[unknown update]"
  };
}

async function appendUpdates(updates) {
  const seen = await readJson(seenPath, { ids: [] });
  const seenSet = new Set(seen.ids || []);
  const rows = [];
  for (const update of updates) {
    if (seenSet.has(update.update_id)) continue;
    seenSet.add(update.update_id);
    rows.push(summarizeUpdate(update));
  }
  if (rows.length) {
    await fs.appendFile(messagesPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    await writeJson(seenPath, { ids: Array.from(seenSet).slice(-5000) });
  }
  return rows;
}

async function syncUpdates({ print = false } = {}) {
  await ensureState();
  const seconds = Number(getArg("--seconds", print ? "20" : "30"));
  const started = Date.now();
  const deadline = started + Math.max(1, seconds) * 1000;
  const meta = await readJson(metaPath, {});
  let offset = Number(meta.offset || 0) || undefined;
  let cached = 0;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const timeout = Math.min(25, remaining);
    const updates = await api("getUpdates", {
      ...(offset ? { offset } : {}),
      timeout,
      allowed_updates: allowedUpdates
    });
    if (updates.length) {
      const rows = await appendUpdates(updates);
      cached += rows.length;
      offset = Math.max(...updates.map((update) => update.update_id)) + 1;
      await writeJson(metaPath, { ...meta, offset, lastSyncAt: new Date().toISOString() });
      if (print) {
        for (const row of rows) console.error(`cached ${formatRow(row)}`);
      }
    } else {
      await sleep(250);
    }
  }
  if (print) console.log(`Synced Telegram updates for ${seconds}s; cached ${cached} new update(s).`);
}

async function assertPollingAvailable() {
  const webhook = await api("getWebhookInfo");
  if (webhook.url) {
    throw new Error(`Telegram webhook is set (${webhook.url}); delete it only with explicit user approval before polling.`);
  }
}

async function daemon() {
  await ensureState();
  await assertPollingAvailable();
  let stopping = false;
  let backoffMs = 1000;
  let activeController = null;
  const stop = () => {
    stopping = true;
    activeController?.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`[${new Date().toISOString()}] tg-codex daemon started`);
  while (!stopping) {
    try {
      const meta = await readJson(metaPath, {});
      const offset = Number(meta.offset || 0) || undefined;
      activeController = new AbortController();
      const updates = await api("getUpdates", {
        ...(offset ? { offset } : {}),
        timeout: 15,
        allowed_updates: allowedUpdates
      }, { signal: activeController.signal });
      activeController = null;
      const nextOffset = updates.length ? Math.max(...updates.map((update) => update.update_id)) + 1 : offset;
      if (updates.length) {
        const rows = await appendUpdates(updates);
        await writeJson(metaPath, {
          ...meta,
          ...(nextOffset ? { offset: nextOffset } : {}),
          lastSyncAt: new Date().toISOString(),
          lastDaemonAt: new Date().toISOString()
        });
        console.log(`[${new Date().toISOString()}] cached ${rows.length} update(s); offset=${nextOffset}`);
        if (hasArg("--verbose")) {
          for (const row of rows) console.log(formatRow(row));
        }
      } else {
        await writeJson(metaPath, {
          ...meta,
          ...(nextOffset ? { offset: nextOffset } : {}),
          lastDaemonAt: new Date().toISOString()
        });
      }
      backoffMs = 1000;
    } catch (err) {
      activeController = null;
      if (stopping && err?.name === "AbortError") break;
      console.error(`[${new Date().toISOString()}] poll error: ${err?.message || err}`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60000);
    }
  }
  console.log(`[${new Date().toISOString()}] tg-codex daemon stopped`);
}

function requestedChatId() {
  const chatId = getArg("--chat-id", "");
  return chatId ? String(chatId) : "";
}

async function recentRows({ limit, sinceMinutes, chatId = "" }) {
  let content = "";
  try {
    content = await fs.readFile(messagesPath, "utf8");
  } catch {
    return [];
  }
  const cutoff = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
  const rows = [];
  for (const line of content.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (chatId && String(row.chatId) !== chatId) continue;
      if (row.timestamp >= cutoff) rows.push(row);
    } catch {
      // Ignore malformed cache rows.
    }
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows.slice(-limit);
}

function formatRow(row) {
  const chat = row.chatLabel ? `${row.chatLabel} (${row.chatId})` : row.chatId;
  const from = row.fromUsername ? `@${row.fromUsername}` : row.fromName || row.fromId || "unknown";
  const ids = hasArg("--ids") && row.messageId ? ` msg=${row.messageId}` : "";
  return `[${row.isoTime}]${ids} ${from} @ ${chat}: ${row.summary}`;
}

async function printRecent() {
  const limit = Number(getArg("--limit", "25"));
  const sinceMinutes = Number(getArg("--since-minutes", "1440"));
  const chatId = requestedChatId();
  const rows = await recentRows({ limit, sinceMinutes, chatId });
  if (!rows.length) {
    console.log(`No cached Telegram updates${chatId ? ` for chat ${chatId}` : ""} in the last ${sinceMinutes} minutes.`);
    return;
  }
  for (const row of rows) console.log(formatRow(row));
}

async function listChats() {
  const sinceMinutes = Number(getArg("--since-minutes", "10080"));
  const rows = await recentRows({ limit: 10000, sinceMinutes });
  const includeAll = hasArg("--all");
  const chats = new Map();
  for (const row of rows) {
    if (row.chatId == null) continue;
    if (!includeAll && !["group", "supergroup", "channel"].includes(row.chatType)) continue;
    const existing = chats.get(String(row.chatId)) || {
      chatId: row.chatId,
      chatType: row.chatType || "",
      chatLabel: row.chatLabel || "",
      latestTimestamp: 0,
      latestIso: "",
      kinds: new Set()
    };
    if (row.timestamp >= existing.latestTimestamp) {
      existing.latestTimestamp = row.timestamp;
      existing.latestIso = row.isoTime;
      existing.chatType = row.chatType || existing.chatType;
      existing.chatLabel = row.chatLabel || existing.chatLabel;
    }
    existing.kinds.add(row.kind || row.type || "update");
    chats.set(String(row.chatId), existing);
  }
  const list = Array.from(chats.values()).sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  if (!list.length) {
    console.log(includeAll ? "No cached Telegram chats." : "No cached Telegram group/channel chats.");
    console.log("Telegram Bot API cannot list every group a bot belongs to; it only exposes chats that produce bot-visible updates.");
    return;
  }
  for (const chat of list) {
    console.log(`${chat.chatId}\t${chat.chatType || "unknown"}\t${chat.chatLabel || "(no title)"}\tlatest=${chat.latestIso}\tsources=${Array.from(chat.kinds).sort().join(",")}`);
  }
}

async function status() {
  await ensureState();
  const me = await api("getMe");
  const webhook = await api("getWebhookInfo");
  const meta = await readJson(metaPath, {});
  const rows = await recentRows({ limit: 1, sinceMinutes: 60 * 24 * 365 });
  console.log(`stateDir=${stateDir}`);
  console.log(`bot=@${me.username || ""} id=${me.id}`);
  if ("can_join_groups" in me) console.log(`canJoinGroups=${me.can_join_groups}`);
  if ("can_read_all_group_messages" in me) console.log(`canReadAllGroupMessages=${me.can_read_all_group_messages}`);
  if ("supports_inline_queries" in me) console.log(`supportsInlineQueries=${me.supports_inline_queries}`);
  console.log(`token=${fsSync.existsSync(tokenPath) ? "saved" : "env-only"}`);
  console.log(`webhook=${webhook.url ? "set" : "none"}`);
  if (webhook.url) console.log(`webhookPendingUpdates=${webhook.pending_update_count || 0}`);
  console.log(`offset=${meta.offset || "none"}`);
  console.log(`cachedMessages=${fsSync.existsSync(messagesPath) ? "present" : "none"}`);
  if (rows[0]) console.log(`latest=${formatRow(rows[0])}`);
}

async function check() {
  await syncUpdates({ print: true });
  await printRecent();
}

async function sendMessage() {
  const chatId = getArg("--chat-id", "");
  const text = getArg("--text", "");
  if (!chatId || !text) throw new Error("send requires --chat-id and --text");
  const replyToMessageId = getArg("--reply-to-message-id", "");
  const result = await api("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId) } } : {})
  });
  console.log(`sent message_id=${result.message_id} chat_id=${result.chat.id}`);
}

async function deleteWebhook() {
  const result = await api("deleteWebhook", { drop_pending_updates: hasArg("--drop-pending") });
  console.log(`deleteWebhook=${result ? "ok" : "not-ok"}`);
}

async function main() {
  const command = process.argv[2] || "help";
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
  } else if (command === "save-token") {
    await saveToken();
  } else if (command === "status") {
    await status();
  } else if (command === "sync") {
    await syncUpdates({ print: true });
  } else if (command === "daemon") {
    await daemon();
  } else if (command === "check") {
    await check();
  } else if (command === "recent") {
    await printRecent();
  } else if (command === "chats") {
    await listChats();
  } else if (command === "send") {
    await sendMessage();
  } else if (command === "delete-webhook") {
    await deleteWebhook();
  } else {
    console.error(`Unknown command: ${command}\n`);
    console.error(usage());
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`Error: ${err?.message || String(err)}`);
  process.exitCode = 1;
});
