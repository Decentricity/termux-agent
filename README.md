# Termux Agent

Mention-triggered Telegram bot agent for Android Termux. It keeps a local Telegram update cache, watches for explicit bot mentions, calls local Codex for a reply, and sends that reply back to Telegram.

The default persona is LinaTalbot, but onboarding lets each user configure the bot name, operator name, bio, and persona.

## What It Installs

- `termux-agent-tg` / `tg-codex`: Telegram Bot API CLI for token save, status, polling, recent messages, chats, and sends.
- `termux-agent-onboard` / `lina-onboard`: interactive setup wizard.
- `termux-agent-poller`: runit service that long-polls Telegram and caches updates.
- `termux-agent-responder`: runit service that replies only when the bot is explicitly tagged.
- Codex CLI for Termux Android, preferring `@mmmbuto/codex-cli-termux`.

## Fresh Termux Install

Run from this directory:

```sh
chmod 700 install.sh
./install.sh
```

The installer will:

1. Install Termux packages: `nodejs`, `git`, `termux-services`, and `termux-api`.
2. Install Codex if missing.
3. Start onboarding by asking for your name and quick public-safe bio.
4. Ask you to log in to Codex if needed.
5. Ask for your Telegram bot token from BotFather and verify it with `getMe`.
6. Save private config under `~/.termux-agent/`.
7. Link and start the poller and responder services.

If Codex login is skipped during onboarding, run:

```sh
codex login --device-auth
sv restart /data/data/com.termux/files/usr/var/service/termux-agent-responder
```

## Telegram Setup

Create a bot with BotFather and paste the token during onboarding. Add the bot to groups where it should respond.

The responder is mention-only. In a group, users must tag the bot:

```text
@YourBotUsername what are you running on?
```

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

## Safety Model

The Telegram group does not get arbitrary shell access.

The responder can include a controlled local runtime snapshot in the Codex prompt. That snapshot is generated from a fixed safe command list: `uname`, Android `getprop` model/manufacturer/release, Node version, Codex version, and service statuses. This lets the bot answer high-level system questions without exposing tokens or allowing public command execution.

Private files:

- `~/.termux-agent/token`: Telegram bot token.
- `~/.termux-agent/config.json`: onboarding config.
- `~/.termux-agent/messages.jsonl`: cached Telegram update summaries.
- `~/.termux-agent/lina-responder.json`: responder dedupe/reply state.

Do not publish these files.
