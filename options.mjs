import {
  loadSettings,
  parseBackup,
  parseSettings,
  saveSettings,
} from './config.mjs';

const form = document.querySelector('#settings');
const list = document.querySelector('#pins');
const template = document.querySelector('#row-template');
const privateWindows = document.querySelector('#private-windows');
const privateHelp = document.querySelector('#private-help');
const status = document.querySelector('#status');
const externalWarning = document.querySelector('#external-change');
const pinLimit = document.querySelector('#pin-limit');
const PIN_LIMIT = 15;
const t = (key) => browser.i18n.getMessage(key);
let dragged;
let draggedFrom;
let dropped;
let lastSaved;
let changeEpoch = 0;
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
document.documentElement.lang = browser.i18n.getUILanguage()
  .replaceAll('_', '-');
const dir = t('@@bidi_dir');
if (dir === 'ltr' || dir === 'rtl') document.documentElement.dir = dir;

function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

function updateButtons() {
  const rows = [...list.children];
  rows.forEach((row, index) => {
    row.querySelector('.up').disabled = index === 0;
    row.querySelector('.down').disabled = index === rows.length - 1;
  });
  pinLimit.hidden = rows.length <= PIN_LIMIT;
}

function addRow(url = '', reload = true) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.querySelector('.url').value = url;
  row.querySelector('.reload').setAttribute('aria-pressed', String(reload));
  list.append(row);
  return row;
}

function render(pins) {
  list.replaceChildren();
  pins.forEach((pin) => addRow(pin.url, pin.reload !== false));
  updateButtons();
}

function changed() {
  status.textContent = t('statusUnsaved');
}

async function refreshPrivateAccess() {
  const allowed = await browser.extension.isAllowedIncognitoAccess();
  privateWindows.disabled = !allowed;
  privateHelp.hidden = allowed;
}

async function restore() {
  const current = await loadSettings(browser.storage);
  render(current.pins);
  privateWindows.checked = current.privateWindows;
  await refreshPrivateAccess();
  status.textContent = '';
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const epoch = changeEpoch;
  return enqueue(async () => {
    status.textContent = t('statusSaving');
    form.inert = true;
    const previousSaved = lastSaved;
    try {
      const urls = [...list.querySelectorAll('.url')];
      const reloads = [...list.querySelectorAll('.reload')];
      const current = parseSettings({
        pins: urls.map((input, i) => ({
          url: input.value,
          reload: reloads[i].getAttribute('aria-pressed') === 'true',
        })),
        privateWindows: privateWindows.checked,
      });
      lastSaved = JSON.stringify(current);
      await saveSettings(browser.storage, current);
      render(current.pins);
      status.textContent = t('statusSaved');
      if (changeEpoch === epoch) externalWarning.hidden = true;
    } catch (error) {
      lastSaved = previousSaved;
      status.textContent = error.message;
    } finally {
      form.inert = false;
    }
  });
});

form.addEventListener('input', changed);
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
  enqueue(async () => {
    status.textContent = t('statusExporting');
    form.inert = true;
    try {
      const current = await loadSettings(browser.storage);
      const blob = new Blob(
        [JSON.stringify({ version: 1, ...current }, null, 2)],
        { type: 'application/json' },
      );
      const href = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), {
        href,
        download: 'tabnesia-pins.json',
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
      status.textContent = t('statusExported');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      form.inert = false;
    }
  })
));

document.querySelector('#import').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (!file) return undefined;
  const epoch = changeEpoch;
  return enqueue(async () => {
    status.textContent = t('statusImporting');
    form.inert = true;
    const previousSaved = lastSaved;
    try {
      const imported = parseBackup(await file.text());
      lastSaved = JSON.stringify(imported);
      await saveSettings(browser.storage, imported);
      render(imported.pins);
      privateWindows.checked = imported.privateWindows;
      status.textContent = t('statusImported');
      if (changeEpoch === epoch) externalWarning.hidden = true;
    } catch (error) {
      lastSaved = previousSaved;
      status.textContent = error.message;
    } finally {
      event.target.value = '';
      form.inert = false;
    }
  });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.settings) return;
  if (lastSaved !== undefined
      && JSON.stringify(changes.settings.newValue) === lastSaved) return;
  changeEpoch += 1;
  externalWarning.hidden = false;
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshPrivateAccess().catch(console.error);
});

restore().catch((error) => {
  status.textContent = error.message;
}).finally(() => {
  form.inert = false;
});
