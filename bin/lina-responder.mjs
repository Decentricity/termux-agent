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
const defaultBotUsername = process.env.LINA_BOT_USERNAME || "LinaTalbot";
const defaultBotId = Number(process.env.LINA_BOT_ID || "5813078614");
const pollMs = Number(process.env.LINA_RESPONDER_POLL_MS || "4000");
const codexTimeoutMs = Number(process.env.LINA_CODEX_TIMEOUT_MS || "180000");
const maxContextRows = Number(process.env.LINA_CONTEXT_ROWS || "28");
const maxReplyChars = Number(process.env.LINA_MAX_REPLY_CHARS || "900");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const commandTimeoutMs = 3000;

function hasArg(name) {
  return process.argv.includes(name);
}

async function ensureState() {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
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

function shouldHandle(row, state, config) {
  if (!row || row.kind !== "message") return false;
  if (!row.chatId || !row.messageId) return false;
  if (Number(row.fromId || 0) === Number(config.botId || 0)) return false;
  if (!mentionsBot(row, config)) return false;
  if ((row.updateId || 0) <= (state.ignoreBeforeUpdateId || 0)) return false;
  return !(state.handledKeys || []).includes(rowKey(row));
}

function formatContextRow(row) {
  const from = row.fromUsername ? `@${row.fromUsername}` : row.fromName || row.fromId || "unknown";
  return `${row.isoTime || ""} msg=${row.messageId || "?"} ${from}: ${row.summary || row.text || ""}`;
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
  entries.push(`service: termux-agent-responder running from Termux home on Android; trigger mode is explicit @${config.botUsername} mentions only`);
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

async function buildPrompt(trigger, contextRows, config) {
  const chatName = trigger.chatLabel || trigger.chatId;
  const runtimeSnapshot = await buildRuntimeSnapshot(config);
  const friends = config.friends.map((friend) => `- ${friend.name}: ${friend.note}`).join("\n");
  return `You are writing one Telegram reply as @${config.botUsername}.

Persona for public chats:
- ${config.personaName} is ${config.persona}.
- She is playful but not cruel. Keep it friendly with the user's friends.
- Keep replies concise, natural, and suitable for a Telegram group.

Hard rules:
- Output ONLY the message text to send. No markdown fence, no explanation, no labels.
- Do not claim to be sentient or human.
- Do not include secrets, tokens, private file contents, exact credential paths, or private operator/developer details.
- You may answer questions about your runtime using the controlled local runtime snapshot below. Keep it high-level unless the chat directly asks for specifics.
- If asked whether you have CLI access, say you have a safe local status snapshot generated from CLI commands, not arbitrary public shell execution.
- Do not give medical, legal, or financial instructions; for health topics, keep it supportive and non-clinical.
- Maximum ${maxReplyChars} characters.

Chat: ${chatName} (${trigger.chatId})
The user/operator is ${config.userName} (${config.userTelegram}).
Operator bio: ${config.userBio}
Known people:
${friends || "- No named friends configured."}

Recent chat context:
${contextRows.map(formatContextRow).join("\n")}

Controlled local runtime snapshot:
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

async function runCodex(prompt) {
  const outPath = path.join(stateDir, `lina-codex-${Date.now()}-${process.pid}.txt`);
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-C",
    path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    "-c",
    'model_reasoning_effort="low"',
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
    const prompt = await buildPrompt(trigger, contextRows, config);
    let reply = "";
    try {
      reply = await runCodex(prompt);
      if (hasArg("--dry-run")) {
        console.log(`[dry-run] ${key}: ${reply}`);
      } else {
        const sent = await sendReply(trigger, reply);
        console.log(`[${new Date().toISOString()}] replied chat=${trigger.chatId} msg=${trigger.messageId} sent=${sent.message_id}`);
      }
      state = await readJson(responderPath, state);
      state.handledKeys = [...new Set([...(state.handledKeys || []), key])].slice(-1000);
      state.replies = [
        ...(state.replies || []),
        {
          at: new Date().toISOString(),
          key,
          chatId: trigger.chatId,
          triggerMessageId: trigger.messageId,
          dryRun: hasArg("--dry-run"),
          reply
        }
      ].slice(-200);
      await writeJson(responderPath, state);
    } catch (err) {
      state = await readJson(responderPath, state);
      state.handledKeys = [...new Set([...(state.handledKeys || []), key])].slice(-1000);
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
    chatId: -1002134033154,
    chatLabel: "Myriad Pol",
    messageId: 1,
    timestamp: Math.floor(Date.now() / 1000),
    isoTime: new Date().toISOString(),
    fromUsername: "operator",
    fromName: "Operator",
    text: testMessage,
    summary: testMessage
  };
  const reply = await runCodex(await buildPrompt(trigger, [trigger], config));
  console.log(reply);
}

async function main() {
  if (hasArg("--test-codex")) {
    await testCodex();
    return;
  }
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
  console.log(`[${new Date().toISOString()}] lina responder stopped`);
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] fatal: ${err?.message || err}`);
  process.exitCode = 1;
});
