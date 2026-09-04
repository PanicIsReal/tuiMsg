# imsg

A terminal Messages window for a Mac that already runs BlueBubbles.

SSH into the Mac, run `imsg`, and talk iMessage from a two-pane TUI. Copy uses OSC 52 so a remote session can write your laptop clipboard.

The npm package name is `tuimsg` because `imsg` is taken. After install the binary is still `imsg`. One-shot is `npx tuimsg`.

## Setup

1. Install and start [BlueBubbles](https://bluebubbles.app) on the Mac. Default API is `http://127.0.0.1:1234`.
2. Put the server password in config:

```
mkdir -p ~/.config/imsg
cat > ~/.config/imsg/config.json <<'EOF'
{
  "url": "http://127.0.0.1:1234",
  "password": "your-bluebubbles-password"
}
EOF
chmod 600 ~/.config/imsg/config.json
```

Or set `IMSG_URL` and `IMSG_PASSWORD`.

3. Run:

```
pnpm install
pnpm imsg --fake     # demo, no BlueBubbles
pnpm imsg            # live server
```

Tapbacks, typing, mark-read, and group membership need BlueBubbles Private API (SIP off, helper connected). Without it, send and receive still work.

## Keys

`j`/`k` move the list. `Enter` opens. `i` focuses the composer. `Esc` leaves it. `y` copies the selected text via OSC 52. `/` searches. `?` help. `q` quits from the list.

Inside tmux, set `set -g set-clipboard on` and `set -g allow-passthrough on` so OSC 52 reaches the local terminal.

## Dev

```
pnpm test
pnpm typecheck
pnpm smoke
```
