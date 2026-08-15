import assert from 'node:assert/strict';
import test from 'node:test';
import { getMessage } from './i18n-mock.mjs';
import {
  findSettings,
  loadSettings,
  normalizeUrls,
  parseBackup,
  parseSettings,
  partitionSlots,
  saveSettings,
} from './config.mjs';

globalThis.browser = { i18n: { getMessage } };

test('normalizes and validates configured URLs', () => {
  const input = [' https://example.com ', 'http://example.net/path'];
  assert.deepEqual(normalizeUrls(input), [
    'https://example.com/',
    'http://example.net/path',
  ]);
  assert.throws(() => normalizeUrls(['ftp://example.com']), /http:\/\//);
  assert.throws(() => normalizeUrls([42]), /valid URL/);
  assert.throws(() => normalizeUrls(['not a URL']), /valid URL/);
  assert.throws(
    () => normalizeUrls(['https://example.com', 'https://example.com/']),
    /duplicates/,
  );
});

test('validates backups', () => {
  const backup = '{"version":1,"urls":["https://example.com"],'
    + '"privateWindows":true}';
  assert.deepEqual(parseBackup(backup), {
    urls: ['https://example.com/'],
    privateWindows: true,
  });
  assert.throws(
    () => parseBackup('{"version":2,"urls":[],"privateWindows":false}'),
    /version 1/,
  );
  assert.throws(() => parseBackup('{'), /valid JSON/);
  assert.throws(
    () => parseBackup('{"version":1,"urls":"bad","privateWindows":false}'),
    /version 1/,
  );
});

test('distinguishes missing settings from an empty list', async () => {
  const storage = {
    sync: { get: async () => ({}) },
  };
  assert.equal(await findSettings(storage), null);
  assert.deepEqual(await loadSettings(storage), {
    urls: [],
    privateWindows: false,
  });

  storage.sync.get = async () => ({
    settings: {
      urls: ['https://mozilla.org'],
      privateWindows: false,
    },
  });
  assert.deepEqual(await loadSettings(storage), {
    urls: ['https://mozilla.org/'],
    privateWindows: false,
  });
});

test('reports the Firefox sync item limit before saving', async () => {
  const storage = {
    sync: { set: async () => assert.fail('unexpected write') },
  };
  await assert.rejects(
    saveSettings(storage, {
      urls: [`https://example.com/${'x'.repeat(8200)}`],
      privateWindows: false,
    }),
    /8 KB/,
  );
});

test('rejects malformed stored settings', () => {
  assert.throws(
    () => parseSettings({ urls: 'https://example.com' }),
    /Invalid/,
  );
});

test('keeps one managed tab per configured slot and releases the rest', () => {
  const tabs = [
    { tab: { id: 1 }, slot: '1' },
    { tab: { id: 2 }, slot: '0' },
    { tab: { id: 3 }, slot: '1' },
    { tab: { id: 4 }, slot: '4' },
    { tab: { id: 5 }, slot: undefined },
  ];
  const { slots, extras } = partitionSlots(tabs, 2);
  assert.deepEqual(slots.map((tab) => tab.id), [2, 1]);
  assert.deepEqual(extras.map((tab) => tab.id), [3, 4]);
});
