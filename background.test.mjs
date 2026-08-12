import assert from 'node:assert/strict';
import test from 'node:test';

let moduleNumber = 0;

function event() {
  return {
    addListener(listener) {
      this.listener = listener;
    },
  };
}

async function setup({
  bootstrapFailures = 0,
  initialTabs = [{
    id: 1,
    windowId: 10,
    index: 0,
    pinned: true,
    incognito: false,
    slot: '0',
  }],
  incognitoAllowed = false,
  missingSettings = false,
  privateWindows = false,
  urls = ['https://example.com/'],
  windowIncognito = false,
} = {}) {
  const events = Object.fromEntries([
    'activated',
    'attached',
    'created',
    'detached',
    'installed',
    'moved',
    'removed',
    'startup',
    'storage',
    'updated',
    'windowCreated',
    'windowRemoved',
  ].map((name) => [name, event()]));
  const calls = [];
  const markers = new Map(initialTabs
    .filter(({ slot }) => slot !== undefined)
    .map(({ id, slot }) => [id, slot]));
  const tabs = initialTabs.map(({ slot: _slot, ...tab }) => ({ ...tab }));
  let stored = missingSettings
    ? {}
    : { settings: { urls, privateWindows } };
  let failNextMarker = false;
  let failedSessionReadId;
  let failedUpdateId;
  let sessionReads = 0;
  let syncReads = 0;
  let bootstrapReads = 0;
  const sessionStorage = {};

  globalThis.browser = {
    extension: {
      isAllowedIncognitoAccess: async () => incognitoAllowed,
    },
    runtime: {
      onInstalled: events.installed,
      onStartup: events.startup,
    },
    sessions: {
      getTabValue: async (id) => {
        sessionReads += 1;
        if (id === failedSessionReadId) {
          failedSessionReadId = undefined;
          throw new Error('Session read failed');
        }
        return markers.get(id);
      },
      removeTabValue: async (id) => markers.delete(id),
      setTabValue: async (id, _key, value) => {
        if (failNextMarker) {
          failNextMarker = false;
          throw new Error('Marker write failed');
        }
        markers.set(id, value);
      },
    },
    storage: {
      local: {
        get: async () => ({}),
        remove: async () => {},
      },
      sync: {
        get: async () => {
          syncReads += 1;
          return stored;
        },
        set: async (value) => {
          stored = { ...stored, ...value };
        },
        remove: async (keys) => {
          keys.forEach((key) => delete stored[key]);
        },
      },
      session: {
        get: async (key) => {
          bootstrapReads += 1;
          if (bootstrapFailures > 0) {
            bootstrapFailures -= 1;
            throw new Error('Bootstrap read failed');
          }
          return { [key]: sessionStorage[key] };
        },
        set: async (value) => Object.assign(sessionStorage, value),
      },
      onChanged: events.storage,
    },
    tabs: {
      create: async (properties) => {
        const tab = {
          id: Math.max(0, ...tabs.map(({ id }) => id)) + 1,
          index: tabs.length,
          incognito: false,
          ...properties,
        };
        tabs.push(tab);
        calls.push(['create', properties]);
        return tab;
      },
      get: async (id) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) throw new Error('Tab not found');
        return tab;
      },
      move: async (ids, properties) => calls.push(['move', ids, properties]),
      onActivated: events.activated,
      onAttached: events.attached,
      onCreated: events.created,
      onDetached: events.detached,
      onMoved: events.moved,
      onRemoved: events.removed,
      onUpdated: events.updated,
      query: async ({ windowId }) => (
        tabs.filter((tab) => tab.windowId === windowId)
      ),
      remove: async (id) => {
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index >= 0) tabs.splice(index, 1);
        calls.push(['remove', id]);
      },
      update: async (id, properties) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (id === failedUpdateId) {
          failedUpdateId = undefined;
          throw new Error('Tab update failed');
        }
        Object.assign(tab, properties);
        calls.push(['update', id, properties]);
        return tab;
      },
    },
    windows: {
      get: async () => ({
        id: 10,
        type: 'normal',
        incognito: windowIncognito,
      }),
      getAll: async () => [{
        id: 10,
        type: 'normal',
        incognito: windowIncognito,
      }],
      onCreated: events.windowCreated,
      onRemoved: events.windowRemoved,
    },
  };

  async function loadBackground() {
    await import(`./background.mjs?test=${moduleNumber}`);
    moduleNumber += 1;
  }

  await loadBackground();
  await new Promise(setImmediate);
  const bootCalls = structuredClone(calls);
  await events.startup.listener();
  calls.length = 0;
  sessionReads = 0;
  syncReads = 0;
  bootstrapReads = 0;

  return {
    bootCalls,
    calls,
    events,
    markers,
    tabs,
    bootstrapReads: () => bootstrapReads,
    failMarker() {
      failNextMarker = true;
    },
    failSessionRead(id) {
      failedSessionReadId = id;
    },
    failUpdate(id) {
      failedUpdateId = id;
    },
    reads() {
      return { sessionReads, syncReads };
    },
    setStored(value) {
      stored = { settings: value };
    },
    async wakeBackground() {
      await loadBackground();
      await new Promise(setImmediate);
    },
  };
}

test('background behavior', async (t) => {
  await t.test('module load reconciles after enable', async () => {
    const state = await setup({ initialTabs: [] });
    assert.deepEqual(state.bootCalls, [[
      'create',
      {
        windowId: 10,
        url: 'https://example.com/',
        active: false,
        pinned: true,
      },
    ]]);
  });

  await t.test('bootstrap retries after a transient failure', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const state = await setup({ bootstrapFailures: 1, initialTabs: [] });
      assert.equal(state.tabs.length, 1);
      assert.equal(state.markers.get(1), '0');
    } finally {
      console.error = originalError;
    }
  });

  await t.test('missing sync data preserves managed tabs', async () => {
    const state = await setup({ missingSettings: true });
    assert.deepEqual(state.bootCalls, []);
    assert.equal(state.tabs[0].pinned, true);
    assert.equal(state.markers.get(1), '0');

    await state.events.removed.listener(99, {
      windowId: 10,
      isWindowClosing: false,
    });
    assert.deepEqual(state.reads(), { sessionReads: 0, syncReads: 0 });
  });

  await t.test('private pins require the setting and permission', async () => {
    const allowed = await setup({
      incognitoAllowed: true,
      initialTabs: [],
      privateWindows: true,
      windowIncognito: true,
    });
    assert.equal(allowed.tabs.length, 1);
    assert.equal(allowed.tabs[0].pinned, true);

    const denied = await setup({
      incognitoAllowed: false,
      initialTabs: [],
      privateWindows: true,
      windowIncognito: true,
    });
    assert.deepEqual(denied.tabs, []);
  });

  await t.test('disabling private pins releases managed tabs', async () => {
    const state = await setup({
      incognitoAllowed: true,
      initialTabs: [{
        id: 1,
        windowId: 10,
        index: 0,
        pinned: true,
        incognito: true,
        slot: '0',
      }],
      privateWindows: false,
      windowIncognito: true,
    });
    assert.equal(state.tabs[0].pinned, false);
    assert.equal(state.markers.has(1), false);
  });

  await t.test('startup does not rescan or reload managed tabs', async () => {
    const state = await setup();
    await Promise.all([
      state.events.startup.listener(),
      state.events.installed.listener(),
    ]);
    assert.equal(state.bootstrapReads(), 0);
    assert.deepEqual(state.reads(), { sessionReads: 0, syncReads: 0 });
    assert.deepEqual(state.calls, []);
  });

  await t.test('managed pins are restored to configured order', async () => {
    const state = await setup({
      initialTabs: [{
        id: 1,
        windowId: 10,
        index: 0,
        pinned: true,
        incognito: false,
        slot: '1',
      }, {
        id: 2,
        windowId: 10,
        index: 1,
        pinned: true,
        incognito: false,
        slot: '0',
      }],
      urls: ['https://example.com/', 'https://example.net/'],
    });
    assert.deepEqual(state.bootCalls, [[
      'move',
      [2, 1],
      { index: 0 },
    ]]);
  });

  await t.test('event-page wakeups do not rescan tabs', async () => {
    const state = await setup();
    await state.wakeBackground();
    assert.deepEqual(state.reads(), { sessionReads: 0, syncReads: 0 });
  });

  await t.test('only URL changes reload managed tabs', async () => {
    const state = await setup();
    state.setStored({
      urls: ['https://example.com/'],
      privateWindows: true,
    });
    await state.events.storage.listener({
      settings: {
        oldValue: {
          urls: ['https://example.com/'],
          privateWindows: false,
        },
        newValue: {
          urls: ['https://example.com/'],
          privateWindows: true,
        },
      },
    }, 'sync');
    assert.deepEqual(state.calls, []);

    state.setStored({ urls: ['https://example.net/'], privateWindows: false });
    await state.events.storage.listener({
      settings: {
        oldValue: {
          urls: ['https://example.com/'],
          privateWindows: true,
        },
        newValue: {
          urls: ['https://example.net/'],
          privateWindows: false,
        },
      },
    }, 'sync');
    assert.deepEqual(state.calls, [[
      'update',
      1,
      { pinned: true, url: 'https://example.net/', loadReplace: true },
    ]]);
  });

  await t.test('no-op storage notifications do nothing', async () => {
    const state = await setup();
    await state.events.storage.listener({
      settings: {
        oldValue: {
          urls: ['https://example.com/'],
          privateWindows: false,
        },
        newValue: {
          urls: ['https://example.com/'],
          privateWindows: false,
        },
      },
    }, 'sync');
    assert.deepEqual(state.reads(), { sessionReads: 0, syncReads: 0 });
    assert.deepEqual(state.calls, []);
  });

  await t.test('activation resets the managed URL', async () => {
    const state = await setup({ urls: ['https://example.net/'] });
    await state.events.activated.listener({ tabId: 1 });
    assert.deepEqual(state.calls, [[
      'update',
      1,
      { url: 'https://example.net/', loadReplace: true },
    ]]);
  });

  await t.test('unmanaged activations skip storage reads', async () => {
    const state = await setup({
      initialTabs: [{
        id: 1,
        windowId: 10,
        index: 0,
        pinned: false,
        incognito: false,
      }],
      urls: [],
    });
    await state.events.activated.listener({ tabId: 1 });
    assert.deepEqual(state.reads(), { sessionReads: 0, syncReads: 0 });
  });

  await t.test('ordinary created tabs skip session reads', async () => {
    const state = await setup();
    await state.events.created.listener({
      id: 2,
      windowId: 10,
      pinned: false,
    });
    assert.deepEqual(state.reads(), { sessionReads: 0, syncReads: 0 });
  });

  await t.test('restored managed tabs are deduplicated', async () => {
    const state = await setup();
    state.tabs.push({
      id: 2,
      windowId: 10,
      index: 1,
      pinned: true,
      incognito: false,
    });
    state.markers.set(2, '0');
    await state.events.created.listener(state.tabs[1]);
    assert.deepEqual(state.calls, [[
      'update',
      2,
      { pinned: false },
    ]]);
  });

  await t.test('failed unpins retain their session marker', async () => {
    const state = await setup();
    state.tabs.push({
      id: 2,
      windowId: 10,
      index: 1,
      pinned: true,
      incognito: false,
    });
    state.markers.set(2, '0');
    state.failUpdate(2);
    const originalError = console.error;
    let reported = false;
    console.error = () => { reported = true; };
    try {
      await state.events.created.listener(state.tabs[1]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reported, true);
    assert.equal(state.markers.get(2), '0');
  });

  await t.test('queued work survives an earlier failure', async () => {
    const state = await setup();
    state.tabs.push({
      id: 2,
      windowId: 10,
      index: 1,
      pinned: true,
      incognito: false,
    });
    state.markers.set(2, '0');
    state.failUpdate(2);
    const change = {
      settings: {
        oldValue: {
          urls: ['https://example.com/'],
          privateWindows: false,
        },
        newValue: {
          urls: ['https://example.com/'],
          privateWindows: true,
        },
      },
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      await Promise.all([
        state.events.storage.listener(change, 'sync'),
        state.events.storage.listener(change, 'sync'),
      ]);
      await new Promise(setImmediate);
    } finally {
      console.error = originalError;
    }
    assert.equal(state.tabs[1].pinned, false);
    assert.equal(state.markers.has(2), false);
  });

  await t.test('transient marker reads do not duplicate pins', async () => {
    const state = await setup();
    state.setStored({
      urls: ['https://example.com/'],
      privateWindows: true,
    });
    state.failSessionRead(1);
    const originalError = console.error;
    console.error = () => {};
    try {
      await state.events.storage.listener({
        settings: {
          oldValue: {
            urls: ['https://example.com/'],
            privateWindows: false,
          },
          newValue: {
            urls: ['https://example.com/'],
            privateWindows: true,
          },
        },
      }, 'sync');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(state.calls, []);
  });

  await t.test('managed removals are restored', async () => {
    const state = await setup();
    state.tabs.splice(0, 1);
    state.markers.delete(1);
    await state.events.removed.listener(1, {
      windowId: 10,
      isWindowClosing: false,
    });
    assert.deepEqual(state.calls, [[
      'create',
      {
        windowId: 10,
        url: 'https://example.com/',
        active: false,
        pinned: true,
      },
    ]]);
  });

  await t.test('unrelated removals are ignored', async () => {
    const state = await setup();
    await state.events.removed.listener(99, {
      windowId: 10,
      isWindowClosing: false,
    });
    assert.deepEqual(state.calls, []);
  });

  await t.test('failed marker writes roll back the created tab', async () => {
    const state = await setup({ initialTabs: [], urls: [] });
    state.setStored({ urls: ['https://example.com/'], privateWindows: false });
    state.failMarker();
    const originalError = console.error;
    console.error = () => {};
    try {
      await state.events.storage.listener({
        settings: {
          oldValue: { urls: [], privateWindows: false },
          newValue: {
            urls: ['https://example.com/'],
            privateWindows: false,
          },
        },
      }, 'sync');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(state.calls, [
      ['create', {
        windowId: 10,
        url: 'https://example.com/',
        active: false,
        pinned: true,
      }],
      ['remove', 1],
    ]);
  });

  await t.test('invalid synced settings do not modify tabs', async () => {
    const state = await setup();
    state.setStored({ urls: 'https://invalid.example', privateWindows: false });
    const originalError = console.error;
    console.error = () => {};
    try {
      await state.events.storage.listener({
        settings: {
          oldValue: {
            urls: ['https://example.com/'],
            privateWindows: false,
          },
          newValue: {
            urls: 'https://invalid.example',
            privateWindows: false,
          },
        },
      }, 'sync');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(state.calls, []);
  });
});
