// Test-only: relays window messages from the test to the background. Settings
// are written here, as messaging the background would wake it before the
// write, and the storage change must wake it by itself.
window.addEventListener('message', async (event) => {
  if (event.source !== window || !event.data?.tabnesiaTest) return;
  const { id, message } = event.data.tabnesiaTest;
  let result;
  try {
    if (message.command === 'setSettings') {
      await browser.storage.sync.set({ settings: message.value });
      result = true;
    } else {
      result = await browser.runtime.sendMessage(message);
    }
  } catch (error) {
    result = { error: String(error) };
  }
  window.postMessage({ tabnesiaTestReply: { id, result } }, '*');
});
