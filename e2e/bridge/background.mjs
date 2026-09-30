// Test-only: answers the test's commands, relayed by bridge-content.js.
browser.runtime.onMessage.addListener(async (message) => {
  switch (message.command) {
    case 'state': {
      const tabs = await browser.tabs.query({});
      return Promise.all(tabs.map(async (tab) => ({
        id: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
        active: tab.active,
        url: tab.url,
        marker: await browser.sessions.getTabValue(tab.id, 'tabnesiaSlot'),
      })));
    }
    case 'setSettings':
      await browser.storage.sync.set({ settings: message.value });
      return true;
    case 'removeSettings':
      await browser.storage.sync.remove('settings');
      return true;
    case 'getSettings':
      return (await browser.storage.sync.get('settings')).settings ?? null;
    case 'activate':
      await browser.tabs.update(message.tabId, { active: true });
      return true;
    // Leaves a tab as an interrupted navigation would.
    case 'setMarker':
      await browser.sessions.setTabValue(message.tabId, 'tabnesiaSlot', message.value);
      return true;
    case 'alarm':
      return (await browser.alarms.get('tabnesiaCheck')) ?? null;
    default:
      return { error: `unknown command ${message.command}` };
  }
});
