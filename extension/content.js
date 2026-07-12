// Detects ASIN + marketplace on Amazon pages, mounts the floating panel,
// and handles draggable / collapsible / Alt+A toggle behavior.
(function () {
  const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})(?:[/?]|$)/;

  const HOST_TO_MARKET = [
    [/amazon\.com\.mx/, "MX"], [/amazon\.com\.br/, "BR"],
    [/amazon\.co\.uk/, "GB"], [/amazon\.co\.jp/, "JP"],
    [/amazon\.ca/, "CA"], [/amazon\.de/, "DE"], [/amazon\.fr/, "FR"],
    [/amazon\.it/, "IT"], [/amazon\.es/, "ES"], [/amazon\.com/, "US"],
  ];

  const DEFAULT_POS = { top: 96, right: 16, left: null };
  const SIZE = { width: 360, height: 640, collapsedHeight: 48 };
  const STORE_KEY = "arbipro_panel_state";

  const detectMarketplace = () => {
    for (const [re, code] of HOST_TO_MARKET) if (re.test(location.hostname)) return code;
    return "US";
  };
  const detectAsin = () => {
    const m = location.pathname.match(ASIN_RE);
    if (m) return m[1];
    const input = document.querySelector("input#ASIN, input[name='ASIN.0'], input[name='ASIN']");
    if (input?.value && /^[A-Z0-9]{10}$/.test(input.value)) return input.value;
    const v = document.querySelector("[data-asin]")?.getAttribute("data-asin");
    return v && /^[A-Z0-9]{10}$/.test(v) ? v : null;
  };

  let panelState = { pos: { ...DEFAULT_POS }, collapsed: false, hidden: false };
  async function loadState() {
    try { const o = await chrome.storage.local.get(STORE_KEY); if (o[STORE_KEY]) panelState = { ...panelState, ...o[STORE_KEY] }; } catch {}
  }
  const saveState = () => { try { chrome.storage.local.set({ [STORE_KEY]: panelState }); } catch {} };

  function isOnScreen(pos) {
    const vw = window.innerWidth, vh = window.innerHeight;
    if ((pos.top ?? 0) < -40 || (pos.top ?? 0) > vh - 40) return false;
    if (pos.left != null && (pos.left < -40 || pos.left > vw - 60)) return false;
    if (pos.right != null && (pos.right < -40 || pos.right > vw - 60)) return false;
    return true;
  }

  function applyPosition() {
    if (!iframe) return;
    if (!isOnScreen(panelState.pos)) panelState.pos = { ...DEFAULT_POS };
    const { top, left, right } = panelState.pos;
    iframe.style.top = `${top}px`;
    if (left != null) { iframe.style.left = `${left}px`; iframe.style.right = "auto"; }
    else { iframe.style.right = `${right ?? 16}px`; iframe.style.left = "auto"; }
    const maxW = Math.min(SIZE.width, window.innerWidth - 24);
    iframe.style.width = `${maxW}px`;
    iframe.style.height = `${panelState.collapsed ? SIZE.collapsedHeight : Math.min(SIZE.height, window.innerHeight - 32)}px`;
  }

  let iframe = null;
  function mountPanel() {
    if (iframe) return iframe;
    iframe = document.createElement("iframe");
    iframe.id = "arbipro-panel-frame";
    iframe.src = chrome.runtime.getURL("panel.html");
    iframe.allow = "clipboard-write";
    document.documentElement.appendChild(iframe);
    applyPosition();
    if (panelState.hidden) iframe.style.display = "none";
    return iframe;
  }
  const unmountPanel = () => { iframe?.remove(); iframe = null; };
  const postToPanel = (msg) => iframe?.contentWindow?.postMessage({ source: "arbipro-host", ...msg }, "*");

  // Floating launcher shown when the panel is hidden so users can re-open
  // it without needing to remember Alt+A.
  let launcher = null;
  function ensureLauncher() {
    if (launcher) return launcher;
    launcher = document.createElement("button");
    launcher.id = "arbipro-launcher";
    launcher.type = "button";
    launcher.title = "Open InventorySprint (Alt+A)";
    launcher.textContent = "⚡";
    Object.assign(launcher.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647",
      width: "44px", height: "44px", borderRadius: "999px", border: "none",
      background: "#2563eb", color: "#fff", fontSize: "20px", cursor: "pointer",
      boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
    });
    launcher.addEventListener("click", () => {
      panelState.hidden = false;
      hideLauncher();
      mountPanel();
      pushCurrentAsin(true);
      saveState();
    });
    document.documentElement.appendChild(launcher);
    return launcher;
  }
  function hideLauncher() { launcher?.remove(); launcher = null; }

  // Drag disabled — analyzer panel is fixed in its default position.
  panelState.pos = { ...DEFAULT_POS };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "arbipro-panel") return;
    switch (d.type) {
      case "READY":
        postToPanel({ type: "RESTORE_STATE", collapsed: panelState.collapsed });
        pushCurrentAsin(true);
        break;
      case "DRAG_BEGIN":
      case "DRAG_DELTA":
      case "DRAG_END":
        // ignored — drag disabled
        break;
      case "COLLAPSE_TOGGLE":
        panelState.collapsed = !!d.collapsed;
        applyPosition(); saveState();
        break;
      case "RESET_POS":
        panelState.pos = { ...DEFAULT_POS };
        applyPosition(); saveState();
        break;
      case "CLOSE":
        panelState.hidden = true; unmountPanel(); ensureLauncher(); saveState();
        break;
      case "TOGGLE_VISIBILITY": togglePanel(); break;
    }
  });

  function togglePanel() {
    if (!iframe) {
      panelState.hidden = false;
      hideLauncher();
      mountPanel();
      pushCurrentAsin(true);
    } else if (iframe.style.display === "none") {
      panelState.hidden = false; iframe.style.display = "";
      hideLauncher();
    } else {
      panelState.hidden = true; iframe.style.display = "none";
      ensureLauncher();
    }
    saveState();
  }
  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault(); togglePanel();
    }
  });
  window.addEventListener("resize", () => iframe && applyPosition());

  let lastSent = null;
  function pushCurrentAsin(force = false) {
    const asin = detectAsin();
    const marketplace = detectMarketplace();
    const key = `${asin}|${marketplace}`;
    if (!force && key === lastSent) return;
    lastSent = key;
    if (!panelState.hidden) mountPanel();
    postToPanel({ type: "ASIN_CHANGED", asin, marketplace, url: location.href });
  }

  const _push = history.pushState, _replace = history.replaceState;
  history.pushState = function () { _push.apply(this, arguments); setTimeout(pushCurrentAsin, 200); };
  history.replaceState = function () { _replace.apply(this, arguments); setTimeout(pushCurrentAsin, 200); };
  window.addEventListener("popstate", () => setTimeout(pushCurrentAsin, 200));

  (async () => {
    await loadState();
    new MutationObserver(() => pushCurrentAsin()).observe(document.documentElement, { childList: true, subtree: true });
    if (panelState.hidden) ensureLauncher();
    pushCurrentAsin(true);
  })();
})();
