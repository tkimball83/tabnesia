import assert from 'node:assert/strict';
import test from 'node:test';
import { getMessage } from './i18n-mock.mjs';
import {
  findSettings,
  loadSettings,
  newPinId,
  normalizeUrls,
  parseBackup,
  parseMarker,
  parseSettings,
  partitionSlots,
  saveSettings,
  serializeSettings,
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
  const backup = '{"version":1,"pins":[{"url":"https://example.com","reload":false}],'
    + '"privateWindows":false}';
  assert.deepEqual(parseBackup(backup), {
    pins: [{
      id: 'https://example.com/',
      url: 'https://example.com/',
      reload: false,
    }],
    privateWindows: false,
  });
  assert.throws(
    () => parseBackup('{"version":2,"pins":[],"privateWindows":false}'),
    /version/,
  );
  assert.throws(() => parseBackup('{'), /valid JSON/);
  assert.throws(
    () => parseBackup('{"version":1,"pins":"bad","privateWindows":false}'),
    /version/,
  );
});

test('distinguishes missing settings from an empty list', async () => {
  const storage = {
    sync: { get: async () => ({}) },
  };
  assert.equal(await findSettings(storage), null);
  assert.deepEqual(await loadSettings(storage), {
    pins: [],
    privateWindows: false,
  });

  storage.sync.get = async () => ({
    settings: {
      pins: [{ url: 'https://mozilla.org', reload: true }],
      privateWindows: false,
    },
  });
  assert.deepEqual(await loadSettings(storage), {
    pins: [{
      id: 'https://mozilla.org/',
      url: 'https://mozilla.org/',
      reload: true,
    }],
    privateWindows: false,
  });
});

test('reports the Firefox sync item limit before saving', async () => {
  const storage = {
    sync: { set: async () => assert.fail('unexpected write') },
  };
  await assert.rejects(
    saveSettings(storage, {
      pins: [{ url: `https://example.com/${'x'.repeat(8200)}`, reload: true }],
      privateWindows: false,
    }),
    /8 KB/,
  );
});

test('rejects malformed stored settings', () => {
  assert.throws(
    () => parseSettings({ pins: 'not an array', privateWindows: false }),
    /Invalid/,
  );
  assert.throws(
    () => parseSettings({ pins: [null], privateWindows: false }),
    /Invalid tabnesia settings/,
  );
});

test('keeps pin ids and gives 1.0.0 pins their URL as id', () => {
  const { pins } = parseSettings({
    pins: [
      { id: 'k1', url: 'https://a.example', reload: true },
      { url: 'https://b.example', reload: true },
    ],
    privateWindows: false,
  });
  assert.deepEqual(pins.map(({ id }) => id), ['k1', 'https://b.example/']);
  assert.throws(
    () => parseSettings({
      pins: [
        { id: 'same', url: 'https://a.example' },
        { id: 'same', url: 'https://b.example' },
      ],
      privateWindows: false,
    }),
    /Invalid tabnesia settings/,
  );
  const taken = new Set(['aaaaaaaa']);
  const id = newPinId(taken);
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(taken.has(id), false);
});

test('1.0.0 settings that fit still save, byte for byte', async () => {
  const legacy = {
    pins: [1, 2].map((n) => ({
      url: `https://example.com/${n}/${'x'.repeat(3000)}`,
      reload: true,
    })),
    privateWindows: false,
  };
  let written;
  await saveSettings(
    { sync: { set: async (value) => { written = value; } } },
    parseSettings(legacy),
  );
  assert.deepEqual(written.settings, legacy);

  // An edited pin keeps its id, and a new pin stores its own.
  const edited = parseSettings(legacy);
  edited.pins[0].url = 'https://edited.example/';
  edited.pins.push({ id: 'k1', url: 'https://new.example/', reload: true });
  const stored = serializeSettings(edited);
  assert.deepEqual(stored.pins.map(({ id }) => id), [
    legacy.pins[0].url,
    undefined,
    'k1',
  ]);
  assert.deepEqual(parseSettings(stored), edited);
});

test('reads markers and rejects anything else', () => {
  const url = 'https://b.example/';
  assert.deepEqual(parseMarker({ id: 'b', url }), { id: 'b', url });
  assert.equal(parseMarker({ id: '', url }), null);
  assert.equal(parseMarker({ id: 'b' }), null);
  // 1.0.0 stored bare slot numbers.
  assert.equal(parseMarker('0'), null);
  assert.equal(parseMarker(undefined), null);
});

test('matches managed tabs to pins by id and releases the rest', () => {
  const [a, b, c] = ['https://a.example/', 'https://b.example/', 'https://c.example/'];
  const pins = [{ id: 'a', url: a }, { id: 'b', url: b }, { id: 'c', url: c }];
  const tabs = [
    // Pin b, wherever it moved; pin a, whose URL was edited.
    { tab: { id: 1 }, marker: { id: 'b', url: b } },
    { tab: { id: 2 }, marker: { id: 'a', url: 'https://old.example/' } },
    // A duplicate, and a deleted pin even though its URL is configured.
    { tab: { id: 3 }, marker: { id: 'a', url: a } },
    { tab: { id: 4 }, marker: { id: 'gone', url: c } },
    // A 1.0.0 tab, and one that is not managed at all.
    { tab: { id: 5 }, marker: '2' },
    { tab: { id: 6 }, marker: undefined },
  ];
  const { slots, extras } = partitionSlots(tabs, pins);
  assert.deepEqual(
    Array.from(slots, (entry) => entry?.tab.id),
    [2, 1, undefined],
  );
  assert.deepEqual(extras.map(({ id }) => id), [3, 4, 5]);
});
