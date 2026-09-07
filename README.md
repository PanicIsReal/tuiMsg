# tuiMsg

A terminal Messages window built with Ink and React for a Mac running BlueBubbles. The command is `imsg`.

Browse conversations, search names and previews, read older messages, and compose with a draft for each conversation. You can reply, react, copy message text, and preview images, and download received attachments. Narrow terminals show one pane at a time.

## Setup

Install [Bun](https://bun.sh) 1.3.14 or newer, then start [BlueBubbles](https://bluebubbles.app) on the Mac. Bun must be on your `PATH`, including when launching through npm or over SSH.

From this checkout, run `bun run imsg` to set up your connection on first launch. Enter the BlueBubbles server IP address or URL and its server password. A bare address uses HTTP on port `1234`; enter a full URL for HTTPS or a different port. Password entry is masked.

After checking the connection, `imsg` saves the server settings in `~/.config/imsg/config.json` and stores the password in macOS Keychain. Future launches retrieve the saved password and open your inbox. Run `imsg --setup` to change the connection.

On Linux, secure storage requires a running Secret Service such as GNOME Keyring or KWallet. If secure storage is unavailable, setup offers an explicit choice to save the password as plaintext in a private configuration file with `0600` permissions, or connect for the current session. The file option remembers your login without a keyring. It is not encrypted.

If a saved keyring cannot be accessed, `imsg` reports the problem instead of starting first-time setup again. Unlock the keyring and relaunch. If only its password entry is missing, setup reuses the saved server address and asks for the password.

For scripts, set `IMSG_PASSWORD` and optionally `IMSG_URL`. The URL defaults to `http://127.0.0.1:1234`. `IMSG_CONFIG` selects a different configuration file. Interactive setup requires a terminal.

Run from a checkout:

```sh
bun install
bun run imsg --fake   # Local demo server, no real messages
bun run imsg          # Your configured BlueBubbles server
```

Build the distributable launcher with `bun run build`, then run `./bin/imsg`. From any directory, use `bun /path/to/tuiMsg/bin/imsg` for this checkout. If another application already owns the `imsg` command, use the explicit path. The npm package is named `tuimsg`; its installed command is `imsg`. The launcher runs the compiled `dist/cli.js` with Bun.

BlueBubbles Private API and its connected helper enable additional operations such as reactions, typing, and marking conversations read. The app reports unsupported operations. Basic messaging remains available without them.

## Keyboard controls

| Context | Keys | Action |
|---|---|---|
| Conversation list | `j` / `k`, arrows | Move the highlight |
| Conversation list | `Enter` | Open the highlighted conversation |
| Transcript | `j` / `k`, arrows | Select a message |
| Transcript | `i`, `Enter` | Focus the composer |
| Composer | `Enter` | Send |
| Composer | `Shift+Enter`, `Ctrl+J` | Insert a newline |
| Composer | `Esc` | Return to the transcript |
| Transcript | `Esc` | Return to the list |
| Panes | `Tab` | Change focus |
| Outside composer | `/`, `n`, `?` | Search, new conversation, help |
| Transcript | `y`, `r`, `t`, `a` | Copy, reply, react, choose an attachment |
| Transcript | `v`, `o`, `s` | Expand an image, open, save the selected message’s attachment |
| Conversation list | `Shift+R` | Refresh conversations and contacts |
| Transcript | `g`, `Shift+R`, `m` | Load older history, retry history, retry marking read |
| Transcript | `!` | Retry the selected failed or uncertain send |
| New conversation | `Tab`, `Ctrl+T`, `Ctrl+S` | Change field, switch service, send first message |
| Attachment chooser | `j` / `k`, `v` / `Enter`, `s`, `o` | Select, preview, save, open |
| Image viewer | `o`, `s`, `Esc` | Open original, save original, close |
| Outside composer | `q` | Quit |
| Anywhere | `Ctrl+C` | Quit |

Search filters conversation titles and their latest message previews. A new conversation requires recipients and a first message. Separate multiple recipients with commas or semicolons.

Drafts and unresolved sends are stored beside the configuration file, separately for each server identity. If a send result is uncertain, check the conversation before confirming another attempt. BlueBubbles does not guarantee that repeating a request sends only once.

## SSH and attachments

Copy uses OSC 52 to reach your local clipboard. In tmux, enable `set -g set-clipboard on` and `set -g allow-passthrough on`. Your terminal must allow clipboard escape sequences.

Received photos appear inline with their messages. Press `v` on an image message for a larger view, or `a` to choose among all its attachments. Press `o` to open the original or `s` to save it. Image downloads use the authenticated BlueBubbles connection.

PNG, JPEG, WebP, and GIF previews decode locally. GIFs animate while visible. On macOS, HEIC photos can use the system image converter when the bundled decoder cannot read them. An unsupported or corrupt preview keeps the original available to open or save.

Kitty-compatible terminals, including detected Kitty, WezTerm, and Ghostty sessions, use native bitmap images. Other terminals, including iTerm2 and tmux sessions, use color half-block previews. Actual bitmap display depends on your terminal's graphics support. Native image previews are limited to 2560 pixels on the longest side; opening or saving preserves the original file.

Preview decoding limits compressed files to 32 MB and source images to 40 million pixels. GIFs exceeding 60 frames or a total 40-million-pixel animation budget show a still frame. Offscreen previews defer downloads and release decoded frames.

Contact names come from the BlueBubbles address book. Matching ignores phone punctuation and email capitalization. North American numbers also match their ten-digit, `1`, and `+1` forms, including a stray `+` before the ten-digit number, when exactly one contact matches. For example, `7805550123`, `+7805550123`, `17805550123`, and `+17805550123` resolve to the same saved contact name. Exact matches take precedence. Missing server contacts and conflicting fallback matches remain displayed as addresses.

Attachment downloads are saved on the computer running `imsg`. Over SSH, opening an attachment saves it there and displays its path. On a local Mac, opening also launches the associated application.

## Development and verification

```sh
bun run typecheck
bun run test
bun run test:colors
bun run build
bun run smoke
bun run smoke:setup
bun run smoke:images
```

The tests cover the domain, HTTP and socket integration, persistence, and Ink input and rendered frames. The smoke test needs a Bun release with `Bun.Terminal` support. It launches the compiled app in a real PTY against a fake BlueBubbles server and checks sends, recipient-specific drafts, search, resize, and terminal restoration. Test artifacts are written under `.audit/pty`.

`test:colors` captures the full Ink interface at 80 and 180 columns with 256-color output. It checks for unpainted cells on a white terminal background and writes ANSI, SVG, and PNG previews under `.audit/colors`. The palette tests also cover 16-color and truecolor output.

`smoke:setup` exercises first launch and repeat launch through a real PTY. It creates a temporary config and disposable native credential, then removes both. It requires an available OS credential store. Results are written under `.audit/setup`.

`smoke:images` checks authenticated attachment downloads, both rendering paths, expanded viewing, byte-for-byte original saving, resize, and cleanup through the compiled app. Its native check verifies the generated Kitty protocol; it does not substitute for viewing the result in a compatible terminal.

Local tests do not replace acceptance against your installed BlueBubbles version. They never send real messages.
