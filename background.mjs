import { findSettings, parseMarker, partitionSlots } from './config.mjs';

const SLOT_KEY = 'tabnesiaSlot';
const BOOTSTRAP_KEY = 'tabnesiaBootstrapped';
const pending = new Set();
const running = new Map();
const managedIds = new Set();
const initializedWindows = new Set();
let bootstrapTask;

async function release(tab) {
  if (tab.pinned) await browser.tabs.update(tab.id, { pinned: false });
  await browser.sessions.removeTabValue(tab.id, SLOT_KEY);
  managedIds.delete(tab.id);
}

async function reconcileWindow(windowId) {
  let window;
  try {
    window = await browser.windows.get(windowId);
  } catch {
    return;
  }
  if (window.type !== 'normal') return;
  const current = await findSettings(browser.storage);
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

  await Promise.all(extras.map(release));
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
        await browser.tabs.remove(tab.id).catch(console.error);
        throw error;
      }
      managedIds.add(tab.id);
    } else {
      // Only a pin whose URL was edited navigates its tab; tabs that merely
      // moved keep their page.
      const navigate = slots[slot].marker.url !== url;
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

function schedule(windowId) {
  pending.add(windowId);
  if (running.has(windowId)) return running.get(windowId);

  const task = (async () => {
    while (pending.has(windowId)) {
      pending.delete(windowId);
      await reconcileWindow(windowId);
    }
  })().finally(() => {
    running.delete(windowId);
    if (pending.has(windowId)) schedule(windowId).catch(console.error);
  });

  running.set(windowId, task);
  return task;
}

async function reconcileAll() {
  const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
  await Promise.all(windows.map((window) => schedule(window.id)));
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.pinned) return;
    const marker = parseMarker(
      await browser.sessions.getTabValue(tabId, SLOT_KEY),
    );
    if (!marker) return;
    const current = await findSettings(browser.storage);
    // A pin whose URL no longer matches the tab has a check queued to
    // navigate it; reloading the old URL here would only be undone.
    const pin = current?.pins.find(({ id, url }) => (
      id === marker.id && url === marker.url
    ));
    if (!pin || pin.reload === false) return;
    if (tab.incognito && (
      !current.privateWindows
      || !await browser.extension.isAllowedIncognitoAccess()
    )) return;
    await browser.tabs.update(tabId, {
      url: pin.url,
      loadReplace: true,
    });
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
    return reconcileAll().catch(console.error);
  }
  return undefined;
});
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
