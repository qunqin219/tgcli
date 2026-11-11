import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Bot, TelegramError, titleOf } from '../src/api.js';
import { Store } from '../src/store.js';

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, body: options.body });
    const payload = await handler(url, options, calls.length);
    return {
      ok: payload.ok ?? true,
      status: payload.error_code ?? 200,
      text: async () => JSON.stringify(payload)
    };
  };
  impl.calls = calls;
  return impl;
}

const config = { token: '123:test', apiBase: 'https://api.telegram.org' };

test('sendMessage posts to the right method and returns the result', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, result: { message_id: 7, chat: { id: -100 } } }));
  const bot = new Bot(config, { fetchImpl });
  const result = await bot.sendMessage('-100', 'hello');
  assert.equal(result.message_id, 7);
  assert.match(String(fetchImpl.calls[0].url), /\/sendMessage$/);
  assert.match(String(fetchImpl.calls[0].body), /chat_id=-100/);
});

test('a failed API call raises TelegramError with the API code', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, error_code: 400, description: 'chat not found' }));
  const bot = new Bot(config, { fetchImpl, retries: 0 });
  await assert.rejects(() => bot.getChat('-404'), (error) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.code, 400);
    return true;
  });
});

test('429 is retried after retry_after', async () => {
  let attempt = 0;
  const fetchImpl = fakeFetch(() => {
    attempt += 1;
    if (attempt === 1) return { ok: false, error_code: 429, description: 'too many', parameters: { retry_after: 0 } };
    return { ok: true, result: { message_id: 1 } };
  });
  const bot = new Bot(config, { fetchImpl, retries: 2 });
  const result = await bot.sendMessage('1', 'x');
  assert.equal(result.message_id, 1);
  assert.equal(attempt, 2);
});

test('titleOf strips HTML and keeps the first line', () => {
  assert.equal(titleOf('<b>Claude 5.2</b>\n\nbody'), 'Claude 5.2');
  assert.equal(titleOf('', 'fallback'), 'fallback');
});

test('store appends, lists newest first and marks deletions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tgcli-'));
  const store = new Store(path.join(dir, 'ledger.jsonl'));
  await store.append({ chat_id: '-100', message_id: 1, direction: 'out', kind: 'text', title: 'first' });
  await store.append({ chat_id: '-100', message_id: 2, direction: 'out', kind: 'text', title: 'second' });
  const listed = await store.list({ chatId: '-100' });
  assert.equal(listed[0].title, 'second');
  await store.markDeleted('-100', 2);
  const after = await store.list({ chatId: '-100' });
  assert.equal(after[0].deleted, true);
  const stats = await store.stats();
  assert.equal(stats.total, 2);
  await rm(dir, { recursive: true, force: true });
});

test('cursor round-trips', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tgcli-'));
  const store = new Store(path.join(dir, 'ledger.jsonl'));
  assert.equal(await store.cursor(), undefined);
  await store.setCursor(42);
  assert.equal(await store.cursor(), 42);
  await rm(dir, { recursive: true, force: true });
});
