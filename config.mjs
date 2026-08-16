const DEFAULT_SETTINGS = { pins: [], privateWindows: false };
const SYNC_ITEM_LIMIT = 8192;
const SETTINGS_KEY = 'settings';

const t = (key, substitutions) => browser.i18n.getMessage(key, substitutions);

export function normalizeUrls(values) {
  const seen = new Set();

  return values.map((value, index) => {
    if (typeof value !== 'string') {
      throw new Error(t('errorInvalidUrl', String(index + 1)));
    }
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(t('errorInvalidUrl', String(index + 1)));
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(t('errorScheme', String(index + 1)));
    }
    if (seen.has(url.href)) {
      throw new Error(t('errorDuplicate', [String(index + 1), url.href]));
    }
    seen.add(url.href);
    return url.href;
  });
}

export function parseSettings(value) {
  if (
    !Array.isArray(value?.pins)
    || typeof value.privateWindows !== 'boolean'
  ) {
    throw new Error(t('errorInvalidSettings'));
  }

  const urls = normalizeUrls(value.pins.map((p) => p.url));
  const pins = urls.map((url, i) => ({
    url,
    reload: value.pins[i].reload !== false,
  }));
  return { pins, privateWindows: value.privateWindows };
}

export async function saveSettings(storage, value) {
  const current = parseSettings(value);
  const bytes = new TextEncoder().encode(
    `${SETTINGS_KEY}${JSON.stringify(current)}`,
  );
  if (bytes.length > SYNC_ITEM_LIMIT) {
    throw new Error(t('errorSyncLimit'));
  }
  await storage.sync.set({ [SETTINGS_KEY]: current });
  return current;
}

export async function findSettings(storage) {
  const synced = await storage.sync.get(SETTINGS_KEY);
  if (Object.hasOwn(synced, SETTINGS_KEY)) {
    return parseSettings(synced[SETTINGS_KEY]);
  }
  return null;
}

export async function loadSettings(storage) {
  return await findSettings(storage) ?? { ...DEFAULT_SETTINGS };
}

export function parseBackup(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(t('errorInvalidJson'));
  }

  if (value?.version !== 1) {
    throw new Error(t('errorInvalidBackup'));
  }

  try {
    return parseSettings(value);
  } catch {
    throw new Error(t('errorInvalidBackup'));
  }
}

export function parseSlot(marker) {
  return typeof marker === 'string' && /^\d+$/.test(marker)
    ? Number(marker)
    : -1;
}

export function partitionSlots(taggedTabs, count) {
  const slots = Array(count);
  const extras = [];

  for (const { tab, slot } of taggedTabs) {
    const index = parseSlot(slot);
    if (index >= 0 && index < count && slots[index] === undefined) {
      slots[index] = tab;
    } else if (slot !== undefined) {
      extras.push(tab);
    }
  }

  return { slots, extras };
}
