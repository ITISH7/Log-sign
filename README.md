# DSR Creator

DSR Creator is a local-first Windows and Linux desktop application for recording daily work and turning selected entries into a reusable report format. A template is imported or described once, compiled into a compact blueprint, versioned, and reused without repeatedly sending the original format to an AI provider.

## What works

- Multiple daily updates with project, status, duration, blockers, links, tags, and custom fields
- Searchable date history with editing and confirmed deletion
- DOCX, XLSX, Markdown, CSV, and TXT template samples plus written instructions
- Immutable template versions, defaults, duplication, and deliberate rollback
- OpenAI Responses API, Anthropic Messages API, Codex App Server, and Claude Code profiles
- Deterministic offline reports for direct field mappings
- Token estimates, 75% context threshold, per-day chunking, selective hashes, and cached summaries
- Editable report drafts with XLSX, DOCX, PDF, Markdown, CSV, JSON, and TXT export
- SQLCipher storage, OS-vault credentials, passphrase fallback, automatic snapshots, and Argon2id/AES-GCM portable backups

## Development

Requirements: Node.js 22+, npm 10+, and the native build toolchain for Electron modules.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

The repository path must not end in a space when rebuilding native Electron modules. See [installation and packaging](docs/INSTALL.md) for OS-specific commands.

## Privacy model

Daily capture, template storage, preview editing, deterministic generation, and export are local. AI is contacted only when the active blueprint has narrative rules or when the user deliberately selects an AI profile to compile a template. The Generate screen states the selected date range and compact template information before generation. DSR Creator never selects a fallback provider.

See [SECURITY.md](SECURITY.md) for the trust boundaries and backup behavior.

