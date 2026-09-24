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
- **Links:** links are clickable: hold `Ctrl` and click one to open it in your browser. Windows Terminal supports this even while `tuimsg` uses the mouse. `o` on a message with a link copies the link to your clipboard, since a browser started on the Mac would open there, not in front of you. In a local session on the Mac, `o` opens it in your default browser.
- **Attachments:** files live on the Mac. `o` and `s` save a copy under `~/.config/tuimsg/attachments` and show its path; fetch it with `scp your-mac:<path> .`. In a local session on the Mac, `o` opens the original in its app.
- **Read state:** leaving a conversation open marks new messages in it as read, even when your terminal is minimized or tmux is detached.
- **Window edges:** Windows Terminal draws padding around the text grid, plus a sliver where the window is not a whole number of rows and columns. `tuimsg` colors them to match the theme while it runs. To remove the padding, set it to 0 under **Settings → your profile → Appearance → Padding**.
- **Image previews:** Windows Terminal 1.22 and later shows full-resolution photos through sixel. `tuimsg` asks the terminal at startup whether it supports sixel and how many pixels a cell holds, so this also works over SSH. Older Windows Terminal releases, tmux without sixel support, and terminals that don't answer get color half-block previews. See [Images](#images).

`tuimsg` sends only the characters that changed on screen, and each update leaves as a single write, so a keystroke typically costs tens to a few hundred bytes. A photo preview is the expensive part: about 100 KB as sixel, sent again whenever the conversation shifts under it (a new message, a longer draft). When the terminal takes more than 250 ms to answer at startup, as over a slow or distant link, previews start as colored blocks (about 8 KB) instead. `TUIMSG_IMAGES=sixel` brings photos back; `TUIMSG_IMAGES=blocks` keeps blocks on any link. Animated GIFs keep redrawing while they are on screen in block mode.

imsg answers every request from one database connection, one query at a time, so `tuimsg` keeps its own background work out of the way. It lists the first 60 conversations first, then the rest. It fetches each conversation's latest message for the list one at a time, and pauses that whenever a conversation you open, or a message you send, is waiting on imsg. For merged conversations, which can switch between iMessage and SMS, it checks which service the latest message used for the 40 at the top of the list. The others are checked when opened or when a message arrives.

## imsg's bridge

Reading, watching, and sending text need only the permissions above. Replies, reactions, read receipts, typing indicators, and group creation use imsg's IMCore bridge, which injects a helper into Messages.app and requires SIP to be disabled. See imsg's [Advanced IMCore guide](https://github.com/openclaw/imsg/blob/main/docs/advanced-imcore.md). Start the bridge with `imsg launch`, then press `Shift+R` in the conversation list; the status bar shows `bridge` when it is available.

Without the bridge, those keys explain what is missing instead of failing later. Opening a conversation still clears its unread marker in `tuimsg`, but your other devices keep theirs.

## Reading the screen

Conversations are on the left; the newest is at the top, a blue dot marks unread ones, and SMS conversations are tagged in green. Every message hangs off a bar on its left: blue for yours, gray for theirs, and a steady color for each person in a group. A run of messages from one person shares one bar. The selected message's bar turns solid, and reactions sit at the right of the message they react to. The bottom line shows the keys for whatever has focus, starting with what the selected message offers, such as `o open link`; `?` lists them all. Messages such as "Copied." or where an attachment was saved take its place for five seconds (errors for ten), or until the next key.

## Light and dark

Press `Shift+L` outside the composer to switch between a light and a dark theme. The choice is saved in `~/.config/tuimsg/settings.json` (under `TUIMSG_HOME` when set). Until you choose, `tuimsg` asks the terminal for its background color at startup and matches it, falling back to dark when the terminal does not answer. `TUIMSG_THEME=light`, `dark`, or `auto` overrides the saved choice.

Both themes use the xterm 256-color palette, so an SSH session without truecolor draws exactly the same colors as a local one.

While `tuimsg` runs, the terminal's own default colors follow the theme (OSC 10 and 11). Terminals paint their padding, and the strip left over when a window is not a whole number of rows and columns, in that default color rather than the app's, so without this a light theme would sit in a black frame. Quitting restores the colors the terminal reported at startup, then asks it to return to its profile's colors (OSC 110 and 111). If the SSH connection drops first, that tab keeps the theme's colors until you run `tuimsg` again and quit, or open a new tab.

## Keyboard controls

| Context | Keys | Action |
|---|---|---|
| Conversation list | `j` / `k`, arrows | Move the highlight |
| Conversation list | `Enter` | Open the highlighted conversation |
| Transcript | `j` / `k`, arrows | Select a message |
| Transcript | `i`, `Enter` | Focus the composer |
| Composer | `Enter` | Send |
| Composer | `Ctrl+J` | Insert a newline |
| Composer | `↑`, `↓` | Move a row up or down in a long draft |
| Composer | `Esc` | Return to the transcript |
| Transcript | `Esc` | Return to the list |
| Panes | `Tab` | Change focus |
| Outside composer | `/`, `n`, `?` | Search, new conversation, help |
| Transcript | `y`, `r`, `t`, `a` | Copy, reply, react, choose an attachment |
| Transcript | `o` | Open the selected message's link (over SSH, copy it), else its attachment |
| Transcript | `v`, `s` | Expand an image, save the selected message's attachment |
| Conversation list | `Shift+R` | Reload conversations, or restart imsg if it stopped |
| Transcript | `g`, `Shift+R`, `m` | Load older history, retry history, retry marking read |
| Transcript | `!` | Retry the selected failed or uncertain send |
| New conversation | `Tab`, `Ctrl+T`, `Ctrl+S` | Change field, switch service, send first message |
| Attachment chooser | `j` / `k`, `v` / `Enter`, `s`, `o` | Select, preview, save, open |
| Image viewer | `o`, `s`, `Esc` | Open original, save original, close |
| Outside composer | `Shift+L` | Switch between light and dark |
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

How a photo is drawn depends on the terminal:

- **Kitty graphics:** kitty, Ghostty, and WezTerm, recognized from `TERM=xterm-kitty` or `TERM=xterm-ghostty` (both survive SSH) or from the local environment. Native previews are limited to 2560 pixels on the longest side.
- **Sixel:** terminals that report sixel support (attribute 4 of their device attributes) and their cell size in pixels, such as Windows Terminal 1.22+, foot, WezTerm, and mlterm. Each picture is quantized to 256 colors and sent one text row at a time, so when other parts of the screen redraw, only the rows they touch are sent again. A 48 × 10 cell preview is roughly 100 to 150 KB. Animated GIFs show their first frame.
- **Half blocks:** everything else, including tmux builds without sixel. Each cell shows two colored pixels.

Over a link that takes more than 250 ms to answer the startup probe, previews use blocks. Set `TUIMSG_IMAGES=kitty`, `sixel`, or `blocks` to override the choice. Opening or saving always uses the original file. Previews decode files up to 32 MB and 40 million pixels. GIFs exceeding 60 frames or a total 40-million-pixel animation budget show a still frame.

Message text, names, and filenames are cleaned of terminal control characters before display, so a message cannot ring the bell, move the cursor, or hide a link's destination. A link's text is always its own address, so what you click is what you see.

## Benchmark log

When something feels slow, run it with `--benchmark` and use it as usual:

```sh
tuimsg --benchmark              # writes tuimsg-benchmark-<date>-<time>.log here
tuimsg --benchmark ~/slow.log   # or to a file you name
```

Press `F12` at the moment something lags; it drops a `MARK` line into the log. Quitting prints the log's path. The log is written as the app runs, and its summary is added at the end, including when the SSH link drops.

The log records:

- **Startup**, from launch to first frame, imsg online, and the conversation list loaded, and how long the terminal took to answer its startup probe (over SSH, about the link's round trip).
- **Every key**, from when it was read to when its update left for the terminal. It also records the time taken to handle the key, the time Ink took to render the frame, the time the cell diff took, and the bytes sent. Keys that changed nothing on screen are listed as such.
- **Every imsg request and event**, with its time and size, and any timeouts or failures.
- **Pictures and attachments**, with their load and decode times and sixel sizes.
- **Terminal writes** that hold the program for over 20 ms, as a large write can while the SSH link catches up.
- **Event-loop stalls** over 100 ms, memory each minute, and a summary with medians, 95th percentiles, and the slowest keys.

It holds timings, sizes, and counts only. It never records message text, names, phone numbers, or addresses. Keys typed into the composer, search, or new-conversation fields are logged only as `typing`. Notices are logged by kind, not text. If the app crashes, the error message is included with the home directory, addresses, and numbers removed. The log shows the machine's CPU, the OS version, the terminal's `TERM`, `TERM_PROGRAM`, and `COLORTERM` settings, and the git commit being run. Read it before sharing.

## Development and verification

```sh
bun run typecheck
bun run test
bun run test:colors
bun run build
bun run smoke
bun run smoke:images
bun run smoke:benchmark
```

The tests cover the domain, the imsg JSON-RPC client and parser, the session against an in-memory imsg, persistence, and Ink input and rendered frames. `--fake` runs the same program as its own imsg child, so the smoke tests exercise the real stdio path without a Mac. The smoke test needs a Bun release with `Bun.Terminal` support. It launches the compiled app in a real PTY and checks sends, text and Enter arriving in one read, `Ctrl+J`, recipient-specific drafts, search, resize, and terminal restoration. Test artifacts are written under `.audit/pty`.

`bun run build` bundles the app, Ink and React included, into `dist/cli.js` with React's production build (see `scripts/build.ts`); only sharp stays outside, since it loads a native library. The build also remembers string widths, which Ink recomputes for every line of every frame, and skips a style comparison Ink makes for every cell. It keeps Ink's caches of each line's parsed styles from one frame to the next; Ink rebuilt them for every frame, which doubled the cost of a frame with photos on screen. A test checks that the patched Ink produces the same frames as the original.

The terminal writer diffs Ink's frames cell by cell (`src/frame-diff.ts`). Its tests replay the output through a terminal model and check that every update leaves exactly the screen a full redraw would, for the whole app as well as for wide characters, hyperlinks, and resizes.

`test:colors` captures the full Ink interface in both themes at 80 and 180 columns with 256-color output. It checks that every cell paints its own background, so neither theme shows the terminal's default through, and writes ANSI, SVG, and PNG previews under `.audit/colors`. The palette tests also cover 16-color and truecolor output, check that 256-color and truecolor terminals draw the same colors, and check text contrast.

`smoke:images` checks local attachment previews, all three rendering paths, expanded viewing, byte-for-byte original saving, resize, and cleanup through the compiled app. Its sixel run answers the startup probe the way Windows Terminal does. The unit tests check sixel output by decoding it back to pixels, and replay the app's output through a model of Windows Terminal's sixel rules to confirm that every preview stays whole as the screen redraws and nothing stale is left behind. None of this substitutes for viewing the result in a real terminal.

`smoke:benchmark` runs the compiled app with `--benchmark` in a PTY and checks that the log has its timeline and summary, and that nothing typed, and no name, number, or message text from the demo, reaches it.

Local tests do not replace trying it against your own Messages database. They never send real messages.
