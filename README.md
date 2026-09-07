# imsg

A terminal Messages window for a Mac running [BlueBubbles](https://bluebubbles.app). The npm package is `tuimsg`. The command is `imsg`.

## Install

Install [Bun](https://bun.sh) 1.3.14 or newer and put it on your `PATH`. The launcher is a Bun script. Node cannot run it.

Start BlueBubbles on the Mac.

```sh
npx tuimsg
```

Or install the command:

```sh
npm install -g tuimsg
imsg
```

`npx imsg` is a different package. Use `npx tuimsg`.

## Setup

On first launch, enter the BlueBubbles server address and password. A bare address uses HTTP on port `1234`. Use a full `https://` URL for TLS or a different port.

`imsg` writes `~/.config/imsg/config.json` and stores the password in macOS Keychain. Run `imsg --setup` to change the server.

On Linux it uses Secret Service (GNOME Keyring or KWallet). If that is unavailable, you can save the password in the config file (`0600`, not encrypted) or keep it for this session only.

The BlueBubbles API puts the password in the request query string. Use HTTPS when the server is not on localhost.

For scripts, set `IMSG_PASSWORD` and optionally `IMSG_URL` (default `http://127.0.0.1:1234`). `IMSG_CONFIG` selects a different config file.

## Run

```sh
imsg
imsg --setup
imsg --fake
imsg --help
```

`imsg` uses the saved login. `--setup` changes the server. `--fake` uses demo data and does not need BlueBubbles. Press `?` for keys. Quit with `q` or `Ctrl+C`. Copy uses OSC 52. Attachments save on the computer running `imsg`.

Reactions, typing indicators, and mark-read need the BlueBubbles Private API helper. Send and receive work without it.

Drafts and unfinished sends live in `~/.config/imsg/sessions/`.

## From a checkout

```sh
bun install
bun run imsg --fake
bun run imsg
```

## Publish

```sh
npm publish
```

You need an npm account that can publish `tuimsg`. Bun must be on `PATH` so `prepack` can build `dist/cli.js`.

## License

MIT
