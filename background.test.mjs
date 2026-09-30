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
  // Explicit pin ids; without them pins are stored id-less, as 1.0.0 did,
  // and each URL is its pin's id.
  ids = undefined,
  windowIncognito = false,
} = {}) {
  const events = Object.fromEntries([
    'activated',
    'alarm',
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
  const alarms = new Map();
  let alarmCreations = 0;
  // `slot` gives a tab the marker of the pin at that slot; `marker` sets the
  // raw stored value.
  const markers = new Map(initialTabs
    .filter(({ slot, marker }) => slot !== undefined || marker !== undefined)
    .map(({ id, slot, marker }) => [
      id,
      marker ?? { id: (ids ?? urls)[Number(slot)], url: urls[Number(slot)] },
    ]));
  const tabs = initialTabs.map(
    ({ slot: _slot, marker: _marker, ...tab }) => ({ ...tab }),
  );
  let stored = missingSettings
    ? {}
    : {
      settings: {
        pins: urls.map((url, i) => ({ ...(ids && { id: ids[i] }), url, reload: true })),
        privateWindows,
      },
    };
  let markerWritesBeforeFailure = -1;
  let failedSessionReadId;
  let syncReadGate;
  let failedUpdateId;
  let sessionReads = 0;
  let syncReads = 0;
  let bootstrapReads = 0;
  const sessionStorage = {};
  const localStorage = {};

  globalThis.browser = {
    extension: {
      isAllowedIncognitoAccess: async () => incognitoAllowed,
    },
    i18n: { getMessage: (key) => key },
    action: {
      onClicked: event(),
    },
    alarms: {
      create: async (name, info) => {
        alarmCreations += 1;
        alarms.set(name, info);
      },
      get: async (name) => alarms.get(name),
      onAlarm: events.alarm,
    },
    runtime: {
      onInstalled: events.installed,
      onStartup: events.startup,
      openOptionsPage: async () => {},
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
        if (markerWritesBeforeFailure > 0) {
          markerWritesBeforeFailure -= 1;
        } else if (markerWritesBeforeFailure === 0) {
          markerWritesBeforeFailure = -1;
          throw new Error('Marker write failed');
        }
        markers.set(id, value);
      },
    },
    storage: {
      sync: {
        get: async () => {
          syncReads += 1;
          const value = stored;
          if (syncReadGate) {
            const gate = syncReadGate;
            syncReadGate = undefined;
            await gate;
          }
          return value;
        },
        set: async (value) => {
          stored = { ...stored, ...value };
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
      local: {
        get: async (key) => ({ [key]: localStorage[key] }),
        set: async (value) => Object.assign(localStorage, value),
        remove: async (key) => { delete localStorage[key]; },
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
    // Fails the marker write that follows `skip` successful ones.
    failMarker(skip = 0) {
      markerWritesBeforeFailure = skip;
    },
    failSessionRead(id) {
      failedSessionReadId = id;
    },
    failUpdate(id) {
      failedUpdateId = id;
    },
    alarms,
    alarmCreations: () => alarmCreations,
    // Holds the next settings read, with the value current when it started,
    // until the returned function is called.
    holdNextSyncRead() {
      let release;
      syncReadGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    // Fires the periodic check, as Firefox would each period.
    tick: () => events.alarm.listener({ name: 'tabnesiaCheck' }),
    reads() {
      return { sessionReads, syncReads };
    },
    setStored(value) {
      stored = value === undefined ? {} : { settings: value };
    },
    async wakeBackground() {
      await loadBackground();
      await new Promise(setImmediate);
    },
  };
}

const ABC = ['https://a.example/', 'https://b.example/', 'https://c.example/'];

// Pins a, b and c, one managed tab each (ids 1-3). `changePins` saves a new
// list of [id, url] pairs the way the options page does.
async function setupThree() {
  const state = await setup({
    urls: ABC,
    ids: ['a', 'b', 'c'],
    initialTabs: ABC.map((url, index) => ({
      id: index + 1,
      windowId: 10,
      index,
      pinned: true,
      incognito: false,
      url,
      slot: String(index),
    })),
  });
  const settingsOf = (pairs) => ({
    pins: pairs.map(([id, url]) => ({ id, url, reload: true })),
    privateWindows: false,
  });
  let previous = settingsOf([['a', ABC[0]], ['b', ABC[1]], ['c', ABC[2]]]);
  state.changePins = (pairs) => {
    const oldValue = previous;
    previous = settingsOf(pairs);
    state.setStored(previous);
    return state.events.storage.listener({
      settings: { oldValue, newValue: previous },
    }, 'sync');
  };
  return state;
}

const [A, B, C] = [['a', ABC[0]], ['b', ABC[1]], ['c', ABC[2]]];

test('background behavior', async (t) => {
  await t.test('reordering moves tabs without reloading them', async () => {
    const state = await setupThree();
    await state.changePins([B, A, C]);
    assert.deepEqual(state.calls, [['move', [2, 1, 3], { index: 0 }]]);
  });

  await t.test('removing a middle pin unpins its own tab', async () => {
    const state = await setupThree();
    await state.changePins([A, C]);
    assert.deepEqual(state.calls, [
      ['update', 2, { pinned: false }],
      ['move', [1, 3], { index: 0 }],
    ]);
    assert.equal(state.tabs[1].url, ABC[1]);
    assert.equal(state.markers.has(2), false);
    assert.deepEqual(state.markers.get(3), { id: 'c', url: ABC[2] });
  });

  await t.test('editing a pin\'s URL navigates only its tab', async () => {
    const state = await setupThree();
    const edited = 'https://x.example/';
    await state.changePins([A, ['b', edited], C]);
    assert.deepEqual(state.calls, [
      ['update', 2, { pinned: true, url: edited, loadReplace: true }],
    ]);
    assert.deepEqual(state.markers.get(2), { id: 'b', url: edited });
  });

  await t.test('the periodic check leaves tabs that are in step alone', async () => {
    const state = await setupThree();
    assert.deepEqual(state.alarms.get('tabnesiaCheck'), { periodInMinutes: 1 });
    // A restart of the background script keeps the running alarm.
    await state.wakeBackground();
    assert.equal(state.alarmCreations(), 1);
    for (let tick = 0; tick < 5; tick += 1) await state.tick();
    // No reload, navigation, move, or re-pin: nothing was out of step.
    assert.deepEqual(state.calls, []);
  });

  const quietly = async (work) => {
    const originalError = console.error;
    console.error = () => {};
    try {
      await work();
    } finally {
      console.error = originalError;
    }
  };

  const settle = async () => {
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise(setImmediate);
    }
  };

  await t.test('the periodic check applies an edit whose check failed', async () => {
    const state = await setupThree();
    const edited = 'https://x.example/';
    state.failSessionRead(1);
    await quietly(() => state.changePins([A, ['b', edited], C]));
    assert.equal(state.tabs[1].url, ABC[1]);
    await state.tick();
    assert.equal(state.tabs[1].url, edited);
    assert.deepEqual(state.markers.get(2), { id: 'b', url: edited });
  });

  await t.test('the periodic check applies a change that reached no window', async () => {
    const state = await setupThree();
    const { getAll } = globalThis.browser.windows;
    globalThis.browser.windows.getAll = async () => {
      throw new Error('Lookup failed');
    };
    try {
      await quietly(() => state.changePins([A, C]));
    } finally {
      globalThis.browser.windows.getAll = getAll;
    }
    assert.equal(state.tabs[1].pinned, true);
    await state.tick();
    assert.equal(state.tabs[1].pinned, false);
    assert.equal(state.markers.has(2), false);
  });

  await t.test('a slow activation cannot undo a URL edit', async () => {
    const state = await setupThree();
    const edited = 'https://x.example/';
    // The activation reads the old settings, then stalls...
    const release = state.holdNextSyncRead();
    const activation = state.events.activated.listener({ tabId: 2 });
    await settle();
    // ...while an edit that also turns auto-reload off lands.
    const pins = [
      { id: 'a', url: ABC[0], reload: true },
      { id: 'b', url: edited, reload: false },
      { id: 'c', url: ABC[2], reload: true },
    ];
    state.setStored({ pins, privateWindows: false });
    const edit = state.events.storage.listener({
      settings: {
        oldValue: {
          pins: [A, B, C].map(([id, url]) => ({ id, url, reload: true })),
          privateWindows: false,
        },
        newValue: { pins, privateWindows: false },
      },
    }, 'sync');
    await settle();
    release();
    await Promise.all([activation, edit]);
    assert.equal(state.tabs[1].url, edited);
    assert.deepEqual(state.markers.get(2), { id: 'b', url: edited });
  });

  await t.test('a failed release waits for the others before the next check', async () => {
    const state = await setupThree();
    const { sessions } = globalThis.browser;
    const { removeTabValue } = sessions;
    let finishRelease;
    const held = new Promise((resolve) => { finishRelease = resolve; });
    sessions.removeTabValue = async (id, key) => {
      if (id === 2) await held;
      return removeTabValue(id, key);
    };
    try {
      await quietly(async () => {
        // Releasing a fails while releasing b is still in flight...
        state.failUpdate(1);
        const first = state.changePins([C]);
        await settle();
        // ...and b comes back before that release finishes.
        const second = state.changePins([B, C]);
        await settle();
        finishRelease();
        await Promise.all([first, second]);
        await state.tick();
      });
    } finally {
      sessions.removeTabValue = removeTabValue;
    }
    const holders = state.tabs.filter((tab) => (
      tab.pinned && state.markers.get(tab.id)?.id === 'b'
    ));
    assert.equal(holders.length, 1);
    const untracked = state.tabs.filter((tab) => (
      tab.pinned && !state.markers.has(tab.id)
    ));
    assert.deepEqual(untracked, []);
  });

  await t.test('rolling back a failed creation does not loop', async () => {
    const state = await setup({ initialTabs: [], urls: [] });
    // A freshly started background script has no initialized windows, so
    // any removal there would otherwise trigger another check.
    await state.wakeBackground();
    const { sessions, tabs } = globalThis.browser;
    const { setTabValue } = sessions;
    const { remove } = tabs;
    sessions.setTabValue = async () => {
      throw new Error('Marker write failed');
    };
    // Firefox fires onRemoved for tabs the extension closes.
    tabs.remove = async (id) => {
      await remove(id);
      setImmediate(() => state.events.removed.listener(id, {
        windowId: 10,
        isWindowClosing: false,
      }));
    };
    try {
      const pins = [{ url: 'https://example.com/', reload: true }];
      state.setStored({ pins, privateWindows: false });
      await quietly(async () => {
        await state.events.storage.listener({
          settings: {
            oldValue: { pins: [], privateWindows: false },
            newValue: { pins, privateWindows: false },
          },
        }, 'sync');
        await settle();
      });
    } finally {
      sessions.setTabValue = setTabValue;
      tabs.remove = remove;
    }
    assert.deepEqual(state.calls.map(([name]) => name), ['create', 'remove']);
  });

  await t.test('clearing the settings releases tabs even after a failed check', async () => {
    const state = await setupThree();
    state.setStored(undefined);
    state.failSessionRead(1);
    await quietly(() => state.events.storage.listener({
      settings: {
        oldValue: {
          pins: [A, B, C].map(([id, url]) => ({ id, url, reload: true })),
          privateWindows: false,
        },
      },
    }, 'sync'));
    assert.equal(state.tabs[0].pinned, true);
    // Even after the background script restarts, the next tick releases them.
    await state.wakeBackground();
    await state.tick();
    assert.deepEqual(state.tabs.map(({ pinned }) => pinned), [false, false, false]);
    assert.equal(state.markers.size, 0);
  });

  await t.test('saving settings again ends the cleared state', async () => {
    const state = await setupThree();
    const pins = [A, B, C].map(([id, url]) => ({ id, url, reload: true }));
    state.setStored(undefined);
    await state.events.storage.listener({
      settings: { oldValue: { pins, privateWindows: false } },
    }, 'sync');
    state.setStored({ pins: pins.slice(0, 1), privateWindows: false });
    await state.events.storage.listener({
      settings: { newValue: { pins: pins.slice(0, 1), privateWindows: false } },
    }, 'sync');
    // Were the flag left behind, a later loss of settings would release tabs
    // instead of waiting for them to load.
    state.setStored(undefined);
    await state.tick();
    assert.equal(state.tabs.filter(({ pinned }) => pinned).length, 1);
  });

  await t.test('clearing the settings releases managed tabs', async () => {
    const state = await setupThree();
    state.setStored(undefined);
    await state.events.storage.listener({
      settings: {
        oldValue: {
          pins: [A, B, C].map(([id, url]) => ({ id, url, reload: true })),
          privateWindows: false,
        },
      },
    }, 'sync');
    assert.deepEqual(state.tabs.map(({ pinned }) => pinned), [false, false, false]);
    assert.equal(state.markers.size, 0);
  });

  await t.test('a failed marker write after navigating is recovered on click', async () => {
    const state = await setupThree();
    const edited = 'https://x.example/';
    // The tab navigates, then recording its new URL fails.
    state.failMarker(1);
    await quietly(() => state.changePins([A, ['b', edited], C]));
    assert.equal(state.tabs[1].url, edited);
    assert.deepEqual(state.markers.get(2), { id: 'b', url: null });

    // Clicking it runs a check instead of skipping the reload for good.
    state.calls.length = 0;
    await state.events.activated.listener({ tabId: 2 });
    assert.deepEqual(state.markers.get(2), { id: 'b', url: edited });

    // From then on it reloads as usual.
    state.calls.length = 0;
    await state.events.activated.listener({ tabId: 2 });
    assert.deepEqual(state.calls, [
      ['update', 2, { url: edited, loadReplace: true }],
    ]);
  });

  await t.test('reverting an edit whose marker write failed restores the tab', async () => {
    const state = await setupThree();
    state.failMarker(1);
    await quietly(() => state.changePins([A, ['b', 'https://x.example/'], C]));
    await state.changePins([A, B, C]);
    assert.equal(state.tabs[1].url, ABC[1]);
    assert.deepEqual(state.markers.get(2), { id: 'b', url: ABC[1] });
  });

  await t.test('a failed navigation is retried by the next check', async () => {
    const state = await setupThree();
    const edited = 'https://x.example/';
    state.failUpdate(2);
    await quietly(() => state.changePins([A, ['b', edited], C]));
    assert.equal(state.tabs[1].url, ABC[1]);
    await state.events.activated.listener({ tabId: 2 });
    assert.equal(state.tabs[1].url, edited);
    assert.deepEqual(state.markers.get(2), { id: 'b', url: edited });
  });

  await t.test('adding a pin leaves the others alone', async () => {
    const state = await setupThree();
    const added = 'https://d.example/';
    await state.changePins([A, B, C, ['d', added]]);
    assert.deepEqual(state.calls, [[
      'create',
      { windowId: 10, url: added, active: false, pinned: true },
    ]]);
  });

  await t.test('deleting a pin and adding another releases the old tab', async () => {
    const state = await setupThree();
    const added = 'https://d.example/';
    await state.changePins([A, B, ['d', added]]);
    assert.deepEqual(state.calls.slice(0, 2), [
      ['update', 3, { pinned: false }],
      ['create', { windowId: 10, url: added, active: false, pinned: true }],
    ]);
    assert.equal(state.tabs[2].url, ABC[2]);
    assert.equal(state.markers.has(3), false);
  });

  await t.test('1.0.0 tabs are released and replaced after the update', async () => {
    const urls = ['https://a.example/', 'https://b.example/'];
    const state = await setup({
      urls,
      initialTabs: urls.map((url, index) => ({
        id: index + 1,
        windowId: 10,
        index,
        pinned: true,
        incognito: false,
        url,
        marker: String(index),
      })),
    });
    // The old tabs keep their pages, unpinned and unmanaged.
    for (const [index, url] of urls.entries()) {
      assert.equal(state.tabs[index].pinned, false);
      assert.equal(state.tabs[index].url, url);
      assert.equal(state.markers.has(index + 1), false);
    }

    const fresh = state.tabs.filter(({ pinned }) => pinned);
    assert.deepEqual(fresh.map(({ url }) => url), urls);
    assert.deepEqual(
      fresh.map(({ id }) => state.markers.get(id)),
      urls.map((url) => ({ id: url, url })),
    );
  });

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
      assert.deepEqual(state.markers.get(1), { id: 'https://example.com/', url: 'https://example.com/' });
    } finally {
      console.error = originalError;
    }
  });

  await t.test('missing sync data preserves managed tabs', async () => {
    const state = await setup({ missingSettings: true });
    assert.deepEqual(state.bootCalls, []);
    assert.equal(state.tabs[0].pinned, true);
    assert.deepEqual(state.markers.get(1), { id: 'https://example.com/', url: 'https://example.com/' });

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
    const state = await setup({ ids: ['p'] });
    state.setStored({
      pins: [{ id: 'p', url: 'https://example.com/', reload: true }],
      privateWindows: true,
    });
    await state.events.storage.listener({
      settings: {
        oldValue: {
          pins: [{ id: 'p', url: 'https://example.com/', reload: true }],
          privateWindows: false,
        },
        newValue: {
          pins: [{ id: 'p', url: 'https://example.com/', reload: true }],
          privateWindows: true,
        },
      },
    }, 'sync');
    assert.deepEqual(state.calls, []);

    state.setStored({ pins: [{ id: 'p', url: 'https://example.net/', reload: true }], privateWindows: false });
    await state.events.storage.listener({
      settings: {
        oldValue: {
          pins: [{ id: 'p', url: 'https://example.com/', reload: true }],
          privateWindows: true,
        },
        newValue: {
          pins: [{ id: 'p', url: 'https://example.net/', reload: true }],
          privateWindows: false,
        },
      },
    }, 'sync');
    assert.deepEqual(state.calls, [[
      'update',
      1,
      { pinned: true, url: 'https://example.net/', loadReplace: true },
    ]]);
    assert.deepEqual(state.markers.get(1), { id: 'p', url: 'https://example.net/' });
  });

  await t.test('no-op storage notifications do nothing', async () => {
    const state = await setup();
    await state.events.storage.listener({
      settings: {
        oldValue: {
          pins: [{ url: 'https://example.com/', reload: true }],
          privateWindows: false,
        },
        newValue: {
          pins: [{ url: 'https://example.com/', reload: true }],
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

  await t.test('activation skips reload when disabled for the slot', async () => {
    const state = await setup({ urls: ['https://example.net/'] });
    state.setStored({
      pins: [{ url: 'https://example.net/', reload: false }],
      privateWindows: false,
    });
    await state.events.activated.listener({ tabId: 1 });
    assert.deepEqual(state.calls, []);
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
    state.markers.set(2, { id: 'https://example.com/', url: 'https://example.com/' });
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
    state.markers.set(2, { id: 'https://example.com/', url: 'https://example.com/' });
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
    assert.deepEqual(state.markers.get(2), { id: 'https://example.com/', url: 'https://example.com/' });
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
    state.markers.set(2, { id: 'https://example.com/', url: 'https://example.com/' });
    state.failUpdate(2);
    const change = {
      settings: {
        oldValue: {
          pins: [{ url: 'https://example.com/', reload: true }],
          privateWindows: false,
        },
        newValue: {
          pins: [{ url: 'https://example.com/', reload: true }],
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
      pins: [{ url: 'https://example.com/', reload: true }],
      privateWindows: true,
    });
    state.failSessionRead(1);
    const originalError = console.error;
    console.error = () => {};
    try {
      await state.events.storage.listener({
        settings: {
          oldValue: {
            pins: [{ url: 'https://example.com/', reload: true }],
            privateWindows: false,
          },
          newValue: {
            pins: [{ url: 'https://example.com/', reload: true }],
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
    state.setStored({ pins: [{ url: 'https://example.com/', reload: true }], privateWindows: false });
    state.failMarker();
    const originalError = console.error;
    console.error = () => {};
    try {
      await state.events.storage.listener({
        settings: {
          oldValue: { pins: [], privateWindows: false },
          newValue: {
            pins: [{ url: 'https://example.com/', reload: true }],
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
    state.setStored({ pins: 'https://invalid.example', privateWindows: false });
    const originalError = console.error;
    console.error = () => {};
    try {
      await state.events.storage.listener({
        settings: {
          oldValue: {
            pins: [{ url: 'https://example.com/', reload: true }],
            privateWindows: false,
          },
          newValue: {
            pins: 'https://invalid.example',
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
