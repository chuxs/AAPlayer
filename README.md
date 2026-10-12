# AAPlayer

<img src="build/icon.png" alt="AAPlayer icon" width="96" align="right">

A desktop media player modelled on VLC, built with **Electron**, Chromium's media stack and **FFmpeg**.
It has VLC's menus, keyboard shortcuts and supported formats. It was also built to avoid a VLC problem
where some "10bit" videos freeze the player until it has to be killed from Task Manager.

- Plays almost anything VLC plays: MKV, MP4, AVI, TS, WebM, DVD/Blu-ray folders, network streams and capture devices
- 10-bit HEVC and H.264 ("Hi10P"), HDR tone mapping and hardware decoding, with automatic recovery if decoding stalls
- VLC-style menus, toolbar and shortcuts, a playlist, subtitles, audio/video effects, an equalizer, conversion and recording
- A web remote and home-network streaming, both protected by a PIN and turned off until you enable them

> **Status:** early version (0.1.0). Windows 10/11 (x64) is the tested platform. macOS and Linux may run
> from source but have not been tested.

---

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Setup](#setup)
- [Run](#run)
- [Build an installer](#build-an-installer)
- [Tests](#tests)
- [Technologies used](#technologies-used)
- [Features](#features)
- [The "10bit" problem](#the-10bit-problem)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Built with Claude](#built-with-claude)
- [License](#license)

---

## Quick start

```sh
git clone https://github.com/chuxs/AAPlayer.git
cd AAPlayer
npm install
npm start
```

## Requirements

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 20 or newer (22 LTS recommended) | Comes with `npm` |
| [Git](https://git-scm.com/) | any recent | To clone the repository |
| Internet connection | for `npm install` | Downloads Electron and the bundled FFmpeg binaries |
| FFmpeg | optional | A matching FFmpeg/ffprobe 6.1 is bundled. If a newer `ffmpeg` is on your `PATH`, AAPlayer uses it automatically |

A GPU with hardware video decoding (Intel, NVIDIA or AMD) is recommended for 4K and 10-bit HEVC. It is not
required.

## Setup

1. **Clone the repository**

   ```sh
   git clone https://github.com/<your-username>/AAPlayer.git
   cd AAPlayer
   ```

2. **Install dependencies.** This downloads Electron, electron-builder and the FFmpeg binaries:

   ```sh
   npm install
   ```

That's it. No other configuration is needed.

## Run

```sh
npm start                                  # open AAPlayer
npm start -- "C:\Videos\movie.mkv"         # open AAPlayer with a file (or several files / a folder)
```

`npm start` works from any terminal, including the VS Code terminal (see
[Troubleshooting](#troubleshooting)).

Once it's open, press **F1** for help and keyboard shortcuts, or drop files onto the window.

## Build an installer

```sh
npm run dist        # Windows installer  ->  dist/AAPlayer Setup <version>.exe
npm run dist:dir    # unpacked app only   ->  dist/win-unpacked/AAPlayer.exe  (faster, good for testing)
```

The installer lets you choose the install folder. It also registers AAPlayer as an "Open with" option for
common video and audio types. The build is not code-signed, so Windows SmartScreen may show a warning the
first time you run it ("More info" → "Run anyway").

Optional asset scripts, needed only if you change the logo or the menu icons:

```sh
npm run icon         # renders build/icon.png
npm run menu-icons   # renders src/main/menu-icons/{dark,light}/*.png
```

## Tests

```sh
npm test
```

The tests use Node's built-in test runner (`node --test`). They cover:
- the playback planner, including 10-bit, HDR and remux decisions
- ffprobe parsing and the WebVTT subtitle parser
- the convert and disc helpers
- the security of the web remote and the streaming server (PIN login, rate limiting, Host/Origin checks)
- the OpenSubtitles client, run against a local mock server

No network access is needed.

---

## Technologies used

| Area | Technology |
|---|---|
| Desktop app shell | [Electron](https://www.electronjs.org/) 44 (Chromium 152, Node.js 24) |
| UI | Plain HTML, CSS and JavaScript (no framework), inline SVG icons |
| Playback | Chromium `<video>` with [Media Source Extensions](https://developer.mozilla.org/docs/Web/API/Media_Source_Extensions_API) and hardware decoding (D3D11) |
| Decoding, remuxing, transcoding | [FFmpeg / ffprobe](https://ffmpeg.org/), bundled with [`ffmpeg-ffprobe-static`](https://www.npmjs.com/package/ffmpeg-ffprobe-static) |
| Hardware encoding | Intel Quick Sync (QSV), NVIDIA NVENC, AMD AMF, falling back to x264/x265 on the CPU |
| Audio effects | Web Audio API: 10-band equalizer with VLC's presets, stereo modes, delay, 200% volume, visualizations |
| Video effects | CSS and SVG filters, Canvas 2D |
| Local and network servers | Node.js `http` (media server on 127.0.0.1, web remote, home-network streaming) |
| Subtitles | FFmpeg converts SRT/ASS/SSA/… to WebVTT, rendered by a small custom parser |
| Online subtitles | [OpenSubtitles.com REST API](https://opensubtitles.stoplight.io/) (VLsub) |
| Packaging | [electron-builder](https://www.electron.build/) (NSIS installer) |
| Tests | Node.js built-in test runner |
| Reference | [VLC media player](https://www.videolan.org/) source code (menus, shortcuts, jump sizes, speed steps, format lists, equalizer presets) |

---

## Features

**Opening media**
- Open File, Multiple Files, Folder (recursive), Disc (unprotected DVD/Blu-ray), Network Stream (HTTP, HLS,
  RTSP and more), Capture Device (webcam, capture card, microphone), and Location from clipboard
- Drag and drop, command line, "Open with", recent media (can be turned off)

**Playback**
- Picks the best path per file: plays it directly, remuxes it (no video re-encode), or converts it to
  8-bit H.264 when needed
- Watchdog: if playback stalls or fails, AAPlayer restarts it and falls back to a compatible mode instead
  of freezing
- Resume where you left off, chapters, seek-bar thumbnails, speed 0.25×–8×, frame stepping, A→B loop,
  loop/random, quit at the end of the playlist

**Audio and video**
- Audio track and output device selection, stereo modes, a 10-band equalizer with VLC presets, volume up
  to 200%, visualizations
- Video track, aspect ratio, crop, zoom, deinterlacing (Bwdif/Yadif/W3FDIF), image adjustments,
  rotate/flip, snapshots, set a frame as wallpaper

**Subtitles**
- Embedded and external subtitle files, delay and size controls; image subtitles (PGS/VobSub) are burned
  into the picture
- **VLsub:** search and download from OpenSubtitles. This needs your own free API key, and nothing is sent
  until you press Search

**Tools**
- Convert / Save: H.264 or HEVC MP4, remux to MKV/MP4, MP3/AAC/Opus/FLAC, with trimming and progress
- Record: saves the part you watched, or a capture device
- Media and Codec Information (shows why a file plays the way it does), Messages log, Preferences,
  Customize Interface

**Remote and streaming** (both off by default)
- **Web remote** (View › Add Interface): control playback from a browser. Only works from this PC unless
  you allow other devices, and always needs a 6-digit PIN
- **Stream / VLM** (Media › Stream…): send media to TVs and phones on your home network through a secret
  link plus a PIN

**Privacy**
- No history on the start screen. Tools › Remember Recent Media and Remember Playback Position can be
  turned off, which also deletes what was stored.
- The camera and microphone are only used after you pick a device in Open Capture Device.

**Interface**
- VLC-style menus with icons (light and dark), VLC's Windows keyboard shortcuts, fullscreen and minimal
  modes, advanced controls, status bar, docked or floating playlist

---

## The "10bit" problem

Some videos with `10bit` in their name freeze VLC near the start, and VLC has to be killed from Task
Manager. **The file name is not the cause.** VLC never looks at it. Release groups add `10bit` because the
video itself is 10-bit: usually HEVC Main 10, or H.264 High 10 ("Hi10P").

**Likely cause in VLC.** With hardware decoding on Windows, decoded frames live in a fixed pool of GPU
surfaces. 10-bit HEVC uses the most of them: reference frames, plus decoder threads, plus frames waiting
to be shown. In the VLC 4 source (`modules/codec/avcodec/va_surface.c`), `va_pool_Get()` waits for a free
surface **with no time limit**, even though its documentation says it returns on timeout. When the pool
runs out, typically while buffering at the start or after a seek, the decoder waits forever. Stop and
close then wait on the decoder, so the whole player freezes.

A proposed fix for VLC is in
[`patches/0001-avcodec-va_surface-bound-surface-wait.patch`](patches/0001-avcodec-va_surface-bound-surface-wait.patch).
It makes the wait time out after 1 second, so one frame is dropped instead of the player locking up. The
patch has not been compiled or tested. To try it, apply it to a VLC source checkout with `git apply`. The
VLC source is not included in this repository.

**How AAPlayer avoids it:**
1. It decides from the video stream itself (`ffprobe`: codec, bit depth, chroma, HDR), never the file name.
2. Decoding runs outside the UI, in an FFmpeg process or Chromium's media process, so a stuck decoder can't
   freeze the window.
3. A watchdog restarts stalled playback and, if needed, switches to converting the video to standard 8-bit
   H.264.

It also works around a Chromium display bug on some Intel GPUs that shows white specks in dark areas of
10-bit video (Preferences › 10-bit display fix).

---

## Project structure

```
src/
  main/            Electron main process
    main.js          window, IPC, menus, app lifecycle
    planner.js       direct / remux / transcode decision, FFmpeg arguments
    probe.js         ffprobe -> media info (bit depth, chroma, HDR, ...)
    ffmpeg-tools.js  finds FFmpeg, detects working hardware encoders
    media-server.js  local 127.0.0.1 media server (file ranges, streams, thumbnails)
    menu.js          VLC-style menu bar (+ menu-icons/)
    convert.js       Convert / Save
    disc.js          DVD / Blu-ray folders and drives
    remote-server.js web remote          stream-server.js  home-network streaming (VLM)
    opensubtitles.js VLsub client        net-security.js   PINs, rate limiting
    store.js         settings, recent media, resume positions
  preload/         secure bridge between the UI and the main process
  renderer/        UI: app.js (controls, dialogs, shortcuts), engine.js (playback, watchdog),
                   audiofx.js, videofx.js, visualizer.js, presenter.js
  remote/          the web remote page
  shared/vtt.js    subtitle parser
scripts/           dev launcher, icon generators
test/              unit tests
patches/           proposed VLC fix
build/             app icon
```

## Troubleshooting

| Problem | Fix |
|---|---|
| The window doesn't open from the VS Code terminal | VS Code sets `ELECTRON_RUN_AS_NODE`. Use `npm start`, which clears it, rather than running `electron .` directly. |
| "FFmpeg problem" message | Run `npm install` again, or point Tools › Preferences › ffmpeg/ffprobe path to your own FFmpeg. |
| Windows Firewall prompt | Expected the first time you allow the web remote on other devices or start a stream. Allow it on private networks only. |
| A file stutters or won't play | Check Tools › Codec Information (Ctrl+J), or try Video › Decoding Mode › Compatibility. |
| SmartScreen warning when installing | The installer isn't code-signed. Choose "More info" → "Run anyway". |

## Limitations

- AAPlayer is not a port of VLC's C engine. Playback uses Chromium plus FFmpeg.
- No DVD/Blu-ray menus, and copy-protected discs are not supported.
- ASS/SSA subtitles show basic styling only (italic/bold/underline), with no positioning or karaoke.
- Audio sync can only delay audio (0–10 s).
- "Set as Wallpaper" sets the current frame as the desktop picture (VLC plays the video itself as the
  wallpaper).
- Casting renderers (Chromecast) are not implemented.

## Built with Claude

AAPlayer was created with the help of **[Claude](https://www.anthropic.com/claude)**, Anthropic's AI
assistant, using **[Claude Code](https://www.anthropic.com/claude-code)**. Claude helped with:
- researching VLC's source and the "10bit" freeze
- designing and writing the code and tests
- debugging the app by driving it and checking screenshots

All of it was directed and reviewed by the project author.

## License

[GPL-2.0-or-later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html). Behaviour, keyboard shortcuts,
format lists and equalizer presets follow VLC media player by the VideoLAN team. AAPlayer is not affiliated
with or endorsed by VideoLAN. FFmpeg is licensed under the LGPL/GPL; see the bundled FFmpeg license file.
# AAPlayer
