# Security model

## Local data

The database uses SQLCipher with a random 256-bit key. Windows and secure Linux environments wrap that key with Electron secure storage backed by the OS credential service. If Linux reports no secure storage or the insecure `basic_text` backend, DSR Creator does not create an insecure key file; it requires a 12-character-or-longer passphrase on every launch and derives the database key with scrypt.

API credentials are stored in the OS-backed encrypted secret store. In passphrase mode they are stored only inside the SQLCipher database. Credentials are never returned to the renderer or included in generation history.

## Process boundaries

The renderer is sandboxed with context isolation enabled and Node integration disabled. Its Content Security Policy denies network connections, frames, objects, and form submission. The preload bridge exposes only named DSR operations. Database, filesystem, credential, child-process, and network access remain in the main process.

Codex App Server and Claude Code generation run in a newly created empty temporary workspace. Codex turns use `approvalPolicy: never` and restricted read-only sandbox access. Server-initiated tool or approval requests are rejected. Claude Code runs without tools and without session persistence. Temporary workspaces are removed after each request.

## Backups

Automatic snapshots retain seven recent daily files and four older weekly representatives. Since the source is SQLCipher, automatic snapshots remain encrypted. Portable `.dsrbackup` files add independent Argon2id-derived AES-GCM encryption. Restore decrypts to a temporary file, validates it with the current database key, retains a pre-restore safety database, atomically installs the restored database, and restarts the application.

## Reporting a vulnerability

Do not include API keys, passphrases, database files, report contents, or portable backups in an issue. Provide a minimal reproduction with synthetic content and the affected version.

