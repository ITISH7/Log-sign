# Architecture

The application has four trust layers:

1. The sandboxed React renderer captures intent and displays sanitized structured data.
2. The allowlisted preload bridge maps UI actions to namespaced Electron IPC calls.
3. The Electron main process owns SQLCipher, credentials, file dialogs, exporters, reminders, backups, network SDKs, and official subscription runtimes.
4. Provider adapters return a validated provider-neutral `ReportDraft`; exporters never depend on provider output text directly.

Templates are stored as immutable versions. Each version owns its encrypted source sample and validated `TemplateBlueprint`. Report cache keys include canonical entry data, the template version, profile, model, prompt version, and blueprint schema. Editing one entry changes only hashes that depend on that entry; unchanged daily summaries are reused during large reductions.

Deterministic templates bypass AI. Narrative templates estimate input locally and switch to per-day map/reduce at 75% of the configured context limit. Unknown limits use 32,768 tokens. Provider errors, invalid JSON after one constrained repair, cancellation, and export errors leave entries and saved drafts intact.

