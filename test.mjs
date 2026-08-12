import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSettings,
  loadSettings,
  normalizeUrls,
  parseBackup,
  parseSettings,
  partitionSlots,
  saveSettings,
} from './config.mjs';

test('normalizes and validates configured URLs', () => {
  const input = [' https://example.com ', 'http://example.net/path'];
  assert.deepEqual(normalizeUrls(input), [
    'https://example.com/',
    'http://example.net/path',
  ]);
  assert.throws(() => normalizeUrls(['ftp://example.com']), /http:\/\//);
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
});

test('distinguishes missing settings from an empty list', async () => {
  const storage = {
    sync: { get: async () => ({}) },
    local: { get: async () => ({}) },
  };
  assert.equal(await findSettings(storage), null);
  assert.deepEqual(await loadSettings(storage), {
    urls: [],
    privateWindows: false,
  });
});

test('reads synced settings and migrates existing local settings', async () => {
  const writes = [];
  const localRemovals = [];
  const syncRemovals = [];
  const storage = {
    sync: {
      get: async () => ({}),
      set: async (value) => writes.push(value),
      remove: async (keys) => syncRemovals.push(keys),
    },
    local: {
      get: async () => ({
        urls: ['https://example.com'],
        privateWindows: true,
      }),
      remove: async (keys) => localRemovals.push(keys),
    },
  };

  assert.deepEqual(await loadSettings(storage), {
    urls: ['https://example.com/'],
    privateWindows: true,
  });
  assert.deepEqual(writes, [{
    settings: {
      urls: ['https://example.com/'],
      privateWindows: true,
    },
  }]);
  assert.deepEqual(syncRemovals, [['urls', 'privateWindows']]);
  assert.deepEqual(localRemovals, [['urls', 'privateWindows']]);

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

test('uses local settings when sync migration fails', async () => {
  let removed = false;
  const storage = {
    sync: {
      get: async () => ({}),
      set: async () => { throw new Error('Sync unavailable'); },
    },
    local: {
      get: async () => ({
        urls: ['https://example.com'],
        privateWindows: false,
      }),
      remove: async () => { removed = true; },
    },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await findSettings(storage), {
      urls: ['https://example.com/'],
      privateWindows: false,
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(removed, false);
});

test('migrates legacy synced settings into one item', async () => {
  const writes = [];
  const storage = {
    sync: {
      get: async () => ({
        urls: ['https://example.com'],
        privateWindows: true,
      }),
      set: async (value) => writes.push(value),
      remove: async () => {},
    },
    local: {
      get: async () => assert.fail('unexpected local read'),
      remove: async () => {},
    },
  };
  assert.deepEqual(await findSettings(storage), {
    urls: ['https://example.com/'],
    privateWindows: true,
  });
  assert.deepEqual(writes, [{
    settings: {
      urls: ['https://example.com/'],
      privateWindows: true,
    },
  }]);
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
