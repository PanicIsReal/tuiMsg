# tuiMsg

A terminal Messages window for your Mac, built with Ink and React on top of [imsg](https://github.com/openclaw/imsg). Run it on the Mac and use it from anywhere you can open an SSH session, including Windows Terminal. The command is `tuimsg`.

Browse conversations, search names and previews, read older messages, and compose with a draft for each conversation. You can copy message text, preview images, and save attachments. With imsg's optional bridge you can also reply inline, react, send read receipts and typing indicators, and start group conversations. Narrow terminals show one pane at a time.

## How it works

`tuimsg` starts one long-lived `imsg rpc` child process and talks JSON-RPC to it over stdin and stdout. imsg reads `~/Library/Messages/chat.db` directly, streams new messages from it, and sends through Messages.app. Nothing listens on the network and no password is stored: the TUI runs on the Mac, and SSH is how you reach it.

## Requirements

- macOS 14 or newer, signed in to Messages.
- [imsg](https://github.com/openclaw/imsg): `brew install steipete/tap/imsg`. `tuimsg` finds it on `PATH`, in `/opt/homebrew/bin`, or in `/usr/local/bin`; set `IMSG_PATH` to use another binary.
- [Bun](https://bun.sh) 1.3.14 or newer on `PATH`, including in SSH sessions.

```sh
bun install
bun run build
./bin/tuimsg          # your Messages
./bin/tuimsg --fake   # demo data, no Messages access needed
```

From any directory, run `bun /path/to/tuiMsg/bin/tuimsg`, or link `bin/tuimsg` into a directory on your `PATH`. The command is `tuimsg` rather than `imsg` so it never shadows the imsg CLI it drives.

## Permissions

imsg needs **Full Disk Access** to read the Messages database. macOS grants it to the app that launched the process:

- **Over SSH:** on the Mac, open **System Settings → General → Sharing**, select the info button next to **Remote Login**, and turn on **Allow full disk access for remote users**. Reconnect afterwards; an open SSH session keeps its old permissions.
- **In a local terminal:** add the terminal app under **System Settings → Privacy & Security → Full Disk Access**, then relaunch it.

Without access, `tuimsg` shows these steps instead of an empty inbox. Press `Shift+R` to retry.

Sending also needs **Automation → Messages**. macOS asks the first time a message is sent; approve the prompt on the Mac, or enable it later under **System Settings → Privacy & Security → Automation**. A send that fails with "not authorized to send Apple events" is missing this grant.

Contact names come from imsg. Over SSH it reads the Mac's AddressBook database using the same Full Disk Access, so names need no extra prompt. In a local terminal it uses the Contacts permission; if names are missing, run `imsg chats --limit 1` once in that terminal and allow Contacts access.

## Using it over SSH from Windows

Windows Terminal with the built-in OpenSSH client works well. SSH in as usual and run `tuimsg`. To start it in one step, allocate a terminal and use a login shell:

```sh
ssh -t your-mac 'zsh -ilc tuimsg'
```

A plain `ssh your-mac tuimsg` gets no terminal, and `tuimsg` exits with a reminder to add `-t`. Even with `-t`, a remote command runs in a shell that skips `~/.zprofile` and `~/.zshrc`, where Homebrew and Bun usually add themselves to `PATH`; `zsh -ilc` loads them.

For a session that survives dropped connections, run `tuimsg` inside `tmux` on the Mac and reattach after reconnecting. `ServerAliveInterval 30` in your SSH config keeps idle connections from being cut by routers.

Things that behave differently in a remote terminal:

- **New lines:** press `Ctrl+J`. Over SSH, `Shift+Enter` arrives as a plain `Enter` and sends the message, and Windows Terminal uses `Alt+Enter` for full screen.
- **Copying:** `y` copies the selected message through OSC 52. Windows Terminal supports it, as do most modern terminals; some, such as iTerm2, need clipboard access enabled in their settings. PuTTY does not support it, and `tuimsg` cannot detect that, so it still reports "Copied." In tmux, enable `set -g set-clipboard on` and `set -g allow-passthrough on`. To select part of a message with the mouse, hold `Shift` while dragging in Windows Terminal and most other terminals.
- **Attachments:** files live on the Mac. `o` and `s` save a copy under `~/.config/tuimsg/attachments` and show its path; fetch it with `scp your-mac:<path> .`. In a local session on the Mac, `o` opens the original in its app.
- **Read state:** leaving a conversation open marks new messages in it as read, even when your terminal is minimized or tmux is detached.
- **Image previews:** Windows Terminal shows color half-block previews. Native bitmap images need a Kitty-compatible terminal that is detected through `TERM=xterm-kitty`, because SSH does not forward the variables that identify WezTerm or Ghostty.

Output is incremental, so a keystroke usually redraws only the lines that changed. Animated GIFs keep redrawing while they are on screen, which uses more bandwidth on slow links.

## imsg's bridge

Reading, watching, and sending text need only the permissions above. Replies, reactions, read receipts, typing indicators, and group creation use imsg's IMCore bridge, which injects a helper into Messages.app and requires SIP to be disabled. See imsg's [Advanced IMCore guide](https://github.com/openclaw/imsg/blob/main/docs/advanced-imcore.md). Start the bridge with `imsg launch`, then press `Shift+R` in the conversation list; the status bar shows `bridge` when it is available.

Without the bridge, those keys explain what is missing instead of failing later. Opening a conversation still clears its unread marker in `tuimsg`, but your other devices keep theirs.

## Keyboard controls

| Context | Keys | Action |
|---|---|---|
| Conversation list | `j` / `k`, arrows | Move the highlight |
| Conversation list | `Enter` | Open the highlighted conversation |
| Transcript | `j` / `k`, arrows | Select a message |
| Transcript | `i`, `Enter` | Focus the composer |
| Composer | `Enter` | Send |
| Composer | `Ctrl+J` | Insert a newline |
| Composer | `Esc` | Return to the transcript |
| Transcript | `Esc` | Return to the list |
| Panes | `Tab` | Change focus |
| Outside composer | `/`, `n`, `?` | Search, new conversation, help |
| Transcript | `y`, `r`, `t`, `a` | Copy, reply, react, choose an attachment |
| Transcript | `v`, `o`, `s` | Expand an image, open, save the selected message's attachment |
| Conversation list | `Shift+R` | Reload conversations, or restart imsg if it stopped |
| Transcript | `g`, `Shift+R`, `m` | Load older history, retry history, retry marking read |
| Transcript | `!` | Retry the selected failed or uncertain send |
| New conversation | `Tab`, `Ctrl+T`, `Ctrl+S` | Change field, switch service, send first message |
| Attachment chooser | `j` / `k`, `v` / `Enter`, `s`, `o` | Select, preview, save, open |
| Image viewer | `o`, `s`, `Esc` | Open original, save original, close |
| Outside composer | `q` | Quit |
| Anywhere | `Ctrl+C` | Quit |

Search filters conversation titles and their latest message previews. A new conversation needs a recipient and a first message; messaging one phone number or email address works without the bridge.

## Sending safely

Drafts and unresolved sends are stored in `~/.config/tuimsg` (or `TUIMSG_HOME`), and each send is recorded there before it starts. imsg reports when a send's outcome is unknown, for example when Messages accepted it but did not record it in time. `tuimsg` marks such a message "Delivery uncertain" and asks before retrying, because a second attempt could send twice. If the message does appear in the database, the mark clears on its own.

imsg refuses further sends while an earlier one may still be in flight. Check Messages, then press `Shift+R` in the conversation list to restart imsg.

If imsg exits, `tuimsg` restarts it and resumes from the last message it saw, so nothing that arrived in between is skipped.

## Images

Received photos appear inline with their messages. Press `v` on an image message for a larger view, or `a` to choose among all its attachments. Press `o` to open the original or `s` to save it.

PNG, JPEG, WebP, and GIF previews decode locally. GIFs animate while visible. HEIC photos use the macOS image converter when the bundled decoder cannot read them. Attachments that Messages keeps only in iCloud show as not downloaded; open them once in Messages on the Mac. An unsupported or corrupt preview keeps the original available to open or save.

Kitty-compatible terminals use native bitmap images. Other terminals, including iTerm2 and tmux sessions, use color half-block previews. Native previews are limited to 2560 pixels on the longest side; opening or saving preserves the original file. Previews decode files up to 32 MB and 40 million pixels. GIFs exceeding 60 frames or a total 40-million-pixel animation budget show a still frame.

Message text, names, and filenames are cleaned of terminal control characters before display, so a message cannot ring the bell, move the cursor, or hide a link's destination.

## Development and verification

```sh
bun run typecheck
bun run test
bun run test:colors
bun run build
bun run smoke
bun run smoke:images
```

The tests cover the domain, the imsg JSON-RPC client and parser, the session against an in-memory imsg, persistence, and Ink input and rendered frames. `--fake` runs the same program as its own imsg child, so the smoke tests exercise the real stdio path without a Mac. The smoke test needs a Bun release with `Bun.Terminal` support. It launches the compiled app in a real PTY and checks sends, text and Enter arriving in one read, `Ctrl+J`, recipient-specific drafts, search, resize, and terminal restoration. Test artifacts are written under `.audit/pty`.

`test:colors` captures the full Ink interface at 80 and 180 columns with 256-color output. It checks for unpainted cells on a white terminal background and writes ANSI, SVG, and PNG previews under `.audit/colors`. The palette tests also cover 16-color and truecolor output.

`smoke:images` checks local attachment previews, both rendering paths, expanded viewing, byte-for-byte original saving, resize, and cleanup through the compiled app. Its native check verifies the generated Kitty protocol; it does not substitute for viewing the result in a compatible terminal.

Local tests do not replace trying it against your own Messages database. They never send real messages.
