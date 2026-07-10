const CFG = self.ARBIPRO_CFG;
const $ = (id) => document.getElementById(id);

const bg = (type, extra = {}, { timeoutMs = 8000, retries = 1 } = {}) =>
  new Promise((res) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; res(r); } };
    const attempt = (left) => {
      let timer = setTimeout(() => {
        if (settled) return;
        // SW likely asleep — retry once to wake it
        if (left > 0) return attempt(left - 1);
        done({ ok: false, error: "bg_timeout" });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage({ type, ...extra }, (r) => {
          clearTimeout(timer);
          // Swallow "message port closed" — treat as transient
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            if (left > 0) return attempt(left - 1);
            return done({ ok: false, error: lastErr.message || "runtime_error" });
          }
          done(r);
        });
      } catch (e) {
        clearTimeout(timer);
        if (left > 0) return attempt(left - 1);
        done({ ok: false, error: String(e?.message || e) });
      }
    };
    attempt(retries);
  });

async function refresh() {
  const r = await bg("ARBIPRO_GET_SESSION");
  const signed = !!r?.session?.access_token;
  $("pop-status").textContent = signed ? "Signed in ✓" : "Not signed in";
  $("pop-signin").classList.toggle("hidden", signed);
  $("pop-signout").classList.toggle("hidden", !signed);
}

$("pop-signin").addEventListener("click", () => {
  chrome.tabs.create({ url: `${CFG.APP_URL}/tools/ext-handoff?ext=1` });
});
$("pop-signout").addEventListener("click", async () => {
  await bg("ARBIPRO_SIGN_OUT");
  refresh();
});
$("pop-open").href = CFG.APP_URL;

refresh();
