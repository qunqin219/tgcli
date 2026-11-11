import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Bot, SCHEMA_VERSION, VERSION, configPath, readConfig, resolveConfig, titleOf, TelegramError } from './api.js';
import { Store } from './store.js';

const EXIT = { ok: 0, runtime: 1, usage: 2, api: 3 };

const USAGE = `tgcli ${VERSION} — Telegram Bot API CLI with a local ledger

Usage: tgcli <command> [options]

Messaging
  send <chat> <text>              send a text message
  photo|video|doc|audio <chat> <file-or-url> [caption]
  album <chat> <file...> [--caption text]
  edit <chat> <message_id> <text>
  edit-caption <chat> <message_id> <text>
  delete <chat> <message_id...>
  forward <to> <from> <message_id>
  copy <to> <from> <message_id>
  pin|unpin <chat> <message_id>

Inspection
  me                              bot identity
  chat <chat>                     chat metadata
  member <chat> <user_id>         membership + permissions
  log [--chat id] [--limit n]     local ledger
  stats                           ledger summary

Updates
  listen [--once] [--timeout 30]  long-poll updates into the ledger
  download <file_id> <dest>       download a file by file_id

Options (any command)
  --token <token>   --api-base <url>   --json (default)   --pretty
  --silent          --disable-preview  --thread <id>      --db <path>

Exit codes: 0 ok · 1 runtime · 2 usage/config · 3 Telegram API error
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const takesValue = new Set(['token', 'api-base', 'caption', 'limit', 'db', 'thread', 'timeout', 'offset', 'parse-mode']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (takesValue.has(key)) {
      flags[key] = argv[i + 1];
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function envelope(data, error = null) {
  return error ? { ok: false, schema_version: SCHEMA_VERSION, error } : { ok: true, schema_version: SCHEMA_VERSION, data };
}

async function emit(payload, pretty) {
  process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
}

function buildExtra(flags) {
  const extra = {};
  if (flags.silent) extra.disable_notification = true;
  if (flags['disable-preview']) extra.disable_web_page_preview = true;
  if (flags['parse-mode']) extra.parse_mode = flags['parse-mode'];
  if (flags.thread) extra.message_thread_id = flags.thread;
  return extra;
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const args = positional.slice(1);
  const pretty = Boolean(flags.pretty);

  if (!command || command === 'help' || flags.help) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }
  if (command === 'version' || flags.version) {
    await emit(envelope({ version: VERSION, schema_version: SCHEMA_VERSION }), pretty);
    return EXIT.ok;
  }

  if (command === 'config') {
    const [, key, value] = positional;
    if (!key) {
      await emit(envelope(await readConfig()), pretty);
      return EXIT.ok;
    }
    const current = await readConfig();
    if (!value) {
      await emit(envelope({ [key]: current[key] ?? null }), pretty);
      return EXIT.ok;
    }
    current[key] = value;
    await mkdir(path.dirname(configPath()), { recursive: true });
    await writeFile(configPath(), `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    await emit(envelope({ saved: key, path: configPath() }), pretty);
    return EXIT.ok;
  }

  const store = new Store(flags.db);
  if (command === 'log') {
    const entries = await store.list({ chatId: flags.chat, limit: Number(flags.limit ?? 50) });
    await emit(envelope({ count: entries.length, entries }), pretty);
    return EXIT.ok;
  }
  if (command === 'stats') {
    await emit(envelope(await store.stats()), pretty);
    return EXIT.ok;
  }

  const config = await resolveConfig({ token: flags.token, apiBase: flags['api-base'] });
  const bot = new Bot(config);
  const extra = buildExtra(flags);

  switch (command) {
    case 'me': {
      const me = await bot.getMe();
      await emit(envelope(me), pretty);
      return EXIT.ok;
    }
    case 'send': {
      const [chat, ...rest] = args;
      if (!chat || rest.length === 0) throw new TelegramError('send', EXIT.usage, 'usage: tgcli send <chat> <text>');
      const text = rest.join(' ');
      const result = await bot.sendMessage(chat, text, extra);
      await store.append({ chat_id: chat, message_id: result.message_id, direction: 'out', kind: 'text', title: titleOf(text), body: text });
      await emit(envelope({ message_id: result.message_id, chat: result.chat?.id }), pretty);
      return EXIT.ok;
    }
    case 'photo':
    case 'video':
    case 'doc':
    case 'audio': {
      const [chat, media, ...captionParts] = args;
      if (!chat || !media) throw new TelegramError(command, EXIT.usage, `usage: tgcli ${command} <chat> <file-or-url> [caption]`);
      const caption = captionParts.join(' ') || flags.caption || undefined;
      const kind = command === 'doc' ? 'document' : command;
      const result = await bot.sendMedia(kind, chat, media, caption, extra);
      await store.append({
        chat_id: chat,
        message_id: result.message_id,
        direction: 'out',
        kind,
        title: titleOf(caption ?? path.basename(media)),
        body: caption ?? null,
        media: media
      });
      await emit(envelope({ message_id: result.message_id, kind }), pretty);
      return EXIT.ok;
    }
    case 'album': {
      const [chat, ...media] = args;
      if (!chat || media.length < 2) throw new TelegramError('album', EXIT.usage, 'usage: tgcli album <chat> <file...> [--caption text]');
      const kind = flags.video ? 'video' : 'photo';
      const result = await bot.sendMediaGroup(kind, chat, media, flags.caption, extra);
      const first = Array.isArray(result) ? result[0]?.message_id : undefined;
      await store.append({ chat_id: chat, message_id: first, direction: 'out', kind: `album:${kind}`, title: titleOf(flags.caption ?? 'album'), body: flags.caption ?? null, media });
      await emit(envelope({ message_ids: Array.isArray(result) ? result.map((m) => m.message_id) : [] }), pretty);
      return EXIT.ok;
    }
    case 'edit': {
      const [chat, messageId, ...textParts] = args;
      if (!chat || !messageId) throw new TelegramError('edit', EXIT.usage, 'usage: tgcli edit <chat> <message_id> <text>');
      const result = await bot.editText(chat, messageId, textParts.join(' '), extra);
      await emit(envelope({ message_id: result.message_id }), pretty);
      return EXIT.ok;
    }
    case 'edit-caption': {
      const [chat, messageId, ...textParts] = args;
      if (!chat || !messageId) throw new TelegramError('edit-caption', EXIT.usage, 'usage: tgcli edit-caption <chat> <message_id> <text>');
      const result = await bot.editCaption(chat, messageId, textParts.join(' '), extra);
      await emit(envelope({ message_id: result.message_id }), pretty);
      return EXIT.ok;
    }
    case 'delete': {
      const [chat, ...ids] = args;
      if (!chat || ids.length === 0) throw new TelegramError('delete', EXIT.usage, 'usage: tgcli delete <chat> <message_id...>');
      const deleted = [];
      const failed = [];
      for (const id of ids) {
        try {
          await bot.deleteMessage(chat, id);
          await store.markDeleted(chat, id);
          deleted.push(id);
        } catch (error) {
          failed.push({ message_id: id, error: error.description ?? String(error) });
        }
      }
      await emit(envelope({ deleted, failed }), pretty);
      return failed.length ? EXIT.api : EXIT.ok;
    }
    case 'forward':
    case 'copy': {
      const [to, from, messageId] = args;
      if (!to || !from || !messageId) throw new TelegramError(command, EXIT.usage, `usage: tgcli ${command} <to> <from> <message_id>`);
      const result = command === 'forward'
        ? await bot.forwardMessage(to, from, messageId)
        : await bot.copyMessage(to, from, messageId);
      await store.append({ chat_id: to, message_id: result.message_id, direction: 'out', kind: command, title: `${command} of ${from}/${messageId}`, body: null });
      await emit(envelope({ message_id: result.message_id }), pretty);
      return EXIT.ok;
    }
    case 'pin':
    case 'unpin': {
      const [chat, messageId] = args;
      if (!chat || !messageId) throw new TelegramError(command, EXIT.usage, `usage: tgcli ${command} <chat> <message_id>`);
      const result = command === 'pin'
        ? await bot.pinMessage(chat, messageId, { notify: Boolean(flags.notify) })
        : await bot.unpinMessage(chat, messageId);
      await emit(envelope({ ok: Boolean(result), chat_id: chat, message_id: messageId }), pretty);
      return EXIT.ok;
    }
    case 'chat': {
      const [chat] = args;
      if (!chat) throw new TelegramError('chat', EXIT.usage, 'usage: tgcli chat <chat>');
      await emit(envelope(await bot.getChat(chat)), pretty);
      return EXIT.ok;
    }
    case 'member': {
      const [chat, userId] = args;
      if (!chat || !userId) throw new TelegramError('member', EXIT.usage, 'usage: tgcli member <chat> <user_id>');
      await emit(envelope(await bot.getChatMember(chat, userId)), pretty);
      return EXIT.ok;
    }
    case 'download': {
      const [fileId, dest] = args;
      if (!fileId || !dest) throw new TelegramError('download', EXIT.usage, 'usage: tgcli download <file_id> <dest>');
      const saved = await bot.downloadFile(fileId, dest);
      await emit(envelope({ saved }), pretty);
      return EXIT.ok;
    }
    case 'listen': {
      const once = Boolean(flags.once);
      const timeout = Number(flags.timeout ?? 30);
      let offset = flags.offset ? Number(flags.offset) : await store.cursor();
      const captured = [];
      for (;;) {
        const updates = await bot.getUpdates({ offset, timeout });
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message ?? update.channel_post ?? update.edited_message ?? update.edited_channel_post;
          if (message) {
            const text = message.text ?? message.caption ?? '';
            await store.append({
              chat_id: message.chat.id,
              message_id: message.message_id,
              direction: 'in',
              kind: message.photo ? 'photo' : message.video ? 'video' : message.document ? 'document' : 'text',
              title: titleOf(text, `[${message.chat.type}]`),
              body: text,
              from: message.from?.username ?? message.sender_chat?.title ?? null
            });
            captured.push({ chat_id: message.chat.id, message_id: message.message_id, title: titleOf(text) });
          }
        }
        if (offset !== undefined) await store.setCursor(offset);
        if (captured.length || updates.length) await emit(envelope({ captured: captured.length, cursor: offset }), pretty);
        if (once || captured.length || updates.length === 0) {
          if (once) break;
          if (captured.length) break;
        }
      }
      await emit(envelope({ captured }), pretty);
      return EXIT.ok;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return EXIT.usage;
  }
}

export async function run(argv = process.argv.slice(2)) {
  try {
    return await main(argv);
  } catch (error) {
    const isTelegram = error instanceof TelegramError;
    const code = isTelegram ? (error.code === EXIT.usage ? EXIT.usage : EXIT.api) : EXIT.runtime;
    await emit(envelope(null, {
      code: isTelegram ? error.code : code,
      message: error.message ?? String(error)
    }), argv.includes('--pretty'));
    return code;
  }
}

export { readFile };
