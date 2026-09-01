# Installation and packaging

## Install a release

### Windows 10/11 x64

Download `DSR-Creator-<version>-Windows-x64.exe`, verify its SHA-256 value against `SHA256SUMS.txt`, and run it. The v1 installer is unsigned, so Windows may show a SmartScreen warning. Choose the installation directory when prompted.

### Debian or Ubuntu x64

Download the `.deb`, verify its SHA-256 value, then run:

```bash
sudo apt install ./DSR-Creator-<version>-Linux-x64.deb
```

### Other Linux x64 distributions

Download the AppImage, verify its SHA-256 value, then run:

```bash
chmod +x DSR-Creator-<version>-Linux-x86_64.AppImage
./DSR-Creator-<version>-Linux-x86_64.AppImage
```

Some distributions require the FUSE 2 compatibility package. AppImage support outside mainstream Debian/Ubuntu systems is best effort.

## AI profile setup

- OpenAI API: create a profile, enter an API key, model ID, and known context limit, then choose Test.
- Anthropic API: create a profile with an Anthropic API key and model ID, then choose Test.
- Codex subscription: install the official Codex CLI, create a Codex subscription profile, then choose Connect with ChatGPT. DSR Creator opens the browser flow exposed by the local Codex App Server. The vendor runtime is not bundled.
- Claude subscription: install and authenticate the official Claude Code client, create a Claude subscription profile, and choose Test. The vendor runtime is not bundled.

An unavailable runtime or expired authentication produces an actionable profile error. It never causes another profile to receive the report.

## Build release artifacts

Use a normal path without trailing spaces and install the platform-native build requirements first.

```bash
npm ci
npm run verify
npm run dist:linux
```

Build the NSIS package on Windows:

```powershell
npm ci
npm run verify
npm run dist:windows
```

Artifacts are written to `dist/`. The GitHub Actions release workflow builds on native Windows and Ubuntu runners and creates `SHA256SUMS.txt` files.

