// Runs on arbiproseller.com. Bridges postMessage events from the web app
// (page-context) into the extension service worker.
//
// Two events are accepted:
//   ARBIPRO_EXT_SESSION → log in / refresh the session
//   ARBIPRO_EXT_LOGOUT  → user explicitly signed out of the web app
//
// LOGOUT is the only signal that should clear the extension's session.
// Slow auth, 504s, and transient network errors must NOT trigger logout
// (handled in background.js).
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data) return;

  if (data.type === "ARBIPRO_EXT_SESSION") {
    const s = data.session;
    if (!s?.access_token || !s?.refresh_token) return;
    chrome.runtime.sendMessage(
      { type: "ARBIPRO_SET_SESSION", session: s },
      () => {
        window.postMessage({ type: "ARBIPRO_EXT_SESSION_ACK" }, "*");
      }
    );
    return;
  }

  if (data.type === "ARBIPRO_EXT_LOGOUT") {
    try { console.log("[arbipro-auth]", "extension_logout_signal_received"); } catch (_) {}
    chrome.runtime.sendMessage(
      { type: "ARBIPRO_EXPLICIT_SIGN_OUT" },
      () => {
        window.postMessage({ type: "ARBIPRO_EXT_LOGOUT_ACK" }, "*");
      }
    );
  }
});
