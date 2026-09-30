import {
  findSettings,
  loadSettings,
  parseMarker,
  partitionSlots,
} from './config.mjs';

const SLOT_KEY = 'tabnesiaSlot';
const BOOTSTRAP_KEY = 'tabnesiaBootstrapped';
// Every window is checked this often, so whatever made an earlier check
// fail, the next one repairs it.
const CHECK_ALARM = 'tabnesiaCheck';
const CHECK_PERIOD_MINUTES = 1;
// Set in storage.local while the settings are cleared, so every check,
// including the periodic one after a failure, releases the managed tabs.
const CLEARED_KEY = 'tabnesiaCleared';
// Pending checks by window; true when the settings were just cleared.
const pending = new Map();
const locks = new Map();
const running = new Map();
const managedIds = new Set();
// Tabs closed here to roll back a failed creation; their removal must not
// trigger another check, or a persistent failure would loop.
const rollbacks = new Set();
const initializedWindows = new Set();
let bootstrapTask;

async function release(tab) {
  if (tab.pinned) await browser.tabs.update(tab.id, { pinned: false });
  await browser.sessions.removeTabValue(tab.id, SLOT_KEY);
  managedIds.delete(tab.id);
}

async function reconcileWindow(windowId, cleared) {
  let window;
  try {
    window = await browser.windows.get(windowId);
  } catch {
    return;
  }
  if (window.type !== 'normal') return;
  // Missing settings mean "not configured yet" (so a startup before they
  // load changes nothing) unless they were cleared, in which case managed
  // tabs are released.
  let current = await findSettings(browser.storage);
  if (!current && (cleared || (
    await browser.storage.local.get(CLEARED_KEY)
  )[CLEARED_KEY])) {
    current = await loadSettings(browser.storage);
  }
  if (!current) {
    initializedWindows.add(windowId);
    return;
  }
  const privateAllowed = !window.incognito
    || await browser.extension.isAllowedIncognitoAccess();
  const shouldManage = !window.incognito
    || (current.privateWindows && privateAllowed);
  const tabs = await browser.tabs.query({ windowId });
  const tagged = (await Promise.all(tabs.map(async (tab) => {
    try {
      return {
        tab,
        marker: await browser.sessions.getTabValue(tab.id, SLOT_KEY),
      };
    } catch (error) {
      try {
        await browser.tabs.get(tab.id);
      } catch {
        return null;
      }
      throw error;
    }
  }))).filter(Boolean);
  tagged.forEach(({ tab, marker }) => {
    if (marker !== undefined) managedIds.add(tab.id);
  });
  const pins = shouldManage ? current.pins : [];
  const { slots, extras } = partitionSlots(tagged, pins);

  // Every release finishes before this check ends or fails: one still
  // running after the next check starts could erase a marker it writes.
  const released = await Promise.allSettled(extras.map(release));
  const failure = released.find(({ status }) => status === 'rejected');
  if (failure) throw failure.reason;
  if (!shouldManage) {
    initializedWindows.add(windowId);
    return;
  }

  for (let slot = 0; slot < pins.length; slot += 1) {
    const { id, url } = pins[slot];
    let tab = slots[slot]?.tab;
    if (!tab) {
      tab = await browser.tabs.create({
        windowId,
        url,
        active: false,
        pinned: true,
      });
      try {
        await browser.sessions.setTabValue(tab.id, SLOT_KEY, { id, url });
      } catch (error) {
        rollbacks.add(tab.id);
        await browser.tabs.remove(tab.id).catch((removeError) => {
          rollbacks.delete(tab.id);
          console.error(removeError);
        });
        throw error;
      }
      managedIds.add(tab.id);
    } else {
      // Only a pin whose URL was edited navigates its tab; tabs that merely
      // moved keep their page.
      const navigate = slots[slot].marker.url !== url;
      if (navigate) {
        await browser.sessions.setTabValue(tab.id, SLOT_KEY, { id, url: null });
      }
      if (!tab.pinned || navigate) {
        tab = await browser.tabs.update(tab.id, {
          pinned: true,
          ...(navigate && { url, loadReplace: true }),
        });
      }
      if (navigate) {
        await browser.sessions.setTabValue(tab.id, SLOT_KEY, { id, url });
      }
    }
    slots[slot] = tab;
  }

  if (!slots.length) {
    initializedWindows.add(windowId);
    return;
  }
  const latest = await browser.tabs.query({ windowId });
  const indexes = new Map(latest.map((tab) => [tab.id, tab.index]));
  if (slots.some((tab, slot) => indexes.get(tab.id) !== slot)) {
    // A slot tab can close between the query and the move; the next tab
    // event re-reconciles, so a failed move is safe to swallow.
    await browser.tabs.move(slots.map((tab) => tab.id), { index: 0 })
      .catch(console.error);
  }
  initializedWindows.add(windowId);
}

// Runs `task` once every earlier operation on the window has settled, so a
// check and an activation reload never interleave their reads and writes.
function exclusive(windowId, task) {
  const result = (locks.get(windowId) ?? Promise.resolve()).then(task);
  const settled = result.catch(() => {});
  locks.set(windowId, settled);
  settled.then(() => {
    if (locks.get(windowId) === settled) locks.delete(windowId);
  });
  return result;
}

function schedule(windowId, cleared = false) {
  pending.set(windowId, pending.get(windowId) === true || cleared);
  if (running.has(windowId)) return running.get(windowId);

  const task = (async () => {
    while (pending.has(windowId)) {
      const wasCleared = pending.get(windowId);
      pending.delete(windowId);
      await exclusive(windowId, () => reconcileWindow(windowId, wasCleared));
    }
  })().finally(() => {
    running.delete(windowId);
    if (pending.has(windowId)) schedule(windowId).catch(console.error);
  });

  running.set(windowId, task);
  return task;
}

async function reconcileAll(cleared = false) {
  const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
  await Promise.all(windows.map((window) => schedule(window.id, cleared)));
}

// Reloads an activated managed tab at its pin's URL. Returns false when the
// tab is out of step with its pin (a navigation that did not finish, or a
// pin edited or deleted without a check since): that needs a check, which
// navigates or releases it, not a reload of its old URL.
async function reloadActivated(tab) {
  const marker = parseMarker(
    await browser.sessions.getTabValue(tab.id, SLOT_KEY),
  );
  if (!marker) return true;
  const current = await findSettings(browser.storage);
  if (!current) return true;
  const pin = current.pins.find(({ id }) => id === marker.id);
  if (!pin || pin.url !== marker.url) return false;
  if (pin.reload === false) return true;
  if (tab.incognito && (
    !current.privateWindows
    || !await browser.extension.isAllowedIncognitoAccess()
  )) return true;
  await browser.tabs.update(tab.id, { url: pin.url, loadReplace: true });
  return true;
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.pinned) return;
    // Under the window's lock, so an edit's check cannot land between
    // reading the settings and reloading. The check itself needs the lock,
    // so it runs after.
    const inStep = await exclusive(tab.windowId, () => reloadActivated(tab));
    if (!inStep) await schedule(tab.windowId);
  } catch (error) {
    console.error(error);
  }
});

browser.tabs.onCreated.addListener(async (tab) => {
  if (!tab.pinned) return undefined;
  try {
    if (await browser.sessions.getTabValue(tab.id, SLOT_KEY) !== undefined) {
      return schedule(tab.windowId).catch(console.error);
    }
  } catch {
    // The tab disappeared before Firefox delivered the event.
  }
  return undefined;
});
browser.tabs.onUpdated.addListener((_tabId, _change, tab) => {
  if (tab.pinned || managedIds.has(tab.id)
      || !initializedWindows.has(tab.windowId)) {
    schedule(tab.windowId).catch(console.error);
  }
}, { properties: ['pinned'] });
browser.tabs.onMoved.addListener(async (tabId, info) => {
  try {
    if ((await browser.tabs.get(tabId)).pinned) {
      schedule(info.windowId).catch(console.error);
    }
  } catch {
    // The tab disappeared before Firefox delivered the event.
  }
});
browser.tabs.onAttached.addListener((_tabId, info) => (
  schedule(info.newWindowId).catch(console.error)
));
browser.tabs.onDetached.addListener((_tabId, info) => (
  schedule(info.oldWindowId).catch(console.error)
));
browser.tabs.onRemoved.addListener((tabId, info) => {
  if (rollbacks.delete(tabId)) return undefined;
  const wasManaged = managedIds.delete(tabId);
  if (!info.isWindowClosing
      && (wasManaged || !initializedWindows.has(info.windowId))) {
    return schedule(info.windowId).catch(console.error);
  }
  return undefined;
});
browser.windows.onCreated.addListener((window) => (
  schedule(window.id).catch(console.error)
));
browser.windows.onRemoved.addListener((windowId) => {
  pending.delete(windowId);
  initializedWindows.delete(windowId);
});

function changed(change) {
  return change
    && JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.settings) return undefined;
  const { oldValue, newValue } = changes.settings;
  // Ids default to URLs, as in parseSettings.
  const pinsOf = (value) => (
    Array.isArray(value?.pins)
      ? value.pins.map((p) => [p?.id || p?.url, p?.url])
      : undefined
  );
  const pinsChanged = changed({
    oldValue: pinsOf(oldValue),
    newValue: pinsOf(newValue),
  });
  const privateChanged = changed({
    oldValue: oldValue?.privateWindows,
    newValue: newValue?.privateWindows,
  });
  if (pinsChanged || privateChanged) {
    return recordCleared(newValue === undefined)
      .then(() => reconcileAll(newValue === undefined))
      .catch(console.error);
  }
  return undefined;
});

// Records whether the settings are cleared. If that fails, the check that
// follows still knows (it is told directly); only if it fails too do the
// managed tabs wait for the settings to be cleared or saved again.
async function recordCleared(cleared) {
  try {
    if (cleared) await browser.storage.local.set({ [CLEARED_KEY]: true });
    else await browser.storage.local.remove(CLEARED_KEY);
  } catch (error) {
    console.error(error);
  }
}
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) return reconcileAll().catch(console.error);
  return undefined;
});
// Created only when missing: re-creating it on every wake of this script
// would restart its timer, and frequent wakes could keep it from firing.
browser.alarms.get(CHECK_ALARM).then((alarm) => (
  alarm ?? browser.alarms.create(CHECK_ALARM, {
    periodInMinutes: CHECK_PERIOD_MINUTES,
  })
)).catch(console.error);

browser.action.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

browser.runtime.onStartup.addListener(() => (
  bootstrap().catch(console.error)
));
browser.runtime.onInstalled.addListener(() => (
  bootstrap().catch(console.error)
));

function bootstrap() {
  bootstrapTask ??= (async () => {
    const state = await browser.storage.session.get(BOOTSTRAP_KEY);
    if (state[BOOTSTRAP_KEY]) return;
    await reconcileAll();
    await browser.storage.session.set({ [BOOTSTRAP_KEY]: true });
  })().catch((error) => {
    bootstrapTask = undefined;
    throw error;
  });
  return bootstrapTask;
}

bootstrap().catch(console.error);
