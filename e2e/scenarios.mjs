// End-to-end scenarios in a real Firefox (see harness.mjs). Run with
// `npm run test:firefox`. BUILD=<git revision> runs the scenarios against
// that revision instead of the working tree; UPGRADE_FROM=<revision> picks
// the version the upgrade scenario starts from.
import assert from 'node:assert/strict';
import {
  call, controlPage, launch, stageExtension, startServer, tabState, waitFor,
} from './harness.mjs';

// The last commit of 1.0.0, the version on AMO before 1.1.0.
const UPGRADE_FROM = process.env.UPGRADE_FROM ?? '462d647';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

async function step(name, work) {
  try {
    await work();
    results.push(['PASS', name]);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push(['FAIL', name, error.message]);
    console.log(`FAIL  ${name}\n      ${error.message.slice(0, 600)}`);
  }
}

const pinnedOf = (state) => state.filter((tab) => tab.pinned)
  .sort((a, b) => a.index - b.index);

// Waits until the pinned tabs are exactly `expected` ([id, url] pairs, in
// order), each showing its URL with a matching marker.
function expectPins(page, expected) {
  return waitFor(async () => {
    const state = await tabState(page);
    const pinned = pinnedOf(state);
    const ok = pinned.length === expected.length && expected.every(([id, url], i) => (
      pinned[i].url === url && pinned[i].marker?.id === id && pinned[i].marker?.url === url
    ));
    return { ok, detail: pinned.map(({ id, url, marker }) => ({ id, url, marker })), state };
  });
}

function settings(server, pins) {
  return {
    pins: pins.map(([id, path, reload = true]) => ({
      ...(id && { id }), url: server.url(path), reload,
    })),
    privateWindows: false,
  };
}

async function currentBuildScenarios() {
  const server = await startServer();
  const build = process.env.BUILD;
  const dir = stageExtension(build);
  const { browser, close } = await launch();
  console.log(`-- ${build ?? 'working tree'}`);
  try {
    await browser.installExtension(dir);
    const page = await controlPage(browser, server);
    await sleep(500);
    const url = server.url;
    const save = (pins) => call(page, { command: 'setSettings', value: settings(server, pins) });
    const quiet = async () => {
      const before = server.snapshot();
      await sleep(2500);
      assert.deepEqual(server.snapshot(), before, 'pages loaded while nothing should change');
    };

    await step('configuring pins opens each page once, in order', async () => {
      await save([['ia', '/a'], ['ib', '/b'], ['ic', '/c']]);
      await expectPins(page, [['ia', url('/a')], ['ib', url('/b')], ['ic', url('/c')]]);
      assert.deepEqual(['/a', '/b', '/c'].map(server.hits), [1, 1, 1]);
    });

    await step('reordering moves tabs without reloading them', async () => {
      await save([['ib', '/b'], ['ia', '/a'], ['ic', '/c']]);
      await expectPins(page, [['ib', url('/b')], ['ia', url('/a')], ['ic', url('/c')]]);
      await quiet();
      assert.deepEqual(['/a', '/b', '/c'].map(server.hits), [1, 1, 1]);
    });

    await step('removing the middle pin unpins its own tab and leaves it open', async () => {
      await save([['ib', '/b'], ['ic', '/c']]);
      const { state } = await expectPins(page, [['ib', url('/b')], ['ic', url('/c')]]);
      const released = state.find((tab) => tab.url === url('/a'));
      assert.ok(released, 'the removed pin\'s tab should stay open');
      assert.equal(released.pinned, false);
      assert.equal(released.marker, undefined);
      await quiet();
      assert.deepEqual(['/a', '/b', '/c'].map(server.hits), [1, 1, 1]);
    });

    await step('editing a URL loads it in that pin\'s own tab only', async () => {
      const before = await tabState(page);
      const cTab = before.find((tab) => tab.marker?.id === 'ic');
      await save([['ib', '/b'], ['ic', '/x']]);
      const { state } = await expectPins(page, [['ib', url('/b')], ['ic', url('/x')]]);
      assert.equal(state.find((tab) => tab.marker?.id === 'ic').id, cTab.id, 'same tab');
      assert.equal(server.hits('/x'), 1);
      assert.deepEqual(['/b', '/c'].map(server.hits), [1, 1]);
    });

    await step('deleting a pin and adding another releases the old tab', async () => {
      await save([['ib', '/b'], ['id', '/d']]);
      const { state } = await expectPins(page, [['ib', url('/b')], ['id', url('/d')]]);
      const released = state.find((tab) => tab.url === url('/x'));
      assert.ok(released && !released.pinned && released.marker === undefined);
      assert.equal(server.hits('/d'), 1);
    });

    await step('activating a pin with auto-reload reloads it; without, it does not', async () => {
      const state = await tabState(page);
      const control = state.find((tab) => tab.url === url('/control'));
      const b = state.find((tab) => tab.marker?.id === 'ib');
      const d = state.find((tab) => tab.marker?.id === 'id');
      await call(page, { command: 'activate', tabId: b.id });
      await waitFor(async () => ({ ok: server.hits('/b') === 2, detail: server.snapshot() }));
      // Turning auto-reload off for d changes no URL, so no check runs.
      await save([['ib', '/b'], ['id', '/d', false]]);
      await sleep(1000);
      await call(page, { command: 'activate', tabId: control.id });
      await call(page, { command: 'activate', tabId: d.id });
      await sleep(2000);
      assert.equal(server.hits('/d'), 1, 'auto-reload off must not reload');
    });

    await step('edits apply after the background script was suspended', async () => {
      // The idle timeout is one second; give it time to suspend.
      await sleep(4000);
      await save([['ib', '/b'], ['id', '/d', false], ['ie', '/e']]);
      await expectPins(page, [['ib', url('/b')], ['id', url('/d')], ['ie', url('/e')]]);
      assert.equal(server.hits('/e'), 1);
    });

    await step('the periodic check exists and changes nothing that is in step (75 s)', async () => {
      const alarm = await call(page, { command: 'alarm' });
      assert.equal(alarm?.periodInMinutes, 1);
      const before = { hits: server.snapshot(), pinned: pinnedOf(await tabState(page)) };
      await sleep(75_000);
      assert.deepEqual(server.snapshot(), before.hits, 'no page may reload');
      assert.deepEqual(pinnedOf(await tabState(page)), before.pinned, 'no tab may change');
    });

    await step('the periodic check repairs an interrupted navigation (75 s)', async () => {
      const e = (await tabState(page)).find((tab) => tab.marker?.id === 'ie');
      await call(page, { command: 'setMarker', tabId: e.id, value: { id: 'ie', url: null } });
      const hitsBefore = server.hits('/e');
      await sleep(75_000);
      await expectPins(page, [['ib', url('/b')], ['id', url('/d')], ['ie', url('/e')]]);
      assert.equal(server.hits('/e'), hitsBefore + 1, 'the tab is navigated once');
    });

    await step('clearing the settings releases every managed tab and stops the check', async () => {
      await call(page, { command: 'removeSettings' });
      await waitFor(async () => {
        const state = await tabState(page);
        const managed = state.filter((tab) => tab.pinned || tab.marker !== undefined);
        return { ok: managed.length === 0, detail: managed };
      });
      await waitFor(async () => ({
        ok: (await call(page, { command: 'alarm' })) === null,
        detail: 'alarm still set',
      }));
    });
  } finally {
    await close();
    await server.close();
  }
}

async function upgradeScenario() {
  const server = await startServer();
  const old = stageExtension(UPGRADE_FROM);
  const current = stageExtension(process.env.BUILD);
  const { browser, close } = await launch();
  console.log(`-- upgrade from ${UPGRADE_FROM}`);
  try {
    await browser.installExtension(old);
    const page = await controlPage(browser, server);
    await sleep(500);
    await call(page, { command: 'setSettings', value: settings(server, [[null, '/a'], [null, '/b']]) });

    await step('1.0.0 pins tabs with slot markers', async () => {
      await waitFor(async () => {
        const pinned = pinnedOf(await tabState(page));
        return {
          ok: pinned.length === 2 && pinned[0].marker === '0' && pinned[1].marker === '1',
          detail: pinned,
        };
      });
    });
    const oldTabs = pinnedOf(await tabState(page)).map(({ id }) => id);

    await step('updating releases 1.0.0 tabs and pins fresh ones', async () => {
      await browser.installExtension(current);
      await sleep(500);
      const { state } = await expectPins(page, [
        [server.url('/a'), server.url('/a')],
        [server.url('/b'), server.url('/b')],
      ]);
      for (const id of oldTabs) {
        const tab = state.find((candidate) => candidate.id === id);
        assert.ok(tab, 'old tab stays open');
        assert.equal(tab.pinned, false);
        assert.equal(tab.marker, undefined);
      }
      const settingsAfter = await call(page, { command: 'getSettings' });
      assert.deepEqual(settingsAfter, settings(server, [[null, '/a'], [null, '/b']]),
        '1.0.0 settings are left exactly as they were');
    });
  } finally {
    await close();
    await server.close();
  }
}

await upgradeScenario();
await currentBuildScenarios();
const failed = results.filter(([status]) => status === 'FAIL');
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
