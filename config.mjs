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
    || !value.pins.every((pin) => typeof pin === 'object' && pin !== null)
    || typeof value.privateWindows !== 'boolean'
  ) {
    throw new Error(t('errorInvalidSettings'));
  }

  const urls = normalizeUrls(value.pins.map((p) => p.url));
  const ids = new Set();
  const pins = urls.map((url, i) => {
    // A pin's id stays with its row through edits and reordering. Pins
    // saved by 1.0.0 have none, so their URL stands in.
    const { id } = value.pins[i];
    const pinId = typeof id === 'string' && id ? id : url;
    if (ids.has(pinId)) throw new Error(t('errorInvalidSettings'));
    ids.add(pinId);
    return { id: pinId, url, reload: value.pins[i].reload !== false };
  });
  return { pins, privateWindows: value.privateWindows };
}

export function newPinId(taken) {
  let id;
  do {
    id = crypto.randomUUID().slice(0, 8);
  } while (taken.has(id));
  return id;
}

// The stored form of parsed settings. An id equal to its pin's URL is left
// out, since parseSettings derives the same id, so settings from 1.0.0 stay
// the size they were under Firefox sync's per-item limit.
export function serializeSettings(settings) {
  return {
    pins: settings.pins.map(({ id, url, reload }) => (
      id === url ? { url, reload } : { id, url, reload }
    )),
    privateWindows: settings.privateWindows,
  };
}

export async function saveSettings(storage, value) {
  const current = parseSettings(value);
  const stored = serializeSettings(current);
  const bytes = new TextEncoder().encode(
    `${SETTINGS_KEY}${JSON.stringify(stored)}`,
  );
  if (bytes.length > SYNC_ITEM_LIMIT) {
    throw new Error(t('errorSyncLimit'));
  }
  await storage.sync.set({ [SETTINGS_KEY]: stored });
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

// A managed tab's session marker names the pin it shows: { id, url }.
// Anything else, including 1.0.0's bare slot numbers, is not a marker this
// version understands, and its tab is released.
export function parseMarker(marker) {
  return typeof marker?.id === 'string' && marker.id
    && typeof marker.url === 'string'
    ? { id: marker.id, url: marker.url }
    : null;
}

// Matches managed tabs to pins by id: a tab keeps its pin wherever the pin
// moved and whatever its URL became. Every other managed tab, including
// duplicates and tabs of deleted pins, is released.
export function partitionSlots(taggedTabs, pins) {
  const slots = Array(pins.length);
  const extras = [];

  for (const entry of taggedTabs) {
    if (entry.marker === undefined) continue;
    const parsed = parseMarker(entry.marker);
    const index = parsed ? pins.findIndex((pin) => pin.id === parsed.id) : -1;
    if (index >= 0 && slots[index] === undefined) {
      slots[index] = { tab: entry.tab, marker: parsed };
    } else {
      extras.push(entry.tab);
    }
  }

  return { slots, extras };
}
