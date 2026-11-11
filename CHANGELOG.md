# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-11

### Added
- `tgcli` command with `send`, `photo`, `video`, `doc`, `audio`, `album`,
  `edit`, `edit-caption`, `delete`, `forward`, `copy`, `pin`, `unpin`.
- Inspection commands: `me`, `chat`, `member`, `download`, `log`, `stats`.
- `listen` long-polls updates and writes them into the same ledger as outgoing
  messages, giving a record the Bot API itself does not provide.
- Append-only JSONL ledger with deletion marking and an update cursor.
- JSON envelope output with stable exit codes (`0` ok, `1` runtime, `2` usage,
  `3` Telegram API error).
- Automatic retry on `429` (honouring `retry_after`) and `5xx`.
