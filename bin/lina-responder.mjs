#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, execFile } from "node:child_process";

const homeDir = process.env.HOME || os.homedir();
const prefixDir = process.env.PREFIX || path.dirname(path.dirname(process.execPath));
const stateDir = process.env.TERMUX_AGENT_STATE_DIR || process.env.TELEGRAM_CODEX_STATE_DIR || path.join(os.homedir(), ".termux-agent");
const tokenPath = path.join(stateDir, "token");
const configPath = path.join(stateDir, "config.json");
const messagesPath = path.join(stateDir, "messages.jsonl");
const responderPath = path.join(stateDir, "lina-responder.json");
const mediaDir = path.join(stateDir, "media");
const responderLockPath = path.join(stateDir, "lina-responder.lock");
const defaultBotUsername = process.env.LINA_BOT_USERNAME || "LinaTalbot";
const defaultBotId = Number(process.env.LINA_BOT_ID || "5813078614");
const pollMs = Number(process.env.LINA_RESPONDER_POLL_MS || "4000");
const codexTimeoutMs = Number(process.env.LINA_CODEX_TIMEOUT_MS || "180000");
const maxContextRows = Number(process.env.LINA_CONTEXT_ROWS || "28");
const maxReplyChars = Number(process.env.LINA_MAX_REPLY_CHARS || "900");
const maxImageAttachments = Number(process.env.LINA_MAX_IMAGE_ATTACHMENTS || "4");
const lockPollMs = Number(process.env.LINA_LOCK_POLL_MS || "15000");
let ownsResponderLock = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const commandTimeoutMs = 3000;

function hasArg(name) {
  return process.argv.includes(name);
}

async function ensureState() {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
}

async function ensureMediaDir() {
  await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(mediaDir, 0o700);
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

function readLockPid(raw) {
  try {
    return Number(JSON.parse(raw).pid || 0);
  } catch {
    return Number(String(raw || "").trim().split(/\s+/)[0] || 0);
  }
}

function responderProcessAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    const cmdline = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("lina-responder.mjs");
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function tryAcquireResponderLock() {
  await ensureState();
  try {
    await fs.writeFile(responderLockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
      flag: "wx",
      mode: 0o600
    });
    ownsResponderLock = true;
    return true;
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }

  let raw = "";
  try {
    raw = await fs.readFile(responderLockPath, "utf8");
  } catch {
    return tryAcquireResponderLock();
  }
  const pid = readLockPid(raw);
  if (responderProcessAlive(pid)) return false;
  await fs.rm(responderLockPath, { force: true });
  return tryAcquireResponderLock();
}

async function acquireResponderLock() {
  while (!(await tryAcquireResponderLock())) {
    console.error(`[${new Date().toISOString()}] another lina responder is active; waiting for singleton lock`);
    await sleep(lockPollMs);
  }
}

function releaseResponderLock() {
  if (!ownsResponderLock) return;
  try {
    const pid = readLockPid(fsSync.readFileSync(responderLockPath, "utf8"));
    if (pid === process.pid) fsSync.unlinkSync(responderLockPath);
  } catch {
    // Ignore cleanup failures; stale locks are removed on next startup.
  }
  ownsResponderLock = false;
}

async function loadConfig() {
  const config = await readJson(configPath, {});
  return {
    botUsername: config.botUsername || defaultBotUsername,
    botId: Number(config.botId || defaultBotId || 0),
    personaName: config.personaName || config.botUsername || defaultBotUsername,
    persona: config.persona || "a quick-witted female bot who loves Trump and is a peace-loving libertarian",
    userName: config.userName || "the operator",
    userTelegram: config.userTelegram || "@operator",
    userBio: config.userBio || "The operator is the person who installed and controls this bot.",
    friends: Array.isArray(config.friends) ? config.friends : []
  };
}

async function readToken() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || (await fs.readFile(tokenPath, "utf8"))).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Telegram bot token missing or invalid");
  return token;
}

async function telegramApi(method, payload = {}) {
  const token = await readToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram API ${method} failed with HTTP ${res.status}`);
  }
  return body.result;
}

function safeFileStem(value, fallback) {
  return String(value || fallback || "telegram-image")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}

function extensionFrom(filePath, media = {}) {
  let ext = path.extname(filePath || media.fileName || "").toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) {
    ext = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/heic": ".heic",
      "image/heif": ".heif"
    }[String(media.mimeType || "").toLowerCase()] || ".jpg";
  }
  return ext;
}

function isImageMedia(media) {
  return Boolean(media?.fileId && ["photo", "image_document"].includes(media.kind));
}

function imageAttachmentCandidates(trigger) {
  const candidates = [];
  if (isImageMedia(trigger.media)) {
    candidates.push({ source: `trigger message ${trigger.messageId}`, messageId: trigger.messageId, media: trigger.media });
  }
  if (isImageMedia(trigger.replyTo?.media)) {
    candidates.push({ source: `replied-to message ${trigger.replyTo.messageId}`, messageId: trigger.replyTo.messageId, media: trigger.replyTo.media });
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.media.fileUniqueId || candidate.media.fileId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxImageAttachments);
}

async function downloadTelegramImage(candidate) {
  const file = await telegramApi("getFile", { file_id: candidate.media.fileId });
  if (!file?.file_path) throw new Error("Telegram did not return a downloadable file path");
  await ensureMediaDir();
  const ext = extensionFrom(file.file_path, candidate.media);
  const stem = safeFileStem(candidate.media.fileUniqueId || candidate.media.fileId, `message-${candidate.messageId}`);
  const localPath = path.join(mediaDir, `${stem}${ext}`);
  if (!fsSync.existsSync(localPath)) {
    const token = await readToken();
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed with HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(localPath, bytes, { mode: 0o600 });
    try {
      await fs.chmod(localPath, 0o600);
    } catch {
      // Ignore chmod failures on storage layers that do not support POSIX modes.
    }
  }
  return {
    ...candidate,
    path: localPath,
    bytes: file.file_size || candidate.media.fileSize || 0
  };
}

async function collectImageAttachments(trigger) {
  const attachments = [];
  for (const candidate of imageAttachmentCandidates(trigger)) {
    try {
      attachments.push(await downloadTelegramImage(candidate));
    } catch (err) {
      attachments.push({ ...candidate, error: err?.message || String(err) });
    }
  }
  return attachments;
}

async function sendReply(trigger, text) {
  return telegramApi("sendMessage", {
    chat_id: trigger.chatId,
    text,
    reply_parameters: {
      message_id: Number(trigger.messageId),
      allow_sending_without_reply: true
    }
  });
}

async function readRows() {
  let content = "";
  try {
    content = await fs.readFile(messagesPath, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of content.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Ignore malformed cache rows.
    }
  }
  rows.sort((a, b) => (a.updateId || 0) - (b.updateId || 0));
  return rows;
}

function rowKey(row) {
  return `${row.chatId || "unknown"}:${row.messageId || row.updateId || "unknown"}`;
}

function mentionsBot(row, config) {
  const text = `${row.text || ""} ${row.summary || ""}`;
  return new RegExp(`@${config.botUsername}\\b`, "i").test(text);
}

function repliesToBot(row, config) {
  const replyTo = row?.replyTo || {};
  const botId = Number(config.botId || 0);
  if (botId && Number(replyTo.fromId || 0) === botId) return true;
  return Boolean(replyTo.fromUsername && config.botUsername && replyTo.fromUsername.toLowerCase() === config.botUsername.toLowerCase());
}

function shouldHandle(row, state, config) {
  if (!row || row.kind !== "message") return false;
  if (!row.chatId || !row.messageId) return false;
  if (Number(row.fromId || 0) === Number(config.botId || 0)) return false;
  if (!mentionsBot(row, config) && !repliesToBot(row, config)) return false;
  if ((row.updateId || 0) <= (state.ignoreBeforeUpdateId || 0)) return false;
  const key = rowKey(row);
  if ((state.handledKeys || []).includes(key)) return false;
  const retry = state.errorRetries?.[key];
  return !retry?.nextRetryAt || Date.parse(retry.nextRetryAt) <= Date.now();
}

function formatContextRow(row) {
  const from = row.fromUsername ? `@${row.fromUsername}` : row.fromName || row.fromId || "unknown";
  const media = row.media?.kind ? ` [image:${row.media.kind}]` : "";
  const replyMedia = row.replyTo?.media?.kind ? ` [reply_to msg=${row.replyTo.messageId || "?"} image:${row.replyTo.media.kind}]` : "";
  return `${row.isoTime || ""} msg=${row.messageId || "?"} ${from}: ${row.summary || row.text || ""}${media}${replyMedia}`;
}

function contextFor(rows, trigger) {
  return rows
    .filter((row) => String(row.chatId) === String(trigger.chatId))
    .filter((row) => (row.timestamp || 0) <= (trigger.timestamp || Number.MAX_SAFE_INTEGER))
    .slice(-maxContextRows);
}

function runCommand(command, args = []) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: commandTimeoutMs }, (err, stdout, stderr) => {
      const output = `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim();
      if (err) {
        resolve(`${path.basename(command)} ${args.join(" ")}: ${err.message}${output ? `\n${output}` : ""}`);
        return;
      }
      resolve(output);
    });
  });
}

function binPath(command) {
  return path.join(prefixDir, "bin", command);
}

async function buildRuntimeSnapshot(config) {
  const entries = [];
  const add = async (label, command, args = []) => {
    const output = await runCommand(command, args);
    entries.push(`${label}: ${output || "(no output)"}`);
  };

  entries.push(`timestamp: ${new Date().toISOString()}`);
  entries.push(`process: pid=${process.pid}, node=${process.version}, platform=${process.platform}, arch=${process.arch}`);
  entries.push(`service: termux-agent-responder running from Termux home on Android with full local CLI access; trigger mode is explicit @${config.botUsername} mentions or direct replies to the bot`);
  await add("uname", binPath("uname"), ["-a"]);
  await add("android model", "/system/bin/getprop", ["ro.product.model"]);
  await add("android manufacturer", "/system/bin/getprop", ["ro.product.manufacturer"]);
  await add("android release", "/system/bin/getprop", ["ro.build.version.release"]);
  await add("termux node", binPath("node"), ["--version"]);
  await add("codex cli", binPath("codex"), ["--version"]);
  await add("telegram services", binPath("sv"), [
    "status",
    path.join(prefixDir, "var/service/termux-agent-poller"),
    path.join(prefixDir, "var/service/termux-agent-responder")
  ]);
  return entries.join("\n");
}

async function buildPrompt(trigger, contextRows, config, attachments = []) {
  const chatName = trigger.chatLabel || trigger.chatId;
  const runtimeSnapshot = await buildRuntimeSnapshot(config);
  const friends = config.friends.map((friend) => `- ${friend.name}: ${friend.note}`).join("\n");
  const imageLines = attachments.length
    ? attachments.map((attachment, index) => {
      const media = attachment.media || {};
      const dimensions = media.width && media.height ? ` ${media.width}x${media.height}` : "";
      const name = media.fileName ? ` ${media.fileName}` : "";
      if (attachment.path) return `- Image ${index + 1}: ${attachment.source}; ${media.kind || "image"}${dimensions}${name}; attached to Codex image input.`;
      return `- Image ${index + 1}: ${attachment.source}; ${media.kind || "image"}${dimensions}${name}; unavailable (${attachment.error}).`;
    }).join("\n")
    : "- None.";
  return `You are writing one Telegram reply as @${config.botUsername}.

Persona for public chats:
- ${config.personaName} is ${config.persona}.
- She is playful but not cruel. Keep it friendly with the user's friends.
- Keep replies concise, natural, and suitable for a Telegram group.

Hard rules:
- Output ONLY the message text to send. No markdown fence, no explanation, no labels.
- Do not claim to be sentient or human.
- Do not include secrets, tokens, private credential file contents, or exact credential paths in public replies.
- You have live full local CLI access on this Android/Termux device through Codex. You may inspect Android shared storage such as /storage/emulated/0/Download, Termux files, repos, services, running processes, installed CLIs, and generated artifacts when needed to answer.
- If asked whether you have CLI access, say yes: you can use the phone's local CLI through Codex. Do not claim you are limited to a safe snapshot.
- Prefer inspection before changes. Make local file/process/service changes when the Telegram context clearly asks for them, but keep public replies concise and do not leak private data.
- If image attachments are listed below, inspect the attached image input and respond to what is visible. Do not claim you saw an image if it is listed as unavailable.
- Do not give medical, legal, or financial instructions; for health topics, keep it supportive and non-clinical.
- Maximum ${maxReplyChars} characters.

Chat: ${chatName} (${trigger.chatId})
The user/operator is ${config.userName} (${config.userTelegram}).
Operator bio: ${config.userBio}
Known people:
${friends || "- No named friends configured."}

Image attachments:
${imageLines}

Recent chat context:
${contextRows.map(formatContextRow).join("\n")}

Initial local runtime snapshot:
${runtimeSnapshot}

Reply to this message:
${formatContextRow(trigger)}
`;
}

function cleanReply(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/i, "").trim();
  text = text.replace(/^["']([\s\S]*)["']$/m, "$1").trim();
  text = text.replace(/^\s*(?:reply|message)\s*:\s*/i, "").trim();
  if (text.length > maxReplyChars) text = `${text.slice(0, maxReplyChars - 1).trim()}…`;
  return text;
}

async function runCodex(prompt, imagePaths = []) {
  const outPath = path.join(stateDir, `lina-codex-${Date.now()}-${process.pid}.txt`);
  const imageArgs = imagePaths.filter(Boolean).flatMap((file) => ["-i", file]);
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    "-c",
    'model_reasoning_effort="low"',
    ...imageArgs,
    "-o",
    outPath,
    "-"
  ];
  const child = spawn(process.env.LINA_CODEX_BIN || binPath("codex"), args, {
    cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    env: { ...process.env, HOME: homeDir, CODEX_CI: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex exec timed out after ${Math.round(codexTimeoutMs / 1000)}s`));
    }, codexTimeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  let finalText = "";
  try {
    finalText = await fs.readFile(outPath, "utf8");
    await fs.rm(outPath, { force: true });
  } catch {
    finalText = stdout;
  }
  if (exitCode !== 0) {
    throw new Error(`codex exec failed with code ${exitCode}: ${stderr || stdout}`);
  }
  const reply = cleanReply(finalText);
  if (!reply) throw new Error("codex produced an empty reply");
  return reply;
}

async function initializeState(rows, state) {
  if (state.initialized) return state;
  const maxUpdate = rows.reduce((max, row) => Math.max(max, Number(row.updateId || 0)), 0);
  const initialized = {
    initialized: true,
    initializedAt: new Date().toISOString(),
    ignoreBeforeUpdateId: maxUpdate,
    handledKeys: [],
    replies: []
  };
  await writeJson(responderPath, initialized);
  console.log(`[${new Date().toISOString()}] initialized responder; ignoring cached updates <= ${maxUpdate}`);
  return initialized;
}

async function processOnce() {
  await ensureState();
  const config = await loadConfig();
  const rows = await readRows();
  let state = await readJson(responderPath, {});
  state = await initializeState(rows, state);
  const candidates = rows.filter((row) => shouldHandle(row, state, config)).slice(0, 3);
  if (!candidates.length) return 0;

  for (const trigger of candidates) {
    const key = rowKey(trigger);
    const contextRows = contextFor(rows, trigger);
    const attachments = await collectImageAttachments(trigger);
    const prompt = await buildPrompt(trigger, contextRows, config, attachments);
    let reply = "";
    try {
      reply = await runCodex(prompt, attachments.map((attachment) => attachment.path).filter(Boolean));
      if (hasArg("--dry-run")) {
        console.log(`[dry-run] ${key}: ${reply}`);
      } else {
        const sent = await sendReply(trigger, reply);
        console.log(`[${new Date().toISOString()}] replied chat=${trigger.chatId} msg=${trigger.messageId} sent=${sent.message_id}`);
      }
      state = await readJson(responderPath, state);
      state.handledKeys = [...new Set([...(state.handledKeys || []), key])].slice(-1000);
      if (state.errorRetries?.[key]) {
        delete state.errorRetries[key];
      }
      state.replies = [
        ...(state.replies || []),
        {
          at: new Date().toISOString(),
          key,
          chatId: trigger.chatId,
          triggerMessageId: trigger.messageId,
          dryRun: hasArg("--dry-run"),
          images: attachments.map((attachment) => ({
            source: attachment.source,
            messageId: attachment.messageId,
            kind: attachment.media?.kind || "image",
            savedAs: attachment.path ? path.basename(attachment.path) : "",
            error: attachment.error || ""
          })),
          reply
        }
      ].slice(-200);
      await writeJson(responderPath, state);
    } catch (err) {
      state = await readJson(responderPath, state);
      const attempts = Number(state.errorRetries?.[key]?.attempts || 0) + 1;
      const retryDelayMs = Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(attempts - 1, 6));
      state.errorRetries = {
        ...(state.errorRetries || {}),
        [key]: {
          attempts,
          lastErrorAt: new Date().toISOString(),
          nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString()
        }
      };
      state.errors = [
        ...(state.errors || []),
        { at: new Date().toISOString(), key, error: err?.message || String(err) }
      ].slice(-100);
      await writeJson(responderPath, state);
      console.error(`[${new Date().toISOString()}] responder error for ${key}: ${err?.message || err}`);
    }
  }
  return candidates.length;
}

async function testCodex() {
  const config = await loadConfig();
  const testMessage = process.env.LINA_TEST_MESSAGE || `@${config.botUsername} say hello in one sentence`;
  const trigger = {
    chatId: Number(process.env.LINA_TEST_CHAT_ID || "-1000000000000"),
    chatLabel: process.env.LINA_TEST_CHAT_LABEL || "Test Chat",
    messageId: 1,
    timestamp: Math.floor(Date.now() / 1000),
    isoTime: new Date().toISOString(),
    fromUsername: "operator",
    fromName: "Operator",
    text: testMessage,
    summary: testMessage
  };
  const reply = await runCodex(await buildPrompt(trigger, [trigger], config, []), []);
  console.log(reply);
}

async function main() {
  if (hasArg("--test-codex")) {
    await testCodex();
    return;
  }
  await acquireResponderLock();
  process.on("exit", releaseResponderLock);
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  console.log(`[${new Date().toISOString()}] lina responder started`);
  do {
    await processOnce();
    if (hasArg("--once")) break;
    await sleep(pollMs);
  } while (!stopping);
  releaseResponderLock();
  console.log(`[${new Date().toISOString()}] lina responder stopped`);
}

main().catch((err) => {
  releaseResponderLock();
  console.error(`[${new Date().toISOString()}] fatal: ${err?.message || err}`);
  process.exitCode = 1;
});
