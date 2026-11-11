import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const SCHEMA_VERSION = '1';
export const VERSION = '0.1.0';

export class TelegramError extends Error {
  constructor(method, code, description, retryAfter = null) {
    super(`${method}: [${code}] ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

export function configPath() {
  const root = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(root, 'tgcli', 'config.json');
}

export async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

export async function resolveConfig({ token, apiBase } = {}) {
  const file = await readConfig();
  const resolvedToken = token || process.env.TG_BOT_TOKEN || file.token;
  if (!resolvedToken) {
    throw new TelegramError('config', 2, 'no bot token: pass --token, set TG_BOT_TOKEN, or run `tgcli config set token <token>`');
  }
  const base = (apiBase || process.env.TG_API_BASE || file.api_base || 'https://api.telegram.org').replace(/\/+$/, '');
  return { token: resolvedToken, apiBase: base };
}

const MEDIA_METHOD = {
  photo: 'sendPhoto',
  video: 'sendVideo',
  document: 'sendDocument',
  audio: 'sendAudio',
  animation: 'sendAnimation'
};

const isUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

export class Bot {
  constructor(config, { timeoutMs = 60_000, retries = 3, fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetch = fetchImpl;
  }

  url(method) {
    return `${this.config.apiBase}/bot${this.config.token}/${method}`;
  }

  async call(method, params = {}, files = null) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.#once(method, params, files);
      } catch (error) {
        if (error instanceof TelegramError) {
          if (error.code === 429 && attempt < this.retries) {
            await sleep((error.retryAfter ?? 2) * 1000);
            continue;
          }
          if (error.code >= 500 && attempt < this.retries) {
            lastError = error;
          } else {
            throw error;
          }
        } else {
          lastError = error;
        }
        await sleep(Math.min(2 ** attempt * 500 + Math.random() * 300, 8000));
      }
    }
    throw new TelegramError(method, 0, `transport failed: ${lastError?.message ?? 'unknown'}`);
  }

  async #once(method, params, files) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let body;
    if (files && files.length) {
      body = new FormData();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      for (const file of files) {
        const blob = file.data ?? new Blob([await readFile(file.path)]);
        body.append(file.field, blob, file.filename || path.basename(file.path));
      }
    } else {
      body = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
    }
    try {
      const response = await this.fetch(this.url(method), { method: 'POST', body, signal: controller.signal });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new TelegramError(method, response.status, text.slice(0, 200) || 'non-JSON response');
      }
      if (!payload.ok) {
        throw new TelegramError(method, payload.error_code ?? response.status, payload.description ?? 'unknown error', payload.parameters?.retry_after ?? null);
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  getMe() {
    return this.call('getMe');
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra });
  }

  sendMedia(kind, chatId, media, caption, extra = {}) {
    const method = MEDIA_METHOD[kind] || 'sendDocument';
    if (isUrl(media)) {
      return this.call(method, { chat_id: chatId, caption, [kind === 'document' ? 'document' : kind]: media, ...extra });
    }
    return this.call(method, { chat_id: chatId, caption, ...extra }, [
      { field: kind === 'document' ? 'document' : kind, path: media }
    ]);
  }

  sendMediaGroup(kind, chatId, mediaList, caption, extra = {}) {
    const files = [];
    const items = mediaList.map((src, index) => {
      const item = { type: kind === 'document' ? 'document' : kind };
      if (isUrl(src)) {
        item.media = src;
      } else {
        const field = `file${index}`;
        files.push({ field, path: src });
        item.media = `attach://${field}`;
      }
      if (index === 0 && caption) item.caption = caption;
      return item;
    });
    return this.call('sendMediaGroup', { chat_id: chatId, media: items, ...extra }, files);
  }

  editText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
  }

  editCaption(chatId, messageId, caption, extra = {}) {
    return this.call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, ...extra });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  forwardMessage(chatId, fromChatId, messageId) {
    return this.call('forwardMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId });
  }

  copyMessage(chatId, fromChatId, messageId) {
    return this.call('copyMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId });
  }

  pinMessage(chatId, messageId, { notify = false } = {}) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: !notify });
  }

  unpinMessage(chatId, messageId) {
    return this.call('unpinChatMessage', { chat_id: chatId, message_id: messageId });
  }

  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  getUpdates({ offset, timeout = 30, limit = 100, allowedUpdates } = {}) {
    return this.call('getUpdates', {
      offset,
      timeout,
      limit,
      allowed_updates: allowedUpdates ? JSON.stringify(allowedUpdates) : undefined
    });
  }

  async downloadFile(fileId, dest) {
    const info = await this.getFile(fileId);
    const response = await this.fetch(`${this.config.apiBase}/file/bot${this.config.token}/${info.file_path}`);
    if (!response.ok) throw new TelegramError('downloadFile', response.status, 'download failed');
    const buffer = Buffer.from(await response.arrayBuffer());
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buffer);
    return dest;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function titleOf(text, fallback = '') {
  const firstLine = String(text ?? '').split('\n').find((line) => line.trim()) ?? fallback;
  return firstLine.replace(/<[^>]+>/g, '').trim().slice(0, 80);
}
