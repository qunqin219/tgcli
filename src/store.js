import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Append-only JSONL ledger.
 *
 * The Bot API has no way to page through chat history, so tgcli records what it
 * sends and (via `tgcli listen`) what arrives. The ledger is the only reliable
 * answer to "what is actually in that channel".
 */
export class Store {
  constructor(file) {
    this.file = file || process.env.TGCLI_DB || path.join(
      process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'),
      'tgcli',
      'ledger.jsonl'
    );
    this.cursorFile = `${this.file}.cursor`;
  }

  async ensure() {
    await mkdir(path.dirname(this.file), { recursive: true });
  }

  async append(entry) {
    await this.ensure();
    const record = { ts: new Date().toISOString(), ...entry };
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  async all() {
    try {
      const raw = await readFile(this.file, 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async list({ chatId, direction, limit = 50 } = {}) {
    const entries = await this.all();
    const filtered = entries.filter((entry) => {
      if (chatId !== undefined && String(entry.chat_id) !== String(chatId)) return false;
      if (direction && entry.direction !== direction) return false;
      return true;
    });
    return filtered.slice(-limit).reverse();
  }

  async markDeleted(chatId, messageId) {
    await this.ensure();
    const entries = await this.all();
    const next = entries.map((entry) =>
      String(entry.chat_id) === String(chatId) && Number(entry.message_id) === Number(messageId)
        ? { ...entry, deleted: true, deleted_at: new Date().toISOString() }
        : entry
    );
    await writeFile(this.file, next.map((entry) => JSON.stringify(entry)).join('\n') + (next.length ? '\n' : ''), 'utf8');
    return true;
  }

  async cursor() {
    try {
      return Number((await readFile(this.cursorFile, 'utf8')).trim()) || undefined;
    } catch {
      return undefined;
    }
  }

  async setCursor(value) {
    await this.ensure();
    await writeFile(this.cursorFile, String(value), 'utf8');
  }

  async stats() {
    const entries = await this.all();
    const counts = new Map();
    for (const entry of entries) {
      const key = `${entry.chat_id}|${entry.direction}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      ledger: this.file,
      total: entries.length,
      counts: [...counts.entries()].map(([key, n]) => {
        const [chat_id, direction] = key.split('|');
        return { chat_id, direction, count: n };
      })
    };
  }
}
