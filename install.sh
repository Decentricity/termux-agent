#!/data/data/com.termux/files/usr/bin/sh
set -eu

PREFIX=${PREFIX:-/data/data/com.termux/files/usr}
HOME=${HOME:-/data/data/com.termux/files/home}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR="$SCRIPT_DIR"
BIN_DIR="$HOME/.local/bin"
STATE_DIR="$HOME/.termux-agent"
SERVICE_DIR="$PREFIX/var/service"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

install_termux_packages() {
  if ! command_exists pkg; then
    echo "pkg not found. This installer expects Termux on Android."
    exit 1
  fi
  pkg update -y
  pkg install -y nodejs git termux-services termux-api
}

install_codex() {
  if command_exists codex; then
    echo "Codex already installed: $(codex --version 2>/dev/null || true)"
    return
  fi
  echo "Installing Codex CLI for Termux Android..."
  npm install -g @mmmbuto/codex-cli-termux || npm install -g @openai/codex
}

write_wrapper() {
  name="$1"
  target="$2"
  cat > "$BIN_DIR/$name" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
set -eu
export HOME="$HOME"
export PREFIX="$PREFIX"
export PATH="$PREFIX/bin:\$PATH"
export TERMUX_AGENT_STATE_DIR="$STATE_DIR"
export TELEGRAM_CODEX_STATE_DIR="$STATE_DIR"
cd "$APP_DIR"
exec "$PREFIX/bin/node" "$target" "\$@"
EOF
  chmod 700 "$BIN_DIR/$name"
}

link_service() {
  name="$1"
  target="$SERVICE_DIR/$name"
  source="$APP_DIR/service/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "Service path exists and is not a symlink: $target"
    echo "Move it aside before reinstalling this service."
    exit 1
  fi
  ln -sfn "$source" "$target"
}

chmod 700 "$APP_DIR/bin/"*.mjs
chmod 700 "$APP_DIR/service/termux-agent-poller/run" "$APP_DIR/service/termux-agent-poller/finish" "$APP_DIR/service/termux-agent-poller/log/run"
chmod 700 "$APP_DIR/service/termux-agent-responder/run" "$APP_DIR/service/termux-agent-responder/log/run"

install_termux_packages
install_codex

mkdir -p "$BIN_DIR" "$STATE_DIR" "$SERVICE_DIR"
chmod 700 "$BIN_DIR" "$STATE_DIR"
write_wrapper tg-codex bin/tg-codex.mjs
write_wrapper termux-agent-tg bin/tg-codex.mjs
write_wrapper lina-onboard bin/lina-onboard.mjs
write_wrapper termux-agent-onboard bin/lina-onboard.mjs
write_wrapper lina-responder bin/lina-responder.mjs
write_wrapper termux-agent-responder bin/lina-responder.mjs

echo
echo "Starting onboarding. It begins with your name and quick bio."
"$BIN_DIR/lina-onboard"

link_service termux-agent-poller
link_service termux-agent-responder

service-daemon start >/dev/null 2>&1 || true
sv up "$SERVICE_DIR/termux-agent-poller" >/dev/null 2>&1 || true
sv up "$SERVICE_DIR/termux-agent-responder" >/dev/null 2>&1 || true

echo
echo "Installed."
echo "Check services:"
echo "  sv status $SERVICE_DIR/termux-agent-poller $SERVICE_DIR/termux-agent-responder"
echo "Check Telegram cache:"
echo "  tg-codex chats"
