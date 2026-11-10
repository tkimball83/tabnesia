import {
  DEFAULT_SETTINGS,
  InvalidSettingsError,
  SETTINGS_KEY,
  loadSettings,
  newPinId,
  parseBackup,
  parseSettings,
  saveSettings,
  serializeSettings,
} from './config.mjs';

const form = document.querySelector('#settings');
const list = document.querySelector('#pins');
const template = document.querySelector('#row-template');
const privateWindows = document.querySelector('#private-windows');
const privateHelp = document.querySelector('#private-help');
const status = document.querySelector('#status');
const externalWarning = document.querySelector('#external-change');
const pinLimit = document.querySelector('#pin-limit');
const saveButton = document.querySelector('#save');
const importInput = document.querySelector('#import');
const PIN_LIMIT = 15;
const t = (key, substitutions) => browser.i18n.getMessage(key, substitutions);
let dragged;
let draggedFrom;
let dropped;
let lastSaved;
let changeEpoch = 0;
// Until settings load, the form is empty; saving it would erase them.
let loaded = false;
let dirty = false;
let queue = Promise.resolve();

function localize(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    const [attr, key] = el.dataset.i18nAttr.split('=');
    el.setAttribute(attr, t(key));
  }
}
localize(document);
localize(template.content);
pinLimit.textContent = t('pinLimitWarning', String(PIN_LIMIT));

function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

// Runs an operation with the form inert. Inerting blurs whatever had focus,
// so focus goes back to it afterwards, or to Save if a re-render removed it.
async function whileInert(task) {
  const focused = document.activeElement;
  form.inert = true;
  try {
    await task();
  } finally {
    form.inert = false;
    (focused?.isConnected ? focused : saveButton).focus();
  }
}

function updateButtons() {
  const rows = [...list.children];
  rows.forEach((row, index) => {
    row.querySelector('.up').disabled = index === 0;
    row.querySelector('.down').disabled = index === rows.length - 1;
  });
  pinLimit.hidden = rows.length <= PIN_LIMIT;
}

// Each row keeps its pin's id, so editing a URL updates that pin's tab in
// place, while removing a row and adding another releases the old tab.
function addRow(url = '', reload = true, id = undefined) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.id = id ?? newPinId(
    new Set([...list.children].map((existing) => existing.dataset.id)),
  );
  row.querySelector('.url').value = url;
  row.querySelector('.reload').setAttribute('aria-pressed', String(reload));
  list.append(row);
  return row;
}

function render(pins) {
  list.replaceChildren();
  pins.forEach((pin) => addRow(pin.url, pin.reload, pin.id));
  updateButtons();
}

function changed() {
  dirty = true;
  status.textContent = t('statusUnsaved');
}

// Shows the outcome of an operation that left the form as it was.
function report(message) {
  status.textContent = dirty ? `${message} · ${t('statusUnsaved')}` : message;
}

async function restore() {
  let current;
  let invalid = false;
  try {
    current = await loadSettings(browser.storage);
  } catch (error) {
    // Settings that cannot be used start the form empty, so saving or
    // importing can replace them. A failed read is thrown on: saving then
    // could erase settings that are fine.
    if (!(error instanceof InvalidSettingsError)) throw error;
    current = DEFAULT_SETTINGS;
    invalid = true;
  }
  render(current.pins);
  privateWindows.checked = current.privateWindows;
  const allowed = await browser.extension.isAllowedIncognitoAccess();
  privateWindows.disabled = !allowed;
  privateHelp.hidden = allowed;
  status.textContent = invalid ? t('statusInvalidSettings') : '';
}

// Saves the settings `read` returns and shows them. `epoch` is the change
// count when the user acted: a change since then keeps its warning.
async function persist(read, savedMessage, epoch) {
  const previousSaved = lastSaved;
  try {
    const settings = await read();
    // Storage echoes the stored form, so fingerprint that.
    lastSaved = JSON.stringify(serializeSettings(settings));
    await saveSettings(browser.storage, settings);
    render(settings.pins);
    privateWindows.checked = settings.privateWindows;
    dirty = false;
    status.textContent = savedMessage;
    if (changeEpoch === epoch) externalWarning.hidden = true;
  } catch (error) {
    lastSaved = previousSaved;
    report(error.message);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!loaded) return undefined;
  const epoch = changeEpoch;
  return enqueue(() => whileInert(async () => {
    status.textContent = t('statusSaving');
    await persist(() => parseSettings({
      pins: [...list.children].map((row) => ({
        id: row.dataset.id,
        url: row.querySelector('.url').value,
        reload: row.querySelector('.reload')
          .getAttribute('aria-pressed') === 'true',
      })),
      privateWindows: privateWindows.checked,
    }), t('statusSaved'), epoch);
  }));
});

form.addEventListener('input', (event) => {
  // Choosing a backup file is not an edit of the form.
  if (event.target !== importInput) changed();
});
document.querySelector('#add').addEventListener('click', () => {
  addRow().querySelector('.url').focus();
  updateButtons();
  changed();
});

list.addEventListener('click', (event) => {
  const toggle = event.target.closest('.reload');
  if (toggle) {
    const pressed = toggle.getAttribute('aria-pressed') === 'true';
    toggle.setAttribute('aria-pressed', String(!pressed));
    changed();
    return;
  }
  const action = event.target.closest('.remove, .up, .down');
  if (!action) return;
  const row = event.target.closest('.pin');
  if (!row) return;
  if (action.matches('.remove')) {
    const neighbor = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    (neighbor?.querySelector('.remove') ?? document.querySelector('#add'))
      .focus();
  }
  if (action.matches('.up') && row.previousElementSibling) {
    list.insertBefore(row, row.previousElementSibling);
  }
  if (action.matches('.down') && row.nextElementSibling) {
    row.nextElementSibling.after(row);
  }
  updateButtons();
  if (action.isConnected) {
    (action.disabled
      ? row.querySelector(action.matches('.up') ? '.down' : '.up')
      : action
    ).focus();
  }
  changed();
});

list.addEventListener('dragstart', (event) => {
  if (!event.target.closest('.drag')) return;
  dragged = event.target.closest('.pin');
  draggedFrom = [...list.children].indexOf(dragged);
  dropped = false;
  dragged.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', '');
});

list.addEventListener('dragover', (event) => {
  if (!dragged) return;
  event.preventDefault();
  const row = event.target.closest('.pin');
  if (!row || row === dragged) return;
  const middle = row.getBoundingClientRect().top + row.offsetHeight / 2;
  const after = event.clientY > middle;
  list.insertBefore(dragged, after ? row.nextElementSibling : row);
});

list.addEventListener('drop', (event) => {
  if (!dragged) return;
  dropped = true;
  event.preventDefault();
});
list.addEventListener('dragend', () => {
  if (!dragged) return;
  dragged.classList.remove('dragging');
  if (!dropped) {
    const rows = [...list.children].filter((row) => row !== dragged);
    list.insertBefore(dragged, rows[draggedFrom] ?? null);
  }
  const moved = draggedFrom !== [...list.children].indexOf(dragged);
  dragged = undefined;
  draggedFrom = undefined;
  updateButtons();
  if (moved) changed();
});

document.querySelector('#export').addEventListener('click', () => (
  enqueue(() => whileInert(async () => {
    status.textContent = t('statusExporting');
    try {
      const current = await loadSettings(browser.storage);
      const blob = new Blob(
        [JSON.stringify({ version: 1, ...serializeSettings(current) }, null, 2)],
        { type: 'application/json' },
      );
      const href = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), {
        href,
        download: 'tabnesia-pins.json',
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
      report(t('statusExported'));
    } catch (error) {
      report(error.message);
    }
  }))
));

importInput.addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (!file || !loaded) return undefined;
  const epoch = changeEpoch;
  return enqueue(() => whileInert(async () => {
    status.textContent = t('statusImporting');
    await persist(
      async () => parseBackup(await file.text()),
      t('statusImported'),
      epoch,
    );
    event.target.value = '';
  }));
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[SETTINGS_KEY]) return;
  if (lastSaved !== undefined
      && JSON.stringify(changes[SETTINGS_KEY].newValue) === lastSaved) return;
  changeEpoch += 1;
  externalWarning.hidden = false;
});

// The form stays inert unless settings load: saving an empty form over
// settings that failed to load would erase them.
restore().then(() => {
  loaded = true;
  form.inert = false;
}, (error) => {
  status.textContent = `${error.message} ${t('statusReloadToRetry')}`;
});
