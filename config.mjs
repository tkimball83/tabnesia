const DEFAULT_SETTINGS = { urls: [], privateWindows: false };
const SYNC_ITEM_LIMIT = 8192;
const SETTINGS_KEY = 'settings';

export function normalizeUrls(values) {
  const seen = new Set();

  return values.map((value, index) => {
    if (typeof value !== 'string') {
      throw new Error(`Row ${index + 1} is not a valid URL.`);
    }
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(`Row ${index + 1} is not a valid URL.`);
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Row ${index + 1} must use http:// or https://.`);
    }
    if (seen.has(url.href)) {
      throw new Error(`Row ${index + 1} duplicates ${url.href}.`);
    }
    seen.add(url.href);
    return url.href;
  });
}

export function parseSettings(value) {
  if (
    !Array.isArray(value?.urls)
    || typeof value.privateWindows !== 'boolean'
  ) {
    throw new Error('Invalid tabnesia settings.');
  }

  return {
    urls: normalizeUrls(value.urls),
    privateWindows: value.privateWindows,
  };
}

export async function saveSettings(storage, value) {
  const current = parseSettings(value);
  const bytes = new TextEncoder().encode(
    `${SETTINGS_KEY}${JSON.stringify(current)}`,
  );
  if (bytes.length > SYNC_ITEM_LIMIT) {
    throw new Error('Pinned URLs exceed Firefox sync\'s 8 KB item limit.');
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
    throw new Error('The selected file is not valid JSON.');
  }

  if (value?.version !== 1) {
    throw new Error('The selected file is not a tabnesia version 1 backup.');
  }

  try {
    return parseSettings(value);
  } catch {
    throw new Error('The selected file is not a tabnesia version 1 backup.');
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
