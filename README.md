# Termux Agent

Mention-triggered Telegram bot agent for Android Termux. It keeps a local Telegram update cache, watches for explicit bot mentions, calls local Codex for a reply, and sends that reply back to Telegram.

The default persona is LinaTalbot, but onboarding lets each user configure the bot name, operator name, bio, and persona.

## What It Installs

- `termux-agent-tg` / `tg-codex`: Telegram Bot API CLI for token save, status, polling, recent messages, chats, and sends.
- `termux-agent-onboard` / `lina-onboard`: interactive setup wizard.
- `youtube-transcript` / `termux-agent-youtube-transcript`: helper that fetches YouTube captions/transcripts via `yt-dlp`.
- `termux-agent-poller`: runit service that long-polls Telegram and caches updates.
- `termux-agent-responder`: runit service that replies when the bot is explicitly tagged or someone directly replies to the bot.
- Codex CLI for Termux Android, preferring `@mmmbuto/codex-cli-termux`.

## Fresh Termux Install

Run from this directory:

```sh
chmod 700 install.sh
./install.sh
```

The installer will:

1. Install Termux packages: `nodejs`, `git`, `python`, `termux-services`, and `termux-api`.
2. Install Codex if missing.
3. Install/upgrade `yt-dlp` for YouTube transcript fetching.
4. Start onboarding by asking for your name and quick public-safe bio.
5. Ask you to log in to Codex if needed.
6. Ask for your Telegram bot token from BotFather and verify it with `getMe`.
7. Save private config under `~/.termux-agent/`.
8. Link and start the poller and responder services.

If Codex login is skipped during onboarding, run:

```sh
codex login --device-auth
sv restart /data/data/com.termux/files/usr/var/service/termux-agent-responder
```

## Telegram Setup

Create a bot with BotFather and paste the token during onboarding. Add the bot to groups where it should respond.

In a group, users can tag the bot:

```text
@YourBotUsername what are you running on?
```

The responder also replies when a user directly replies to one of the bot's messages, even without a tag. If the triggering message contains a photo or replies to a photo/image document, the responder downloads that image into private state and passes it to Codex as an image input before replying.

## Commands

Check bot status:

```sh
tg-codex status
```

List chats seen by the bot:

```sh
tg-codex chats
```

Read recent messages:

```sh
tg-codex recent --limit 25 --ids
```

Read one chat:

```sh
tg-codex recent --chat-id -1001234567890 --limit 25 --ids
```

Send manually:

```sh
tg-codex send --chat-id -1001234567890 --reply-to-message-id 42 --text "message"
```

## Services

Check services:

```sh
sv status /data/data/com.termux/files/usr/var/service/termux-agent-poller
sv status /data/data/com.termux/files/usr/var/service/termux-agent-responder
```

Stop autonomous replies while keeping polling:

```sh
sv down /data/data/com.termux/files/usr/var/service/termux-agent-responder
```

Restart autonomous replies:

```sh
sv up /data/data/com.termux/files/usr/var/service/termux-agent-responder
```

Logs:

```sh
tail -f ~/.termux-agent/service-log/current
tail -f ~/.termux-agent/responder-log/current
```

## Access Model

The responder runs Codex with full local CLI access on the Android/Termux device. When a Telegram message triggers Lina, Codex may inspect shared storage such as `/storage/emulated/0/Download`, Termux files, repos, services, running processes, installed CLIs, and generated artifacts as needed.

The responder still includes an initial runtime snapshot in the prompt, but Lina is not limited to that snapshot. She can use the local CLI through Codex when the Telegram context calls for it.

Public replies should not leak tokens, private credential file contents, exact credential paths, or private operator/developer details.

For image understanding, the responder downloads Telegram images attached to the triggering mention or its replied-to message.

For YouTube links, the responder scans the triggering message, replied-to message, and nearby visible context for `youtube.com` or `youtu.be` URLs. If found, it fetches captions/transcripts with `youtube-transcript`/`yt-dlp` and gives Codex the transcript text. It does not download video/audio or pretend to inspect visual frames.

Private files:

- `~/.termux-agent/token`: Telegram bot token.
- `~/.termux-agent/config.json`: onboarding config.
- `~/.termux-agent/messages.jsonl`: cached Telegram update summaries.
- `~/.termux-agent/media/`: downloaded Telegram images used as Codex image inputs.
- `~/.termux-agent/youtube-transcripts/`: cached YouTube transcript text.
- `~/.termux-agent/lina-responder.json`: responder dedupe/reply state.
- `~/.termux-agent/lina-responder.lock`: singleton lock to prevent duplicate responder processes.

Do not publish these files.
