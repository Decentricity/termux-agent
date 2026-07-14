#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import readline from "node:readline/promises";

const homeDir = process.env.HOME || os.homedir();
const prefixDir = process.env.PREFIX || path.dirname(path.dirname(process.execPath));
const stateDir = process.env.TERMUX_AGENT_STATE_DIR || process.env.TELEGRAM_CODEX_STATE_DIR || path.join(homeDir, ".termux-agent");
const tokenPath = path.join(stateDir, "token");
const configPath = path.join(stateDir, "config.json");
const responderPath = path.join(stateDir, "lina-responder.json");
const messagesPath = path.join(stateDir, "messages.jsonl");

function binPath(command) {
  return path.join(prefixDir, "bin", command);
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

function run(command, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: opts.timeout || 15000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code || 0,
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
        error: err
      });
    });
  });
}

function runInteractive(command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("exit", (code) => resolve(code || 0));
    child.on("error", () => resolve(1));
  });
}

async function askRequired(rl, question) {
  for (;;) {
    const answer = (await rl.question(question)).trim();
    if (answer) return answer;
    console.log("Required.");
  }
}

async function askDefault(rl, question, fallback) {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

function normalizeTelegramUsername(raw) {
  const value = raw.trim();
  if (!value) return "";
  return value.startsWith("@") ? value : `@${value}`;
}

async function verifyBotToken(token) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error("Telegram bot token does not look valid.");
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram getMe failed with HTTP ${res.status}`);
  }
  return body.result;
}

async function existingToken() {
  try {
    return (await fs.readFile(tokenPath, "utf8")).trim();
  } catch {
    return "";
  }
}

async function maxCachedUpdateId() {
  let max = 0;
  let content = "";
  try {
    content = await fs.readFile(messagesPath, "utf8");
  } catch {
    return 0;
  }
  for (const line of content.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      max = Math.max(max, Number(row.updateId || 0));
    } catch {
      // Ignore malformed cache rows.
    }
  }
  return max;
}

async function initializeResponderBaseline() {
  const existing = await readJson(responderPath, {});
  if (existing.initialized) return;
  const ignoreBeforeUpdateId = await maxCachedUpdateId();
  await writeJson(responderPath, {
    initialized: true,
    initializedAt: new Date().toISOString(),
    ignoreBeforeUpdateId,
    handledKeys: [],
    replies: []
  });
}

async function codexLoginStatus() {
  const result = await run(binPath("codex"), ["login", "status"]);
  return {
    loggedIn: result.ok && /Logged in/i.test(`${result.stdout}\n${result.stderr}`),
    output: result.stdout || result.stderr
  };
}

async function maybeLoginCodex(rl) {
  const status = await codexLoginStatus();
  if (status.loggedIn) {
    console.log(`Codex login: ${status.output}`);
    return;
  }
  console.log("Codex is installed but not logged in. Lina needs Codex login before autonomous replies can work.");
  const answer = (await rl.question("Run `codex login --device-auth` now? [Y/n]: ")).trim().toLowerCase();
  if (answer && answer !== "y" && answer !== "yes") {
    console.log("Later, run: codex login --device-auth");
    return;
  }
  await runInteractive(binPath("codex"), ["login", "--device-auth"]);
}

async function main() {
  await ensureState();
  const previous = await readJson(configPath, {});
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("LinaTalbot onboarding");
    console.log("First, tell Codex who is operating this bot.");
    const userName = previous.userName ? await askDefault(rl, "Your name", previous.userName) : await askRequired(rl, "Your name: ");
    const userBio = previous.userBio
      ? await askDefault(rl, "Quick public-safe bio for you", previous.userBio)
      : await askRequired(rl, "Quick public-safe bio for you: ");
    const userTelegram = normalizeTelegramUsername(await askDefault(rl, "Your Telegram username", previous.userTelegram || ""));

    await maybeLoginCodex(rl);

    const oldToken = await existingToken();
    const tokenPrompt = oldToken ? "Telegram bot token from BotFather (blank to keep existing)" : "Telegram bot token from BotFather";
    const token = oldToken ? (await rl.question(`${tokenPrompt}: `)).trim() || oldToken : await askRequired(rl, `${tokenPrompt}: `);
    const bot = await verifyBotToken(token);
    await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });

    const personaName = await askDefault(rl, "Public bot persona name", previous.personaName || bot.first_name || bot.username || "LinaTalbot");
    const persona = await askDefault(
      rl,
      "Public persona in one sentence",
      previous.persona || "a quick-witted female bot who loves Trump and is a peace-loving libertarian"
    );
    const context = await askDefault(
      rl,
      "Known friends/groups/context, optional one line",
      previous.friends?.[0]?.note || ""
    );
    const friends = context ? [{ name: "Configured context", note: context }] : previous.friends || [];

    const config = {
      userName,
      userBio,
      userTelegram,
      botId: bot.id,
      botUsername: bot.username || personaName,
      personaName,
      persona,
      friends,
      triggerMode: "mention-only",
      updatedAt: new Date().toISOString()
    };
    await writeJson(configPath, config);
    await initializeResponderBaseline();

    console.log(`Saved config for @${config.botUsername} in ${configPath}`);
    console.log("Trigger mode: mention-only. Public chat users must tag the bot username.");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`Onboarding failed: ${err?.message || err}`);
  process.exitCode = 1;
});
