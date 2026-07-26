#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";

const stateDir = process.env.TERMUX_AGENT_STATE_DIR || process.env.TELEGRAM_CODEX_STATE_DIR || path.join(os.homedir(), ".termux-agent");
const cacheDir = path.join(stateDir, "youtube-transcripts");
const defaultMaxChars = Number(process.env.YOUTUBE_TRANSCRIPT_MAX_CHARS || "14000");

function usage() {
  return `youtube-transcript <youtube-url> [--max-chars <n>] [--refresh]

Fetches available YouTube captions/transcripts using yt-dlp and prints plain text.
`;
}

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function isYoutubeUrl(value) {
  return /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(value);
}

function cachePathFor(url) {
  const digest = crypto.createHash("sha256").update(url).digest("hex").slice(0, 24);
  return path.join(cacheDir, `${digest}.txt`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout || 90000, cwd: options.cwd }, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(`${command} ${args.join(" ")} failed: ${err.message}${stderr ? `\n${stderr}` : ""}`);
        error.stdout = stdout || "";
        error.stderr = stderr || "";
        reject(error);
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function runYtDlp(args, options = {}) {
  try {
    return await run(process.env.YTDLP_BIN || "yt-dlp", args, options);
  } catch (err) {
    if (process.env.YTDLP_BIN) throw err;
    return run(process.env.PYTHON_BIN || "python", ["-m", "yt_dlp", ...args], options);
  }
}

function stripTags(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseVtt(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = stripTags(raw).trim();
    if (!line) continue;
    if (line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d\d:\d\d:\d\d\.\d+\s+-->\s+\d\d:\d\d:\d\d\.\d+/.test(line)) continue;
    if (/^\d\d:\d\d\.\d+\s+-->\s+\d\d:\d\d\.\d+/.test(line)) continue;
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out.join("\n");
}

function parseSrt(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = stripTags(raw).trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d\d:\d\d:\d\d,\d+\s+-->\s+\d\d:\d\d:\d\d,\d+/.test(line)) continue;
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out.join("\n");
}

function parseJson3(content) {
  const json = JSON.parse(content);
  const out = [];
  for (const event of json.events || []) {
    const text = (event.segs || []).map((seg) => seg.utf8 || "").join("").trim();
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out.join("\n");
}

async function readTranscriptFile(file) {
  const content = await fs.readFile(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json3") return parseJson3(content);
  if (ext === ".srt") return parseSrt(content);
  return parseVtt(content);
}

async function metadata(url) {
  try {
    const { stdout } = await runYtDlp(["--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings", url], { timeout: 60000 });
    const json = JSON.parse(stdout);
    return {
      title: json.title || "",
      channel: json.channel || json.uploader || "",
      duration: json.duration_string || (json.duration ? `${json.duration}s` : "")
    };
  } catch {
    return { title: "", channel: "", duration: "" };
  }
}

async function fetchTranscript(url, maxChars) {
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const cachePath = cachePathFor(url);
  if (!hasArg("--refresh") && fsSync.existsSync(cachePath)) {
    return fs.readFile(cachePath, "utf8");
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-transcript-"));
  try {
    const meta = await metadata(url);
    let files = [];
    let lastError = null;
    for (const subLangs of ["en", "en-US,en,en-GB", "en.*,en"]) {
      for (const file of await fs.readdir(tmpDir)) {
        await fs.rm(path.join(tmpDir, file), { recursive: true, force: true });
      }
      try {
        await runYtDlp([
          "--skip-download",
          "--no-playlist",
          "--no-warnings",
          "--write-subs",
          "--write-auto-subs",
          "--sub-langs",
          subLangs,
          "--sub-format",
          "vtt/srt/json3/best",
          "--restrict-filenames",
          "-o",
          "transcript.%(ext)s",
          url
        ], { cwd: tmpDir, timeout: 120000 });
        files = (await fs.readdir(tmpDir))
          .filter((file) => /\.(vtt|srt|json3)$/i.test(file))
          .map((file) => path.join(tmpDir, file));
        if (files.length) break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!files.length) throw new Error("No English subtitles or auto-captions were found for this video.");

    const transcript = (await readTranscriptFile(files[0])).trim();
    if (!transcript) throw new Error("Subtitle file was empty after parsing.");

    const header = [
      meta.title ? `Title: ${meta.title}` : "",
      meta.channel ? `Channel: ${meta.channel}` : "",
      meta.duration ? `Duration: ${meta.duration}` : "",
      `URL: ${url}`,
      `Transcript source: ${path.basename(files[0])}`
    ].filter(Boolean).join("\n");
    let output = `${header}\n\nTranscript:\n${transcript}\n`;
    if (output.length > maxChars) output = `${output.slice(0, maxChars).trim()}\n\n[Transcript truncated at ${maxChars} characters]\n`;
    await fs.writeFile(cachePath, output, { mode: 0o600 });
    return output;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }
  const inputUrl = process.argv.find((arg, index) => index > 1 && !arg.startsWith("--"));
  const url = inputUrl && !/^https?:\/\//i.test(inputUrl) ? `https://${inputUrl}` : inputUrl;
  if (!url || !isYoutubeUrl(url)) throw new Error("Provide a YouTube URL.");
  const maxChars = Number(getArg("--max-chars", String(defaultMaxChars)));
  console.log(await fetchTranscript(url, maxChars));
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
