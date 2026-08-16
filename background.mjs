import { findSettings, parseSlot, partitionSlots } from './config.mjs';

const SLOT_KEY = 'tabnesiaSlot';
const BOOTSTRAP_KEY = 'tabnesiaBootstrapped';
const pending = new Map();
const running = new Map();
const managedIds = new Set();
const initializedWindows = new Set();
let bootstrapTask;

async function release(tab) {
  if (tab.pinned) await browser.tabs.update(tab.id, { pinned: false });
  await browser.sessions.removeTabValue(tab.id, SLOT_KEY);
  managedIds.delete(tab.id);
}

async function reconcileWindow(windowId, resetUrls = false) {
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
        slot: await browser.sessions.getTabValue(tab.id, SLOT_KEY),
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
  tagged.forEach(({ tab, slot }) => {
    if (slot !== undefined) managedIds.add(tab.id);
  });
  const count = shouldManage ? current.urls.length : 0;
  const { slots, extras } = partitionSlots(tagged, count);

  await Promise.all(extras.map(release));
  if (!shouldManage) {
    initializedWindows.add(windowId);
    return;
  }

  for (let slot = 0; slot < current.urls.length; slot += 1) {
    let tab = slots[slot];
    if (!tab) {
      tab = await browser.tabs.create({
        windowId,
        url: current.urls[slot],
        active: false,
        pinned: true,
      });
      try {
        await browser.sessions.setTabValue(tab.id, SLOT_KEY, String(slot));
      } catch (error) {
        await browser.tabs.remove(tab.id).catch(console.error);
        throw error;
      }
      managedIds.add(tab.id);
    } else if (!tab.pinned || resetUrls) {
      tab = await browser.tabs.update(tab.id, {
        pinned: true,
        ...(resetUrls && { url: current.urls[slot], loadReplace: true }),
      });
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
    await browser.tabs.move(slots.map((tab) => tab.id), { index: 0 });
  }
  initializedWindows.add(windowId);
}

function schedule(windowId, resetUrls = false) {
  pending.set(windowId, pending.get(windowId) === true || resetUrls);
  if (running.has(windowId)) return running.get(windowId);

  const task = (async () => {
    while (pending.has(windowId)) {
      const reset = pending.get(windowId);
      pending.delete(windowId);
      await reconcileWindow(windowId, reset);
    }
  })().finally(() => {
    running.delete(windowId);
    if (pending.has(windowId)) schedule(windowId).catch(console.error);
  });

  running.set(windowId, task);
  return task;
}

async function reconcileAll(resetUrls = false) {
  const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
  await Promise.all(windows.map((window) => schedule(window.id, resetUrls)));
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.pinned) return;
    const marker = await browser.sessions.getTabValue(tabId, SLOT_KEY);
    const slot = parseSlot(marker);
    if (slot < 0) return;
    const current = await findSettings(browser.storage);
    if (!current?.urls[slot] || current.reload[slot] === false) return;
    if (tab.incognito && (
      !current.privateWindows
      || !await browser.extension.isAllowedIncognitoAccess()
    )) return;
    await browser.tabs.update(tabId, {
      url: current.urls[slot],
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
  const urlsChanged = changed({
    oldValue: oldValue?.urls,
    newValue: newValue?.urls,
  });
  const privateChanged = changed({
    oldValue: oldValue?.privateWindows,
    newValue: newValue?.privateWindows,
  });
  if (urlsChanged || privateChanged) {
    return reconcileAll(urlsChanged).catch(console.error);
  }
  return undefined;
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
