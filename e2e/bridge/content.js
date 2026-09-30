// Test-only: relays window messages from the test to the background.
window.addEventListener('message', async (event) => {
  if (event.source !== window || !event.data?.tabnesiaTest) return;
  const { id, message } = event.data.tabnesiaTest;
  let result;
  try {
    result = await browser.runtime.sendMessage(message);
  } catch (error) {
    result = { error: String(error) };
  }
  window.postMessage({ tabnesiaTestReply: { id, result } }, '*');
});
