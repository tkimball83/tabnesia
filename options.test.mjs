import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getMessage } from './i18n-mock.mjs';

let moduleNumber = 0;
let focused;

function makeEl(className = '') {
  const node = {
    classes: new Set(className ? [className] : []),
    children: [],
    parent: null,
    isRoot: false,
    hidden: false,
    inert: false,
    disabled: false,
    checked: false,
    textContent: '',
    value: '',
    offsetHeight: 10,
    listeners: {},
    classList: {
      add: (name) => node.classes.add(name),
      remove: (name) => node.classes.delete(name),
    },
    addEventListener(type, listener) {
      (node.listeners[type] ??= []).push(listener);
    },
    async dispatch(type, event = {}) {
      for (const listener of node.listeners[type] ?? []) {
        await listener(event);
      }
    },
    matches(selector) {
      return selector.split(',')
        .some((part) => node.classes.has(part.trim().slice(1)));
    },
    closest(selector) {
      let current = node;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parent;
      }
      return null;
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const found = [];
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    },
    append(...nodes) {
      for (const child of nodes) {
        child.remove();
        child.parent = node;
        node.children.push(child);
      }
    },
    replaceChildren() {
      for (const child of node.children) child.parent = null;
      node.children = [];
    },
    insertBefore(child, reference) {
      if (reference === child) return child;
      child.remove();
      child.parent = node;
      const index = reference ? node.children.indexOf(reference) : -1;
      if (index < 0) node.children.push(child);
      else node.children.splice(index, 0, child);
      return child;
    },
    remove() {
      if (!node.parent) return;
      const siblings = node.parent.children;
      siblings.splice(siblings.indexOf(node), 1);
      node.parent = null;
    },
    after(sibling) {
      const { parent } = node;
      const next = node.nextElementSibling;
      sibling.remove();
      sibling.parent = parent;
      const index = next ? parent.children.indexOf(next) : -1;
      if (index < 0) parent.children.push(sibling);
      else parent.children.splice(index, 0, sibling);
    },
    get previousElementSibling() {
      const siblings = node.parent?.children ?? [];
      return siblings[siblings.indexOf(node) - 1] ?? null;
    },
    get nextElementSibling() {
      const siblings = node.parent?.children ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    get isConnected() {
      let current = node;
      while (current.parent) current = current.parent;
      return current.isRoot;
    },
    focus() {
      if (!node.disabled) focused = node;
    },
    getBoundingClientRect() {
      return { top: node.parent.children.indexOf(node) * 10 };
    },
  };
  return node;
}

function makeRow() {
  const row = makeEl('pin');
  row.append(
    makeEl('drag'),
    makeEl('url'),
    makeEl('up'),
    makeEl('down'),
    makeEl('remove'),
  );
  return row;
}

async function setup({ urls } = {}) {
  focused = undefined;
  const ids = Object.fromEntries([
    'settings', 'pins', 'private-windows', 'private-help',
    'status', 'external-change', 'pin-limit', 'add', 'export', 'import',
  ].map((id) => [id, makeEl()]));
  ids['external-change'].hidden = true;
  ids['pin-limit'].hidden = true;
  ids.pins.isRoot = true;
  ids['row-template'] = {
    content: {
      firstElementChild: { cloneNode: () => makeRow() },
      querySelectorAll: () => [],
    },
  };

  globalThis.document = {
    documentElement: {},
    querySelector: (selector) => ids[selector.slice(1)],
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => ({ click() {} }),
  };

  let pendingSet;
  let setCalls = 0;
  let storageListener;
  globalThis.browser = {
    extension: { isAllowedIncognitoAccess: async () => true },
    i18n: { getMessage, getUILanguage: () => 'en-US' },
    storage: {
      sync: {
        get: async () => (
          urls ? { settings: { urls, privateWindows: false } } : {}
        ),
        set: () => new Promise((resolve, reject) => {
          setCalls += 1;
          pendingSet = { resolve, reject };
        }),
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        },
      },
    },
  };

  await import(`./options.mjs?test=${moduleNumber}`);
  moduleNumber += 1;
  await new Promise(setImmediate);

  const list = ids.pins;
  return {
    list,
    status: ids.status,
    warning: ids['external-change'],
    pinLimit: ids['pin-limit'],
    add: ids.add,
    row: (index) => list.children[index],
    urls: () => list.children.map((row) => row.querySelector('.url').value),
    focused: () => focused,
    click: (target) => list.dispatch('click', { target }),
    drag: {
      start: (row) => list.dispatch('dragstart', {
        target: row.querySelector('.drag'),
        dataTransfer: { setData() {} },
      }),
      startFromInput: (row) => list.dispatch('dragstart', {
        target: row.querySelector('.url'),
        dataTransfer: { setData() {} },
      }),
      over: (row, below) => list.dispatch('dragover', {
        target: row,
        clientY: row.getBoundingClientRect().top + (below ? 9 : 1),
        preventDefault() {},
      }),
      drop: () => list.dispatch('drop', { preventDefault() {} }),
      end: () => list.dispatch('dragend'),
    },
    externalChange: (settings) => storageListener(
      { settings: { newValue: settings } },
      'sync',
    ),
    rawChange: (changes, area) => storageListener(changes, area),
    submit: () => ids.settings.dispatch('submit', { preventDefault() {} }),
    importFile: (text) => ids.import.dispatch('change', {
      target: { files: [{ text: async () => text }], value: '' },
    }),
    finishSet: async () => {
      while (!pendingSet) await new Promise(setImmediate);
      pendingSet.resolve();
      pendingSet = undefined;
    },
    failSet: async () => {
      while (!pendingSet) await new Promise(setImmediate);
      pendingSet.reject(new Error('Sync unavailable'));
      pendingSet = undefined;
    },
    setCalls: () => setCalls,
  };
}

const THREE = [
  'https://a.example/',
  'https://b.example/',
  'https://c.example/',
];
const FOREIGN = { urls: ['https://example.net/'], privateWindows: true };
const OWN = { urls: [], privateWindows: false };

test('static i18n keys resolve to messages', () => {
  const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
  const keys = [
    ...read('./options.html').matchAll(/data-i18n="([^"]+)"/g),
    ...read('./options.html').matchAll(/data-i18n-attr="[^=]+=([^"]+)"/g),
    ...read('./manifest.json').matchAll(/__MSG_(\w+)__/g),
    ...read('./options.mjs').matchAll(/\bt\('([^']+)'/g),
    ...read('./config.mjs').matchAll(/\bt\('([^']+)'/g),
  ].map((match) => match[1]);
  assert.ok(keys.length >= 30);
  for (const key of keys) assert.equal(typeof getMessage(key), 'string');
});

test('options page rows and reordering', async (t) => {
  await t.test('rows render with boundary buttons disabled', async () => {
    const state = await setup({ urls: THREE });
    assert.deepEqual(state.urls(), THREE);
    assert.equal(state.row(0).querySelector('.up').disabled, true);
    assert.equal(state.row(0).querySelector('.down').disabled, false);
    assert.equal(state.row(2).querySelector('.down').disabled, true);
    assert.equal(state.status.textContent, '');
  });

  await t.test('moves keep keyboard focus on the action', async () => {
    const state = await setup({ urls: THREE });
    const up = state.row(2).querySelector('.up');
    await state.click(up);
    assert.deepEqual(state.urls(), [THREE[0], THREE[2], THREE[1]]);
    assert.equal(state.focused(), up);
    assert.equal(state.status.textContent, 'Unsaved changes');

    await state.click(up);
    assert.deepEqual(state.urls(), [THREE[2], THREE[0], THREE[1]]);
    assert.equal(state.focused(), up.closest('.pin').querySelector('.down'));
    assert.equal(up.disabled, true);
  });

  await t.test('removing a row hands focus to a neighbor', async () => {
    const state = await setup({ urls: THREE });
    await state.click(state.row(1).querySelector('.remove'));
    assert.deepEqual(state.urls(), [THREE[0], THREE[2]]);
    assert.equal(state.focused(), state.row(1).querySelector('.remove'));

    await state.click(state.row(1).querySelector('.remove'));
    await state.click(state.row(0).querySelector('.remove'));
    assert.deepEqual(state.urls(), []);
    assert.equal(state.focused(), state.add);
  });

  await t.test('a soft warning appears past 15 pins', async () => {
    const many = Array.from(
      { length: 16 },
      (_, index) => `https://site${index}.example/`,
    );
    const state = await setup({ urls: many });
    assert.equal(state.pinLimit.hidden, false);
    await state.click(state.row(0).querySelector('.remove'));
    assert.equal(state.pinLimit.hidden, true);
  });

  await t.test('handle drags reorder and mark unsaved changes', async () => {
    const state = await setup({ urls: THREE });
    await state.drag.start(state.row(0));
    await state.drag.over(state.row(2), true);
    assert.deepEqual(state.urls(), [THREE[1], THREE[2], THREE[0]]);
    await state.drag.drop();
    await state.drag.end();
    assert.deepEqual(state.urls(), [THREE[1], THREE[2], THREE[0]]);
    assert.equal(state.status.textContent, 'Unsaved changes');
  });

  await t.test('drags from a URL input are ignored', async () => {
    const state = await setup({ urls: THREE });
    await state.drag.startFromInput(state.row(0));
    await state.drag.over(state.row(2), true);
    await state.drag.end();
    assert.deepEqual(state.urls(), THREE);
    assert.equal(state.status.textContent, '');
  });

  await t.test('cancelled drags revert to the original order', async () => {
    const state = await setup({ urls: THREE });
    await state.drag.start(state.row(0));
    await state.drag.over(state.row(2), true);
    assert.deepEqual(state.urls(), [THREE[1], THREE[2], THREE[0]]);
    await state.drag.end();
    assert.deepEqual(state.urls(), THREE);
    assert.equal(state.status.textContent, '');
  });
});

test('options page external-change warning', async (t) => {
  await t.test('external changes show the warning', async () => {
    const state = await setup();
    assert.equal(state.warning.hidden, true);
    await state.externalChange(FOREIGN);
    assert.equal(state.warning.hidden, false);
  });

  await t.test('the page\'s own save echo is suppressed', async () => {
    const state = await setup();
    const saving = state.submit();
    state.finishSet();
    await saving;
    assert.equal(state.status.textContent, 'Saved');
    await state.externalChange(OWN);
    assert.equal(state.warning.hidden, true);
  });

  await t.test('a change during a save survives the save', async () => {
    const state = await setup();
    const saving = state.submit();
    await state.externalChange(FOREIGN);
    state.finishSet();
    await saving;
    assert.equal(state.status.textContent, 'Saved');
    assert.equal(state.warning.hidden, false);
  });

  await t.test('a failed save keeps an existing warning', async () => {
    const state = await setup();
    await state.externalChange(FOREIGN);
    const saving = state.submit();
    state.failSet();
    await saving;
    assert.equal(state.status.textContent, 'Sync unavailable');
    assert.equal(state.warning.hidden, false);
  });

  await t.test('a change during a failed save survives it', async () => {
    const state = await setup();
    const saving = state.submit();
    await state.externalChange(FOREIGN);
    state.failSet();
    await saving;
    assert.equal(state.warning.hidden, false);
  });

  await t.test('saving over a seen warning clears it', async () => {
    const state = await setup();
    await state.externalChange(FOREIGN);
    const saving = state.submit();
    state.finishSet();
    await saving;
    assert.equal(state.status.textContent, 'Saved');
    assert.equal(state.warning.hidden, true);
  });

  await t.test('non-sync areas and other keys are ignored', async () => {
    const state = await setup();
    await state.rawChange({ settings: { newValue: FOREIGN } }, 'local');
    await state.rawChange({ other: { newValue: 1 } }, 'sync');
    assert.equal(state.warning.hidden, true);
  });

  await t.test('external deletion warns before and after a save', async () => {
    const fresh = await setup();
    await fresh.rawChange({ settings: { oldValue: FOREIGN } }, 'sync');
    assert.equal(fresh.warning.hidden, false);

    const saved = await setup();
    const saving = saved.submit();
    saved.finishSet();
    await saving;
    await saved.rawChange({ settings: { oldValue: OWN } }, 'sync');
    assert.equal(saved.warning.hidden, false);
  });

  await t.test('overlapping writes are serialized', async () => {
    const state = await setup();
    const first = state.submit();
    const second = state.submit();
    await new Promise(setImmediate);
    assert.equal(state.setCalls(), 1);
    state.finishSet();
    await first;
    await new Promise(setImmediate);
    assert.equal(state.setCalls(), 2);
    state.finishSet();
    await second;
    assert.equal(state.status.textContent, 'Saved');
    await state.externalChange(OWN);
    assert.equal(state.warning.hidden, true);
  });

  await t.test('a failed import does not adopt its fingerprint', async () => {
    const state = await setup();
    const backup = {
      version: 1,
      urls: ['https://b.example/'],
      privateWindows: false,
    };
    const importing = state.importFile(JSON.stringify(backup));
    await new Promise(setImmediate);
    state.failSet();
    await importing;
    assert.equal(state.status.textContent, 'Sync unavailable');

    await state.externalChange({
      urls: ['https://b.example/'],
      privateWindows: false,
    });
    assert.equal(state.warning.hidden, false);
  });

  await t.test('a failed re-save keeps suppressing the prior echo', async () => {
    const state = await setup({ urls: ['https://a.example/'] });
    const saving = state.submit();
    state.finishSet();
    await saving;
    assert.equal(state.status.textContent, 'Saved');

    state.row(0).querySelector('.url').value = 'not a url';
    await state.submit();
    assert.match(state.status.textContent, /not a valid URL/);

    await state.externalChange({
      urls: ['https://a.example/'],
      privateWindows: false,
    });
    assert.equal(state.warning.hidden, true);
  });
});
