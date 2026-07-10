const CFG = self.ARBIPRO_CFG;
const $ = (id) => document.getElementById(id);

const bg = (type, extra = {}) =>
  new Promise((res) => chrome.runtime.sendMessage({ type, ...extra }, (r) => res(r)));

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
$("pop-open").href = `${CFG.APP_URL}/tools/create-listing`;

refresh();
