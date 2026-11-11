# tgcli

A Telegram Bot API CLI that keeps its own ledger.

The Bot API has no method to page through a chat's history — updates are delivered once, and anything older than 24 hours is gone. That makes "what did my bot actually send to this channel?" surprisingly hard to answer. `tgcli` records every message it sends (and, with `listen`, every message it receives) into a local append-only ledger, so the channel state is always reconstructable.

Zero dependencies. Node 18.17+.

## Install

```bash
npm install -g tgcli
# or run it without installing
npx tgcli me
```

## Configure

```bash
export TG_BOT_TOKEN=123456:ABC...      # BotFather token
tgcli config set token 123456:ABC...   # or persist it in ~/.config/tgcli/config.json
tgcli me --pretty
```

## Commands

| Command | What it does |
| --- | --- |
| `send <chat> <text>` | send a text message |
| `photo\|video\|doc\|audio <chat> <file-or-url> [caption]` | send media; URLs are handed to Telegram, the file never touches your disk |
| `album <chat> <file...> [--caption text]` | media group |
| `edit <chat> <id> <text>` / `edit-caption` | edit a sent message |
| `delete <chat> <id...>` | delete one or more messages, marks them deleted in the ledger |
| `forward` / `copy <to> <from> <id>` | pass messages along |
| `pin` / `unpin <chat> <id>` | pinning |
| `me` | bot identity, including `can_read_all_group_messages` |
| `chat <chat>` / `member <chat> <user_id>` | chat metadata and permissions |
| `download <file_id> <dest>` | pull a file |
| `listen [--once]` | long-poll updates into the ledger |
| `log [--chat id] [--limit n]` | what the ledger knows |
| `stats` | ledger summary |

Global flags: `--token`, `--api-base`, `--db`, `--pretty`, `--silent`, `--disable-preview`, `--thread`.

## Output contract

Every command prints one JSON envelope:

```json
{ "ok": true, "schema_version": "1", "data": { } }
{ "ok": false, "schema_version": "1", "error": { "code": 400, "message": "chat not found" } }
```

Exit codes: `0` success · `1` runtime failure · `2` usage or configuration · `3` Telegram API error.

## Examples

```bash
# post a photo by URL — Telegram fetches it, your VPS stays quiet
tgcli photo -1001234567890 "https://example.com/chart.png" "<b>Daily digest</b>"

# fan out one message to several chats, then verify from the ledger
for chat in -100111 -100222; do tgcli send "$chat" "release is live"; done
tgcli log --limit 5 --pretty

# keep a channel mirrored locally
tgcli listen --once --timeout 25
```

## Why a ledger

`getChat` returns metadata, `getUpdates` returns new events, and that is the whole story. If the token owner did not log a message at send time, the content is unrecoverable once it scrolls out of view — and unreadable past 24 hours regardless. `tgcli` writes to `~/.local/share/tgcli/ledger.jsonl` (override with `--db` or `TGCLI_DB`), one JSON object per line, so it diffs, greps and survives intact.

## Development

```bash
git clone https://github.com/qunqin219/tgcli
cd tgcli
node --test test/
```

## License

Apache-2.0
