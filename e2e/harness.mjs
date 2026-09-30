// Drives the extension in a real Firefox: a separate headless instance with
// a throwaway profile, never the Firefox you have running, plus a local
// HTTP server whose pages count their loads.
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const REPO = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = fileURLToPath(new URL('bridge/', import.meta.url));
const EXTENSION_ID = '{ec455cb3-9733-47fb-9a56-85fc0397eac0}';
const MAC_FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox';
const FIREFOX = process.env.FIREFOX
  ?? (existsSync(MAC_FIREFOX) ? MAC_FIREFOX : 'firefox');
// Staged extension copies, removed when the run ends.
const staged = [];
process.once('exit', () => {
  for (const dir of staged) rmSync(dir, { recursive: true, force: true });
});
const EXTENSION_FILES = [
  '_locales', 'icons', 'background.mjs', 'config.mjs', 'manifest.json',
  'options.css', 'options.html', 'options.mjs',
];

// Copies the extension from the working tree or a git revision into a
// temporary directory, adding the test bridge: a content script on the
// test pages relays commands to a listener beside the background script.
// The bridge also needs the tabs permission, to read tab URLs; the
// extension's own code never reads them.
export function stageExtension(revision) {
  const dir = mkdtempSync(join(tmpdir(), 'tabnesia-e2e-extension-'));
  staged.push(dir);
  const files = revision && execFileSync(
    'git',
    ['-C', REPO, 'ls-tree', '-r', '--name-only', revision],
  ).toString().trim().split('\n');
  for (const entry of EXTENSION_FILES) {
    if (!revision) {
      cpSync(join(REPO, entry), join(dir, entry), { recursive: true });
      continue;
    }
    for (const file of files.filter((f) => f === entry || f.startsWith(`${entry}/`))) {
      const target = join(dir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, execFileSync('git', ['-C', REPO, 'show', `${revision}:${file}`]));
    }
  }

  cpSync(join(BRIDGE, 'background.mjs'), join(dir, 'bridge-background.mjs'));
  cpSync(join(BRIDGE, 'content.js'), join(dir, 'bridge-content.js'));
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.permissions = [...new Set([...manifest.permissions, 'tabs'])];
  manifest.background.scripts = [...manifest.background.scripts, 'bridge-background.mjs'];
  manifest.content_scripts = [{ matches: ['http://127.0.0.1/*'], js: ['bridge-content.js'] }];
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

export async function startServer() {
  const hits = new Map();
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    if (path === '/favicon.ico') {
      response.writeHead(404).end();
      return;
    }
    hits.set(path, (hits.get(path) ?? 0) + 1);
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(`<!doctype html><title>${path}</title><p>${path}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: (path) => `${base}${path}`,
    hits: (path) => hits.get(path) ?? 0,
    snapshot: () => Object.fromEntries(hits),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Launches a separate Firefox and returns it with a close() that also
// removes its profile.
export async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'tabnesia-e2e-profile-'));
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FIREFOX,
    headless: true,
    userDataDir: profile,
    // Never hand off to (or otherwise touch) an already running Firefox.
    args: ['--no-remote', '--new-instance'],
    env: { ...process.env, MOZ_NO_REMOTE: '1' },
    extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({
        [EXTENSION_ID]: '11111111-2222-3333-4444-555555555555',
      }),
      // Suspend the background script after a second idle, so the paths
      // that wake it really run.
      'extensions.background.idle.timeout': 1000,
    },
  });
  const close = async () => {
    await browser.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  };
  process.once('SIGINT', () => close().finally(() => process.exit(130)));
  return { browser, close };
}

// A test page, whose content script relays commands to the extension.
export async function controlPage(browser, server) {
  const page = await browser.newPage();
  await page.goto(server.url('/control'));
  return page;
}

export async function call(page, message) {
  const result = await page.evaluate((payload) => new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const onReply = (event) => {
      if (event.data?.tabnesiaTestReply?.id !== id) return;
      window.removeEventListener('message', onReply);
      resolve(event.data.tabnesiaTestReply.result);
    };
    window.addEventListener('message', onReply);
    window.postMessage({ tabnesiaTest: { id, message: payload } }, '*');
  }), message);
  if (result?.error) throw new Error(result.error);
  return result;
}

export const tabState = (page) => call(page, { command: 'state' });

export async function waitFor(check, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out: ${JSON.stringify(last?.detail ?? last, null, 1)}`);
}
