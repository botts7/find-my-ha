// Find My HA Device — main wiring.
//
// Controller — owns DOM refs and orchestrates the scanner ↔ ws_client ↔
// streamer ↔ entity_picker modules.

// v0.5.5: surface JS errors on-screen instead of failing silently.
// Without this, a crash during IIFE init left the user with a blank
// page below the step bar and no way to see what went wrong. Now any
// uncaught error becomes a red banner above the rest of the UI, with
// the error message + file:line. Captures both window.error and
// unhandledrejection so async failures show up too.
(function installErrorBanner() {
  const banner = document.createElement("div");
  banner.id = "js-error-banner";
  banner.style.cssText =
    "display:none;position:sticky;top:0;left:0;right:0;z-index:9999;"
    + "background:#ef4444;color:white;padding:10px 14px;font:13px/1.4 "
    + "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"
    + "border-bottom:2px solid #b91c1c;white-space:pre-wrap;";
  const messages = document.createElement("div");
  banner.appendChild(messages);
  function show(msg) {
    banner.style.display = "block";
    messages.textContent = (messages.textContent ? messages.textContent + "\n\n" : "")
      + msg;
  }
  function attach() {
    if (banner.isConnected) return;
    document.body.insertBefore(banner, document.body.firstChild);
  }
  window.addEventListener("error", (e) => {
    attach();
    const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
    show("JS error: " + (e.message || "(no message)") + where);
  });
  window.addEventListener("unhandledrejection", (e) => {
    attach();
    const r = e.reason;
    const msg = r && r.message ? r.message : String(r);
    show("Unhandled promise rejection: " + msg);
  });
  // Expose globally so the rest of the page can post non-error
  // diagnostics here too if we ever need to.
  window.__finalErrorShow = show;
})();

// v0.5.6: a button at the very bottom of the page that nukes the SW
// + caches + localStorage and reloads. Self-rescue for users stuck on
// stale state. Independent of the rest of the IIFE so it works even if
// init crashes.
(function installForceUpdateButton() {
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.createElement("button");
    btn.textContent = "🔄 Force update (clear cache + reload)";
    btn.style.cssText =
      "display:block;width:100%;max-width:560px;margin:24px auto 8px;"
      + "padding:10px 14px;border:1px solid #94a3b8;background:transparent;"
      + "color:#94a3b8;border-radius:8px;font:13px/1.4 inherit;cursor:pointer;";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Clearing…";
      try {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        if ("caches" in window) {
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
        }
        localStorage.clear();
      } catch (_) { /* best effort */ }
      // Hard reload, bypassing any remaining cache.
      window.location.reload();
    });
    document.body.appendChild(btn);
  });
})();

(function () {
  "use strict";

  // v0.5.4: render the running version on screen so the user can tell
  // at a glance whether their browser is serving the latest deploy.
  const APP_VERSION = "0.7.6";

  const DEBUG = false;
  function dlog() { if (DEBUG) console.log.apply(console, arguments); }

  // ----- DOM refs ---------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const haUrlEl = $("ha-url");
  const haTokenEl = $("ha-token");
  const saveBtn = $("save-creds-btn");
  const connectBtn = $("connect-btn");
  const disconnectBtn = $("disconnect-btn");
  const connStateEl = $("conn-state");
  const connDetailEl = $("conn-detail");
  const urlWarnEl = $("url-warn");
  const reconnectRow = $("reconnect-row");
  const reconnectTextEl = $("reconnect-text");
  const retryNowBtn = $("retry-now-btn");

  const stepsEl = $("steps");
  const tabPanels = document.querySelectorAll(".tab-panel");
  const scanSection = $("scan-section");
  const rssiSection = $("rssi-section");

  const entitySearchEl = $("entity-search");
  // v0.6.0: native <select> for OS-native modal device picker.
  // Legacy entityListEl alias retained so any in-flight reference
  // resolves to the same element.
  const entitySelectEl = $("entity-select");
  const entityListEl = entitySelectEl;
  const entityStatusEl = $("entity-status");
  const entitySelectedEl = $("entity-selected");
  const refreshEntitiesBtn = $("refresh-entities-btn");

  const bleNameEl = $("ble-name");
  const bleMacEl = $("ble-mac");
  const scanBtn = $("scan-btn");
  const stopBtn = $("stop-btn");
  const rssiValue = $("rssi-value");
  const rssiBucket = $("rssi-bucket");
  const rssiTrend = $("rssi-trend");
  const rssiMeta = $("rssi-meta");
  const streamStateEl = $("stream-state");
  const scanError = $("scan-error");
  const nearbyListEl = $("nearby-list");

  const flagCard = $("flag-card");
  const copyFlagBtn = $("copy-flag-btn");
  const flagUrlInput = $("flag-url");

  const themeToggle = $("theme-toggle");
  const versionPillEl = $("version-pill");
  if (versionPillEl) {
    versionPillEl.textContent = "v" + APP_VERSION;
    versionPillEl.addEventListener("click", () => {
      window.open(
        "https://github.com/botts7/find-my-ha/releases",
        "_blank",
        "noopener",
      );
    });
  }

  // v0.5: walking-verify mode refs
  const modeBleBtn = $("mode-ble-btn");
  const modeIdentifyBtn = $("mode-identify-btn");
  // v0.7.0: Wi-Fi find — inverse-multilateration via wifi_find_self.
  const modeWifiBtn = $("mode-wifi-btn");
  // v0.7.5: picker detail-level toggle (Name vs Name·entity_id).
  const pickerDetailNameBtn = $("picker-detail-name");
  const pickerDetailEntityBtn = $("picker-detail-entity");
  const wifiFindSection = $("wifi-find-section");
  const wifiFindStartBtn = $("wifi-find-start-btn");
  const wifiFindErrorEl = $("wifi-find-error");
  const wifiFindStateEl = $("wifi-find-state");
  const freshnessPillEl = $("freshness-pill");
  const freshnessLabelEl = $("freshness-label");
  const modeHelpEl = $("mode-help");
  const identifySection = $("identify-section");
  const identifyTargetEl = $("identify-target");
  const identifyStateEl = $("identify-state");
  const flashBtn = $("flash-btn");
  const flashStopBtn = $("flash-stop-btn");
  const flashModeEl = $("flash-mode");
  const identifyErrorEl = $("identify-error");
  const identifyConfirmedEl = $("identify-confirmed");
  const areaSelectEl = $("area-select");
  const confirmAreaBtn = $("confirm-area-btn");
  const entityListHintEl = $("entity-list-hint");
  // v0.5.1: explicit Continue button instead of auto-advance 2→3.
  const continueToScanBtn = $("continue-to-scan-btn");
  const continueBar = $("continue-bar");
  continueToScanBtn.addEventListener("click", () => switchTab(3));

  // ----- Theme override ---------------------------------------------------
  const savedTheme = localStorage.getItem("theme");
  if (savedTheme === "light" || savedTheme === "dark") {
    document.documentElement.dataset.theme = savedTheme;
  }
  themeToggle.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    // Cycle: auto → light → dark → auto
    if (!cur) {
      document.documentElement.dataset.theme = "light";
      localStorage.setItem("theme", "light");
    } else if (cur === "light") {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("theme", "dark");
    } else {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("theme");
    }
  });

  // ----- Restore saved creds ---------------------------------------------
  haUrlEl.value = localStorage.getItem("ha_url") ?? "";
  haTokenEl.value = localStorage.getItem("ha_token") ?? "";
  bleMacEl.value = localStorage.getItem("ble_mac") ?? "";

  saveBtn.addEventListener("click", () => {
    localStorage.setItem("ha_url", haUrlEl.value.trim());
    localStorage.setItem("ha_token", haTokenEl.value.trim());
    saveBtn.textContent = "Saved ✓";
    setTimeout(() => (saveBtn.textContent = "Save credentials (local only)"), 1500);
  });

  // ----- URL + token validation ------------------------------------------
  function validateUrl(raw) {
    const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
    if (!trimmed) return { ok: false, warning: null, normalized: "" };
    let url = trimmed;
    let warning = null;
    // Default-port hint: HA usually runs on 8123 unless reverse-proxied.
    // We don't add it (could break a reverse-proxy setup), but warn so
    // the user can decide.
    if (!/^https?:\/\//i.test(url) && !/^wss?:\/\//i.test(url)) {
      // Bare host — assume https.
      url = "https://" + url;
    }
    // Mixed-content trap: PWA is served over HTTPS via GitHub Pages, so
    // ws:// to http:// HA hosts is blocked by every browser.
    if (location.protocol === "https:" && /^http:\/\//i.test(url)) {
      warning =
        "This page is HTTPS but the URL is HTTP — browser will block the connection. "
        + "Use your Nabu Casa URL (HTTPS) or a Tailscale/Cloudflare tunnel.";
    }
    return { ok: true, warning, normalized: url };
  }
  function tokenLooksValid(t) {
    // Long-lived access tokens are JWT-shaped: three base64url segments
    // joined by dots. Loose check, just catches obvious paste errors.
    return typeof t === "string" && t.split(".").length === 3 && t.length > 50;
  }

  // ----- WS client --------------------------------------------------------
  const ws = new HaWsClient();
  let pickedEntity = null;

  const CONN_LABELS = {
    disconnected: { text: "disconnected", cls: "conn-disconnected" },
    connecting:   { text: "connecting…", cls: "conn-connecting" },
    authenticating: { text: "authenticating…", cls: "conn-connecting" },
    authed:       { text: "connected", cls: "conn-authed" },
    streaming:    { text: "streaming", cls: "conn-streaming" },
    error:        { text: "error", cls: "conn-error" },
  };

  // Reconnect countdown — runs at 1Hz while a reconnect is queued.
  let countdownTimer = null;
  function tickCountdown() {
    const info = ws.getReconnectInfo();
    if (!info) {
      stopCountdown();
      reconnectRow.style.display = "none";
      return;
    }
    const seconds = Math.ceil(info.remainingMs / 1000);
    reconnectTextEl.textContent =
      `Reconnecting in ${seconds}s (attempt ${info.attemptNumber})`;
    reconnectRow.style.display = "flex";
    connStateEl.textContent = "reconnecting";
    connStateEl.className = "conn-pill conn-reconnecting";
  }
  function startCountdown() {
    if (countdownTimer) return;
    tickCountdown();
    countdownTimer = setInterval(tickCountdown, 1000);
  }
  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
  retryNowBtn.addEventListener("click", () => {
    ws.retryNow();
  });

  ws.onStateChange(({ state, error }) => {
    const label = CONN_LABELS[state] ?? CONN_LABELS.disconnected;
    // Reconnect countdown takes over the pill text when active.
    const reconnectInfo = ws.getReconnectInfo();
    if (reconnectInfo) {
      startCountdown();
    } else {
      stopCountdown();
      reconnectRow.style.display = "none";
      connStateEl.textContent = label.text;
      connStateEl.className = "conn-pill " + label.cls;
    }
    connDetailEl.textContent = error ?? "";
    connDetailEl.style.display = error ? "block" : "none";

    const live = state !== "disconnected" && state !== "error";
    connectBtn.style.display = live ? "none" : "block";
    disconnectBtn.style.display = live ? "block" : "none";

    // Re-fetch registry on every authed transition — handles HA restart.
    if (state === "authed") {
      entityPicker.setMode(mode);  // sync filter to current mode
      entityPicker.load(ws);
      loadAreas(ws);  // v0.5: populate area picker for identify mode
      // v0.7.4: probe Wi-Fi capability on EVERY authed transition (not
      // just when in Wi-Fi mode) so the mode-button visibility is
      // accurate before the user ever clicks it. Hides the button on
      // installs with zero controller-side trackable entities.
      loadWifiCapabilities();
    }
    if (state === "disconnected" || state === "error") {
      // Note: don't stop the streamer here — it self-resubscribes on the
      // next AUTHED transition (see streamer.js). Only stop on explicit
      // user disconnect.
    }
    updateStepIndicator();
    maybeAutoAdvance();
  });

  connectBtn.addEventListener("click", () => {
    const v = validateUrl(haUrlEl.value);
    if (!v.ok) {
      connDetailEl.textContent = "Enter HA URL first.";
      connDetailEl.style.display = "block";
      return;
    }
    haUrlEl.value = v.normalized;
    urlWarnEl.textContent = v.warning || "";
    urlWarnEl.style.display = v.warning ? "block" : "none";
    const token = haTokenEl.value.trim();
    if (!token) {
      connDetailEl.textContent = "Paste a long-lived access token.";
      connDetailEl.style.display = "block";
      return;
    }
    if (!tokenLooksValid(token)) {
      connDetailEl.textContent =
        "Token doesn't look like a JWT (should be three dot-separated segments). "
        + "Generate a new one in HA Profile → Security → Long-Lived Access Tokens.";
      connDetailEl.style.display = "block";
      return;
    }
    localStorage.setItem("ha_url", v.normalized);
    localStorage.setItem("ha_token", token);
    ws.connect(v.normalized, token);
  });

  disconnectBtn.addEventListener("click", () => {
    ws.disconnect();
    entityPicker.clear();
    pickedEntity = null;
    updateEntitySelectedDisplay(null);
    switchTab(1);  // disconnected → kick back to Setup tab
  });

  // ----- Mode toggle (v0.5: BLE find vs Identify & verify) ---------------
  // localStorage preserves choice across sessions.
  let mode = localStorage.getItem("find_mode") || "ble";

  function applyModeButtons() {
    modeBleBtn.classList.toggle("active", mode === "ble");
    modeIdentifyBtn.classList.toggle("active", mode === "identify");
    if (modeWifiBtn) modeWifiBtn.classList.toggle("active", mode === "wifi");
    if (mode === "identify") {
      modeHelpEl.innerHTML =
        "<strong>Identify &amp; verify</strong>: flash any controllable "
        + "entity (light, switch, fan, lock, siren) and confirm which "
        + "room you're in. Works for non-BLE devices.";
    } else if (mode === "wifi") {
      modeHelpEl.innerHTML =
        "<strong>Wi-Fi find</strong>: pick YOUR phone's device tracker. "
        + "Walk through your home — your AP's RSSI changes as you move. "
        + "Slower than BLE (~10-30 s between updates) but works for "
        + "Wi-Fi devices.";
    } else {
      modeHelpEl.innerHTML =
        "<strong>BLE find</strong>: warmer/colder for BLE-trackable "
        + "devices (Hue, AirTag, BTHome, BLE locks).";
    }
    // v0.5.8 / v0.7.0: mode-aware search placeholder + hint.
    if (entitySearchEl) {
      entitySearchEl.placeholder =
        mode === "identify"
          ? "Search lights / switches / fans / scenes…"
          : mode === "wifi"
            ? "Search device_tracker entities (pick your phone)…"
            : "Search BLE-trackable entities…";
    }
    if (entityListHintEl) {
      entityListHintEl.innerHTML =
        mode === "identify"
          ? "Lists all controllable entities. Connect first to populate."
          : mode === "wifi"
            ? "Pick YOUR phone's <code>device_tracker</code>. "
              + "UniFi / Asuswrt / Omada integrations expose the phone "
              + "with per-AP RSSI we can stream."
            : "Lists <code>device_tracker</code> and BLE-hinted "
              + "<code>binary_sensor</code> entities. Connect first to "
              + "populate.";
    }
  }
  applyModeButtons();

  [modeBleBtn, modeIdentifyBtn, modeWifiBtn].filter(Boolean).forEach((btn) => {
    btn.addEventListener("click", () => {
      const newMode = btn.dataset.mode;
      if (newMode === mode) return;
      mode = newMode;
      localStorage.setItem("find_mode", mode);
      applyModeButtons();
      entityPicker.setMode(mode);
      pickedEntity = null;
      updateEntitySelectedDisplay(null);
      identifyTargetEl.style.display = "none";
      identifyConfirmedEl.style.display = "none";
      updateTab3Panels();
      updateStepIndicator();
      // v0.7.2: when switching to Wi-Fi mode, batch-query capabilities
      // so the picker narrows to actually-Wi-Fi-trackable entities.
      // mobile_app GPS trackers, Plex device_trackers, etc. get filtered.
      if (newMode === "wifi") {
        loadWifiCapabilities();
      }
    });
  });

  // v0.7.5: picker detail-level toggle. Defaults to "name" (friendly
  // only) so dropdowns aren't polluted by MAC-like entity_ids from
  // Omada / mobile_app / BLE proxies. User can switch to "entity"
  // for disambiguation when two devices share a friendly name. The
  // EntityPicker reads the persisted level from localStorage on
  // init, so on first load we just need to highlight the right btn.
  function applyPickerDetailButtons() {
    if (!pickerDetailNameBtn || !pickerDetailEntityBtn) return;
    const level = entityPicker.getDetailLevel?.() ?? "name";
    pickerDetailNameBtn.classList.toggle("active", level === "name");
    pickerDetailEntityBtn.classList.toggle("active", level === "entity");
  }
  [pickerDetailNameBtn, pickerDetailEntityBtn].filter(Boolean).forEach((btn) => {
    btn.addEventListener("click", () => {
      const newLevel = btn.dataset.detail;
      if (!newLevel) return;
      entityPicker.setDetailLevel?.(newLevel);
      applyPickerDetailButtons();
    });
  });
  // v0.7.5 → v0.7.6 fix: initial applyPickerDetailButtons() call lives
  // AFTER the EntityPicker constructor (search file for
  // "const entityPicker = new EntityPicker"). v0.7.5 had it here,
  // which read entityPicker via TDZ and threw "cannot access entity
  // picker" on page load.

  // v0.7.4: hide the Wi-Fi mode button when the install has zero
  // candidates. We probe capability silently on connect (or on first
  // Wi-Fi-mode hover) and toggle the button visibility. Real-install
  // validation showed 326 device_trackers → 1 controller-side
  // candidate is a common outcome — better to hide the mode than
  // have users discover its uselessness one tap at a time.
  let wifiModeAvailability = null;  // null = unknown, true/false = probed

  function _applyWifiModeAvailability() {
    if (!modeWifiBtn) return;
    if (wifiModeAvailability === false) {
      modeWifiBtn.style.display = "none";
      modeWifiBtn.title =
        "Wi-Fi find unavailable — no controller-side RSSI integration "
        + "detected (UniFi/Omada/Asuswrt-Merlin/Mikrotik). "
        + "Use BLE or Identify instead.";
      // If user was on Wi-Fi mode, snap them back to BLE.
      if (mode === "wifi") {
        mode = "ble";
        localStorage.setItem("find_mode", mode);
        applyModeButtons();
        entityPicker.setMode(mode);
        updateTab3Panels();
        updateStepIndicator();
      }
    } else {
      modeWifiBtn.style.display = "";
      modeWifiBtn.title = "";
    }
  }

  // v0.7.2: batch wifi_find_capability lookup. Calls
  // home_insights/wifi_find_capability with every device_tracker entity_id
  // and pushes the response into the picker. Gracefully degrades when
  // the backend is pre-v1.21.1 (unknown_command → fall back to showing
  // all device_trackers + a banner).
  async function loadWifiCapabilities() {
    if (!(ws.getState() === "authed" || ws.getState() === "streaming")) return;
    const allDeviceTrackers = [];
    // The picker holds raw entities behind a closure; we need our own
    // device-tracker list. Cheapest source is HA's registry, which the
    // picker already loaded — re-fetch is fine (it's cached server-side).
    let registry;
    try {
      registry = await ws.request({ type: "config/entity_registry/list" });
    } catch (_) {
      return;  // Picker stays in fall-back "all device_trackers" mode.
    }
    for (const e of registry ?? []) {
      const eid = e.entity_id ?? "";
      if (eid.startsWith("device_tracker.")) allDeviceTrackers.push(eid);
    }
    if (!allDeviceTrackers.length) return;
    try {
      const resp = await ws.request({
        type: "home_insights/wifi_find_capability",
        entity_ids: allDeviceTrackers,
      });
      const caps = resp?.capabilities ?? {};
      entityPicker.setWifiCapabilities(caps);
      // v0.7.4: count trackable entries; hide mode button when zero.
      const trackableCount = Object.values(caps).filter(
        (c) => c?.is_trackable === true,
      ).length;
      wifiModeAvailability = trackableCount > 0;
      _applyWifiModeAvailability();
    } catch (e) {
      const msg = e?.message ?? "";
      if (/unknown[_ ]command/i.test(msg)) {
        // Backend is pre-v1.21.1. Picker stays in fall-back mode;
        // surface the situation so the user knows why filtering isn't
        // narrowing. Mode button stays visible (user can still try).
        if (entityListHintEl) {
          entityListHintEl.innerHTML =
            "<strong>Pre-filter unavailable</strong> — update HA Insights "
            + "to v1.21.1+ to narrow the picker to only Wi-Fi-trackable "
            + "entities. Showing all device-trackers for now.";
        }
        wifiModeAvailability = true;  // benefit of the doubt
        _applyWifiModeAvailability();
      }
      // Other errors are silently ignored; the user can still pick from
      // the unfiltered list.
    }
  }

  // ----- Area registry ----------------------------------------------------
  // Cache of {area_id, name} loaded after auth. Populates the identify-
  // mode area-picker dropdown so the user can confirm "I'm here".
  let areas = [];

  async function loadAreas(ws) {
    try {
      const list = await ws.request({ type: "config/area_registry/list" });
      areas = (list ?? [])
        .map((a) => ({ id: a.area_id || a.id, name: a.name }))
        .filter((a) => a.id && a.name)
        .sort((a, b) => a.name.localeCompare(b.name));
      // Rebuild area select.
      areaSelectEl.innerHTML = '<option value="">— pick area —</option>';
      areas.forEach((a) => {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = a.name;
        areaSelectEl.appendChild(opt);
      });
    } catch (e) {
      // Non-fatal — area picker just won't populate.
      dlog("loadAreas failed:", e);
    }
  }

  // ----- Identify (flash) helper -----------------------------------------
  // Picks the right service for the entity's domain. Vendor-aware
  // identify (ZHA effect, Z-Wave Indicator CC, LIFX flash) is HA Insights'
  // job — we just do a basic toggle here. Lights get .toggle twice
  // (off→on→off or on→off→on) to be visibly noticeable.
  async function flashEntity(entry) {
    const eid = entry.entity_id;
    const domain = eid.split(".")[0];
    const toggleCall = (svc) => ws.request({
      type: "call_service",
      domain,
      service: svc,
      service_data: { entity_id: eid },
    });
    // For lights/switches/fans, two toggles produces a visible blink
    // while restoring original state. v0.5.8: 600 ms wasn't enough for
    // Zigbee/Z-Wave round-trips on real installs — the second toggle
    // sometimes fired before the first reached the device, end-state
    // unchanged, user reported "takes two tries". 1500 ms covers the
    // 99th-percentile mesh latency without slowing the UX noticeably.
    if (domain === "light" || domain === "switch" || domain === "fan"
        || domain === "input_boolean") {
      await toggleCall("toggle");
      await new Promise((r) => setTimeout(r, 1500));
      await toggleCall("toggle");
      return;
    }
    // Cover: open/close briefly
    if (domain === "cover") {
      await toggleCall("toggle");
      return;
    }
    // Scenes/scripts/automations: activate
    if (domain === "scene") {
      await ws.request({
        type: "call_service",
        domain: "scene", service: "turn_on",
        service_data: { entity_id: eid },
      });
      return;
    }
    if (domain === "script" || domain === "automation") {
      await ws.request({
        type: "call_service",
        domain, service: "turn_on",
        service_data: { entity_id: eid },
      });
      return;
    }
    // Siren / lock / valve / vacuum / media_player / remote / climate /
    // humidifier — generic toggle. If the domain doesn't support
    // toggle, fall through to homeassistant.toggle.
    try {
      await toggleCall("toggle");
    } catch (_) {
      await ws.request({
        type: "call_service",
        domain: "homeassistant", service: "toggle",
        service_data: { entity_id: eid },
      });
    }
  }

  // ----- Current state fetcher (identify-mode display) -------------------
  async function fetchState(entityId) {
    try {
      const states = await ws.request({ type: "get_states" });
      const s = (states ?? []).find((x) => x.entity_id === entityId);
      return s ?? null;
    } catch (_) {
      return null;
    }
  }

  // ----- Tab 3 panel routing ---------------------------------------------
  // In Tab 3, show scan-section / rssi-section for BLE mode; identify-
  // section for identify mode. Caller (updateStepIndicator) decides
  // whether Tab 3 is visible at all.
  function updateTab3Panels() {
    if (mode === "identify") {
      identifySection.style.display = "block";
      scanSection.style.display = "none";
      if (wifiFindSection) wifiFindSection.style.display = "none";
      rssiSection.style.display = "none";
    } else if (mode === "wifi") {
      identifySection.style.display = "none";
      scanSection.style.display = "none";
      // Wi-Fi find: start-section visible until streaming; rssi-section
      // takes over once events flow.
      if (!wifiStreamer.isActive()) {
        if (wifiFindSection) wifiFindSection.style.display = "block";
        rssiSection.style.display = "none";
      }
    } else {
      identifySection.style.display = "none";
      if (wifiFindSection) wifiFindSection.style.display = "none";
      // scan-section vs rssi-section is handled by scanning state below.
      if (!streamer.isActive()) {
        scanSection.style.display = "block";
        rssiSection.style.display = "none";
      }
    }
  }

  // ----- Entity picker ----------------------------------------------------
  const entityPicker = new EntityPicker({
    inputEl: entitySearchEl,
    selectEl: entitySelectEl,
    statusEl: entityStatusEl,
    onPick: async (entry) => {
      pickedEntity = entry;
      localStorage.setItem("ha_entity_id", entry.entity_id);
      identifyConfirmedEl.style.display = "none";
      identifyErrorEl.style.display = "none";
      if (mode === "ble") {
        const ble = entityPicker.getBleInfo(entry);
        if (ble) {
          bleNameEl.value = ble.suggested_name_prefix || "";
          bleMacEl.value = ble.bluetooth_mac || "";
          if (ble.bluetooth_mac) localStorage.setItem("ble_mac", ble.bluetooth_mac);
        } else {
          bleNameEl.value = "";
          bleMacEl.value = "";
        }
        updateEntitySelectedDisplay(ble);
      } else {
        // v0.5 identify mode: show entity name + live state.
        const label = entry.name || entry.original_name || entry.entity_id;
        identifyTargetEl.textContent =
          `Target: ${label} (${entry.entity_id})`;
        identifyTargetEl.style.display = "block";
        // Pre-select the current area in the dropdown.
        areaSelectEl.value = entry.area_id || "";
        // Fetch and display current state.
        const s = await fetchState(entry.entity_id);
        if (s) {
          identifyStateEl.innerHTML =
            '<span class="label">State:</span> '
            + '<span class="value state"></span>'
            + ' <span class="label" style="margin-left: 12px;">Area:</span> '
            + '<span class="value area"></span>';
          identifyStateEl.querySelector(".value.state").textContent = s.state ?? "unknown";
          const areaName = entry.area_id
            ? (areas.find((a) => a.id === entry.area_id)?.name || entry.area_id)
            : "— unassigned —";
          identifyStateEl.querySelector(".value.area").textContent = areaName;
        } else {
          identifyStateEl.innerHTML =
            '<span class="label">State unknown (entity not in get_states).</span>';
        }
      }
      updateStepIndicator();
      maybeAutoAdvance();
    },
  });
  // v0.7.6: initial state-sync for the picker-detail toggle buttons.
  // Moved here from earlier in the file (right above) because
  // applyPickerDetailButtons reads entityPicker.getDetailLevel(), and
  // entityPicker is only just now defined. Calling it before this point
  // triggered a TDZ ReferenceError on page load.
  applyPickerDetailButtons();
  refreshEntitiesBtn.addEventListener("click", () => {
    if (ws.getState() === "authed" || ws.getState() === "streaming") {
      entityPicker.load(ws);
    }
  });
  function updateEntitySelectedDisplay(bleInfo) {
    if (!pickedEntity) {
      entitySelectedEl.textContent = "";
      entitySelectedEl.style.display = "none";
      return;
    }
    const label = pickedEntity.name || pickedEntity.original_name || pickedEntity.entity_id;
    let txt = `Tracking: ${label} (${pickedEntity.entity_id})`;
    if (bleInfo && (bleInfo.bluetooth_mac || bleInfo.suggested_name_prefix)) {
      const parts = [];
      if (bleInfo.suggested_name_prefix) parts.push(`name prefix “${bleInfo.suggested_name_prefix}”`);
      if (bleInfo.bluetooth_mac) parts.push(`MAC ${bleInfo.bluetooth_mac}`);
      txt += `\nAuto-detected: ${parts.join(", ")}`;
    } else if (bleInfo === null && pickedEntity) {
      txt += "\n(no Bluetooth info on file — type a name prefix manually)";
    }
    entitySelectedEl.textContent = txt;
    entitySelectedEl.style.whiteSpace = "pre-line";
    entitySelectedEl.style.display = "block";
  }

  // ----- Tab navigation ---------------------------------------------------
  // Steps double as tabs. Only one .tab-panel is visible at a time. Tabs
  // beyond current prereqs are disabled (can't jump to Scan without
  // connecting + picking a device first).
  let activeTab = 1;
  function switchTab(n) {
    activeTab = n;
    tabPanels.forEach((p) => {
      p.classList.toggle("active", Number(p.dataset.panel) === n);
    });
    if (n === 3) updateTab3Panels();
    updateStepIndicator();
    // Auto-scroll to top so the user sees the new panel from the start.
    window.scrollTo({ top: 0, behavior: "smooth" });
    // v0.5.9: on phones, picking through 50+ entities is painful without
    // type-to-filter ready. Auto-focus search box when arriving on Tab 2.
    // Wait one tick so display:block has applied; otherwise focus is no-op.
    if (n === 2 && entitySearchEl) {
      Promise.resolve().then(() => entitySearchEl.focus({ preventScroll: true }));
    }
  }

  // 1 = Setup tab reachable always; 2 reachable when connected; 3 when
  // connected AND entity picked. Identical for both modes.
  function reachable(n) {
    const state = ws.getState();
    const connected = state === "authed" || state === "streaming";
    if (n === 1) return true;
    if (n === 2) return connected;
    if (n === 3) return connected && !!pickedEntity;
    return false;
  }

  function updateStepIndicator() {
    const state = ws.getState();
    const connected = state === "authed" || state === "streaming";
    const hasEntity = !!pickedEntity;
    const scanning = streamer.isActive();

    // v0.5.8: sticky Continue bar at the bottom of the viewport when
    // on Tab 2 with an entity picked. Body gets padding-bottom so the
    // last entity row isn't hidden under the bar.
    const showContinueBar = connected && hasEntity && activeTab === 2;
    if (continueBar) {
      continueBar.style.display = showContinueBar ? "block" : "none";
      document.body.classList.toggle("with-continue-bar", showContinueBar);
    }
    if (continueToScanBtn) {
      continueToScanBtn.textContent = mode === "identify"
        ? "Continue to identify →"
        : "Continue to scan →";
    }

    stepsEl.querySelectorAll(".step").forEach((s) => {
      const n = Number(s.dataset.step);
      s.disabled = !reachable(n);
      s.classList.remove("active", "done");
      if (n === activeTab) {
        s.classList.add("active");
      } else if (
        (n === 1 && connected) ||
        (n === 2 && hasEntity) ||
        (n === 3 && scanning)
      ) {
        s.classList.add("done");
      }
    });
  }

  // Click-to-switch on the steps bar.
  stepsEl.querySelectorAll(".step").forEach((s) => {
    s.addEventListener("click", () => {
      const n = Number(s.dataset.step);
      if (reachable(n)) switchTab(n);
    });
  });

  // v0.5.1: only auto-advance 1→2 (connection done). Don't 2→3 on pick —
  // that traps users who want to switch mode after a previous selection
  // was restored. Tab 3 is one tap away via the steps bar OR the Continue
  // button at the bottom of Tab 2.
  function maybeAutoAdvance() {
    const state = ws.getState();
    const connected = state === "authed" || state === "streaming";
    if (activeTab === 1 && connected) switchTab(2);
  }

  // ----- Streamer ---------------------------------------------------------
  const streamer = new Streamer({
    wsClient: ws,
    onStateChange: (s) => {
      const labels = {
        idle: "",
        subscribing: "subscribing to HA…",
        resubscribing: "reconnected — resubscribing…",
        streaming: "streaming to HA ✓",
        error: "stream error — check connection",
      };
      streamStateEl.textContent = labels[s] ?? "";
      streamStateEl.style.display = labels[s] ? "block" : "none";
      streamStateEl.className = "hint" + (s === "error" ? " error" : "");
    },
  });

  // ----- Wi-Fi streamer (v0.7.0) -----------------------------------------
  // Subscribes to home_insights/wifi_find_self and feeds incoming RSSI
  // events into the same rssi-display element used by BLE find. Server-
  // side already EMA-smooths, so we just trust rssi_smoothed and skip
  // the local filtering pipeline (which is BLE-noise-tuned anyway).
  let lastWifiSampleAt = 0;
  let lastWifiSample = null;  // {ap_name, ap_identifier, signal_attribute, ap_matches_target}
  let freshnessTimer = null;

  function _updateFreshnessPill() {
    if (!freshnessPillEl || !lastWifiSampleAt) return;
    const ageSec = Math.floor((Date.now() - lastWifiSampleAt) / 1000);
    let cls = "fresh";
    if (ageSec >= 60) cls = "frozen";
    else if (ageSec >= 25) cls = "stale";
    freshnessPillEl.className = `freshness-pill ${cls}`;
    freshnessLabelEl.textContent =
      ageSec < 2 ? "just now"
      : ageSec < 60 ? `last update ${ageSec} s ago`
      : `last update ${Math.floor(ageSec / 60)} min ago`;
  }

  function _wifiBucketFor(dbm) {
    // Mirror the wifi_find capability + detector thresholds. Slightly
    // more permissive than BLE's HOT/WARM since Wi-Fi distances are
    // longer.
    if (dbm >= -50) return { label: "VERY CLOSE", cls: "rssi-bucket-hot" };
    if (dbm >= -65) return { label: "PROBABLY HERE", cls: "rssi-bucket-warm" };
    if (dbm >= -75) return { label: "MAYBE ADJACENT", cls: "rssi-bucket-cool" };
    return { label: "WEAK", cls: "rssi-bucket-cold" };
  }

  function handleWifiSample(event) {
    lastWifiSampleAt = Date.now();
    lastWifiSample = event;
    const dbm = event.rssi_smoothed ?? event.rssi_raw;
    if (typeof dbm !== "number") return;
    const bucket = _wifiBucketFor(dbm);
    rssiValue.textContent = `${Math.round(dbm)} dBm`;
    rssiValue.className = `rssi-value ${bucket.cls}`;
    rssiBucket.textContent = bucket.label;
    rssiBucket.className = `rssi-label ${bucket.cls}`;
    // Trend arrow keys off whether this AP matches the target (if known)
    // or the user's just-walked direction (compare to previous).
    if (event.ap_matches_target) {
      rssiTrend.textContent = "🎯 at target's AP";
    } else if (event.ap_name) {
      rssiTrend.textContent = `📶 ${event.ap_name}`;
    } else {
      rssiTrend.textContent = "·";
    }
    rssiMeta.textContent = event.signal_attribute
      ? `via ${event.signal_attribute}` + (event._initial ? " · initial" : "")
      : "";
    // Flash the value to signal "new sample arrived" — same UX cue as BLE.
    rssiValue.classList.remove("flash");
    void rssiValue.offsetWidth;
    rssiValue.classList.add("flash");
    _updateFreshnessPill();
  }

  const wifiStreamer = new WifiStreamer({
    wsClient: ws,
    onSample: handleWifiSample,
    onStateChange: (s) => {
      const labels = {
        idle: "",
        subscribing: "subscribing to phone's AP signal…",
        resubscribing: "reconnected — resubscribing…",
        streaming: "streaming via Home Assistant ✓",
        error: "stream error — check connection",
      };
      if (!wifiFindStateEl) return;
      wifiFindStateEl.textContent = labels[s] ?? "";
      wifiFindStateEl.style.display = labels[s] ? "block" : "none";
      wifiFindStateEl.className = "hint" + (s === "error" ? " error" : "");
    },
    onInitialResult: (result) => {
      if (!result) return;
      if (result.is_trackable === false) {
        wifiFindErrorEl.textContent =
          (result.reason ?? "Picked entity is not Wi-Fi-trackable.")
          + " Pick a different entity (your phone should expose rx_rssi / "
          + "signal / signal_strength + ap_mac / bssid / host).";
        wifiFindErrorEl.style.display = "block";
      } else {
        wifiFindErrorEl.style.display = "none";
      }
    },
  });

  // ----- RSSI noise filtering (v0.4.1) -----------------------------------
  // BLE RSSI on phones is noisy: multipath fading, body shadowing, and
  // adjacent-channel interference can swing readings by 10-20 dB even
  // when standing still. The pipeline:
  //
  //   raw → median(last 3 raw) → EMA(alpha=0.25) → trend window
  //
  // Median rejects single-sample outliers (one stray -98 dBm reading
  // can't pull the smoothed value down). EMA smooths the rest. The
  // trend computation averages last 4 vs prior 4 samples instead of
  // 2 vs 2 — less sensitive to short transient bursts.
  //
  // Bucket labels use hysteresis: entering HOT needs ≥-53 dBm but the
  // label stays HOT until you drop below -58. Stops the bucket label
  // from flickering when you're sitting on a boundary.
  // v0.5.1: lighter smoothing. v0.4.3 over-corrected the close-range
  // flicker by widening every window — fine standing still, terrible
  // while walking. User reported half a house of walking + 1 min lag
  // before display caught up. New defaults: median-3 + alpha 0.3 +
  // 10-sample trend window = ~5s settling at 2 Hz, ~1.5s at 6 Hz.
  // HOT-zone freeze (from v0.4.3) is still in place so close-range
  // jitter doesn't drive arrow flicker.
  const TREND_WINDOW = 10;
  const EMA_ALPHA = 0.3;
  const MEDIAN_WINDOW = 3;
  // v0.5.1: staleness detection. If the target's advertisements stop
  // reaching the phone (BLE tracker rotated MAC, walked out of range,
  // paused under anti-stalking heuristic, etc.) the display would
  // otherwise freeze on the last reading forever. After STALE_MS with
  // no new sample for the filtered target, show "lost target".
  const STALE_MS = 5000;
  let lastTargetSampleAt = 0;
  const rawBuffer = [];      // last MEDIAN_WINDOW raw samples for median filter
  const trendBuffer = [];    // last TREND_WINDOW smoothed samples for trend
  let smoothedRssi = null;
  let lastBucketLabel = null;
  // Nearby BLE devices map: name -> { latestRssi, latestTs }
  const nearby = new Map();
  let nearbyRenderTimer = null;

  function medianOf(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function pushRssi(raw) {
    rawBuffer.push(raw);
    while (rawBuffer.length > MEDIAN_WINDOW) rawBuffer.shift();
    // Use the median once we have a full window; otherwise pass raw
    // through so the user sees SOMETHING quickly at scan start.
    const filtered = rawBuffer.length >= MEDIAN_WINDOW
      ? medianOf(rawBuffer)
      : raw;
    if (smoothedRssi === null) smoothedRssi = filtered;
    else smoothedRssi = EMA_ALPHA * filtered + (1 - EMA_ALPHA) * smoothedRssi;
    trendBuffer.push(smoothedRssi);
    while (trendBuffer.length > TREND_WINDOW) trendBuffer.shift();
  }

  function computeTrend() {
    const buf = trendBuffer;
    if (buf.length < 12) return { arrow: "·", label: "settling" };
    // v0.4.3: HOT-zone freeze. At close range (≥ -55 dBm) the RSSI noise
    // floor is ~5-8 dB stddev from antenna geometry alone — bigger than
    // the ~3 dB delta from a single step. Extracting "closer / further"
    // from sub-noise-floor signal is mathematically dishonest, the
    // arrow has to flicker. AirTag handles this by switching to UWB
    // below 1m; we can't. Best honest UX: freeze the arrow and tell
    // the user to sweep slowly to find peak.
    const latest = buf[buf.length - 1];
    if (latest >= -55) {
      return { arrow: "🔥", label: "very close — sweep slowly to peak" };
    }
    // 6-vs-6 averaging window for stability.
    const recent = buf.slice(-6).reduce((a, b) => a + b, 0) / 6;
    const earlier = buf.slice(-12, -6).reduce((a, b) => a + b, 0) / 6;
    const delta = recent - earlier;
    // Adaptive deadband for moderate range:
    //   warm (-70..-55): ±3 dB
    //   cool/cold (< -70): ±2 dB
    const threshold = recent >= -70 ? 3 : 2;
    if (delta > threshold) return { arrow: "↑", label: "getting closer" };
    if (delta < -threshold) return { arrow: "↓", label: "getting further" };
    return { arrow: "→", label: "stable" };
  }

  // Hysteretic bucket assignment: entering a bucket has tighter threshold
  // than leaving it, so the label doesn't flicker on the boundary.
  function rssiBucketFor(rssi) {
    const HYST = 3;  // dB
    // Enter thresholds: HOT >= -55, warm >= -70, cool >= -85
    // Leave (relax) by HYST dB before dropping to next-lower bucket.
    const prev = lastBucketLabel;
    function bucket(label, cls) { return { label, cls }; }
    if (prev === "HOT") {
      if (rssi >= -55 - HYST) return bucket("HOT", "rssi-bucket-hot");
      if (rssi >= -70 - HYST) return bucket("warm", "rssi-bucket-warm");
      if (rssi >= -85 - HYST) return bucket("cool", "rssi-bucket-cool");
      return bucket("cold", "rssi-bucket-cold");
    }
    if (prev === "warm") {
      if (rssi >= -55) return bucket("HOT", "rssi-bucket-hot");
      if (rssi >= -70 - HYST) return bucket("warm", "rssi-bucket-warm");
      if (rssi >= -85 - HYST) return bucket("cool", "rssi-bucket-cool");
      return bucket("cold", "rssi-bucket-cold");
    }
    if (prev === "cool") {
      if (rssi >= -55) return bucket("HOT", "rssi-bucket-hot");
      if (rssi >= -70) return bucket("warm", "rssi-bucket-warm");
      if (rssi >= -85 - HYST) return bucket("cool", "rssi-bucket-cool");
      return bucket("cold", "rssi-bucket-cold");
    }
    // Default (no prior bucket, or coming from cold) — strict thresholds.
    if (rssi >= -55) return bucket("HOT", "rssi-bucket-hot");
    if (rssi >= -70) return bucket("warm", "rssi-bucket-warm");
    if (rssi >= -85) return bucket("cool", "rssi-bucket-cool");
    return bucket("cold", "rssi-bucket-cold");
  }

  function showError(msg) {
    scanError.style.display = "block";
    scanError.textContent = msg;
  }
  function clearError() {
    scanError.style.display = "none";
    scanError.textContent = "";
  }

  function updateRssiDisplay(rssi, deviceName) {
    if (rssi === null) {
      rssiValue.textContent = "— dBm";
      rssiBucket.textContent = "waiting…";
      rssiBucket.className = "rssi-label";
      rssiTrend.textContent = "·";
      rssiMeta.textContent = "";
      return;
    }
    const bucket = rssiBucketFor(rssi);
    const trend = computeTrend();
    rssiValue.textContent = `${Math.round(rssi)} dBm`;
    rssiBucket.textContent = bucket.label;
    rssiBucket.className = `rssi-label ${bucket.cls}`;
    rssiValue.className = `rssi-value ${bucket.cls}`;
    rssiTrend.textContent = `${trend.arrow} ${trend.label}`;
    rssiMeta.textContent = deviceName ? `device: ${deviceName}` : "";
    // Sample-arrived flash. Force reflow to retrigger animation.
    rssiValue.classList.remove("flash");
    void rssiValue.offsetWidth;
    rssiValue.classList.add("flash");
    // Haptic + secondary signal on bucket transition (only on phone).
    if (lastBucketLabel && lastBucketLabel !== bucket.label) {
      if (typeof navigator.vibrate === "function") {
        // Short tap on bucket change. Pattern emphasises hot vs cold:
        // crossing into HOT gets two pulses, otherwise one.
        if (bucket.label === "HOT") navigator.vibrate([30, 50, 30]);
        else navigator.vibrate(30);
      }
    }
    lastBucketLabel = bucket.label;
  }

  function renderNearby() {
    nearbyListEl.innerHTML = "";
    // Sort by RSSI strength (closer first), cap at 10.
    const rows = [...nearby.entries()]
      .filter(([, v]) => Date.now() - v.latestTs < 8000)  // age out stale
      .sort((a, b) => b[1].latestRssi - a[1].latestRssi)
      .slice(0, 10);
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.style.padding = "10px 12px";
      empty.textContent = "Nothing seen yet. Move closer to a BLE device.";
      nearbyListEl.appendChild(empty);
      return;
    }
    rows.forEach(([name, info]) => {
      const row = document.createElement("div");
      row.className = "nearby-row";
      row.innerHTML =
        '<span class="nearby-name"></span><span class="nearby-rssi"></span>';
      row.querySelector(".nearby-name").textContent = name;
      row.querySelector(".nearby-rssi").textContent = `${Math.round(info.latestRssi)} dBm`;
      row.addEventListener("click", () => {
        // Switch the BLE name filter to this device.
        bleNameEl.value = name;
        // Reset local smoothing since we changed target.
        rawBuffer.length = 0;
        trendBuffer.length = 0;
        smoothedRssi = null;
        lastBucketLabel = null;
        updateRssiDisplay(null);
      });
      nearbyListEl.appendChild(row);
    });
  }

  // ----- Active BLE scan --------------------------------------------------
  let currentScan = null;
  let scanAbortController = null;

  function flagAvailable() {
    return !!(navigator.bluetooth && typeof navigator.bluetooth.requestLEScan === "function");
  }

  // Auto-show / auto-hide the flag-onboarding card. v0.4: after the user
  // returns from chrome://flags + relaunch, the page is reloaded fresh,
  // requestLEScan is now defined, the card auto-hides.
  function refreshFlagCard() {
    flagCard.style.display = flagAvailable() ? "none" : "block";
  }
  refreshFlagCard();
  copyFlagBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(flagUrlInput.value);
      copyFlagBtn.textContent = "Copied ✓";
      setTimeout(() => (copyFlagBtn.textContent = "Copy"), 1500);
    } catch (_) {
      // clipboard.writeText can fail without HTTPS or user gesture; fall
      // back to selectAll so the user can manually copy.
      flagUrlInput.focus();
      flagUrlInput.select();
    }
  });

  scanBtn.addEventListener("click", async () => {
    clearError();
    if (!navigator.bluetooth) {
      showError("Web Bluetooth not supported. Use Chrome or Edge on Android.");
      return;
    }
    if (!flagAvailable()) {
      refreshFlagCard();
      showError("Active LE scan not available — enable the flag above, then relaunch Chrome.");
      return;
    }

    localStorage.setItem("ble_mac", bleMacEl.value.trim());

    try {
      // Swap scan-section out for rssi-section — only the active surface
      // is visible within the Scan tab.
      scanSection.style.display = "none";
      rssiSection.style.display = "block";
      rawBuffer.length = 0;
      trendBuffer.length = 0;
      smoothedRssi = null;
      lastBucketLabel = null;
      nearby.clear();
      updateRssiDisplay(null);

      // v0.4.1: ALWAYS scan all advertisements. Previously the auto-
      // detected name prefix was passed to Chrome's OS-level filter,
      // which silently dropped every advertisement when the prefix
      // didn't match the BLE-broadcast name — and the "nearby" picker
      // (whose whole purpose is to reveal the real name) also got
      // nothing. Now: scan everything, JS-filter for display, JS-
      // populate nearby so the user can pick the right name.
      const scanOpts = { acceptAllAdvertisements: true };

      scanAbortController = new AbortController();
      navigator.bluetooth.addEventListener(
        "advertisementreceived",
        handleAdvertisement,
        { signal: scanAbortController.signal },
      );
      currentScan = await navigator.bluetooth.requestLEScan(scanOpts);
      scanBtn.disabled = true;
      saveBtn.disabled = true;
      rssiSection.classList.add("scanning");
      nearbyRenderTimer = setInterval(renderNearby, 1500);
      lastTargetSampleAt = 0;
      startStalenessWatch();

      // Kick HA stream.
      if ((ws.getState() === "authed" || ws.getState() === "streaming") && pickedEntity) {
        const mac = bleMacEl.value.trim() || null;
        try {
          await streamer.start(pickedEntity.entity_id, mac);
        } catch (e) {
          const code = e?.error?.code ?? e?.code ?? null;
          const msg = e?.error?.message ?? e?.message ?? String(e);
          if (code === "unknown_command" || /unknown[_ ]command/i.test(msg)) {
            streamStateEl.textContent = "Local-only — install ha-insights v1.15+ for HA-side stream sync.";
            streamStateEl.style.display = "block";
            streamStateEl.className = "hint";
          } else {
            showError("HA stream subscribe failed: " + msg);
          }
        }
      } else if (!pickedEntity) {
        streamStateEl.textContent = "Local only — pick an HA entity to stream.";
        streamStateEl.style.display = "block";
        streamStateEl.className = "hint";
      }
      updateStepIndicator();
    } catch (err) {
      showError(`Scan failed: ${err.message ?? err}`);
      stopScanInternal();
    }
  });

  stopBtn.addEventListener("click", () => {
    // v0.7.0: stop button is mode-aware. In Wi-Fi mode it tears down
    // the wifi_find_self subscription; in BLE mode the usual scan teardown.
    if (mode === "wifi" && wifiStreamer.isActive()) {
      stopWifiFindInternal();
    } else {
      stopScanInternal();
    }
  });

  // ----- Wi-Fi find handlers (v0.7.0) -------------------------------------
  // v0.7.1: 45 s soft-timeout. UniFi's default per-client signal poll is
  // 30 s, UDM/UDR sometimes 10 s. If no sample lands in 45 s, surface a
  // hint that the user's router may not be polling per-client signal
  // (instead of just silently sitting at "— dBm").
  let wifiNoSampleTimer = null;
  if (wifiFindStartBtn) {
    wifiFindStartBtn.addEventListener("click", async () => {
      wifiFindErrorEl.style.display = "none";
      if (!pickedEntity) {
        wifiFindErrorEl.textContent = "Pick your phone's device_tracker entity first (Tab 2).";
        wifiFindErrorEl.style.display = "block";
        return;
      }
      if (!(ws.getState() === "authed" || ws.getState() === "streaming")) {
        wifiFindErrorEl.textContent = "Not connected to Home Assistant.";
        wifiFindErrorEl.style.display = "block";
        return;
      }
      // v0.7.1: keep the start surface visible until we KNOW the initial
      // result is trackable. The old code swapped to rssi-section before
      // the await, so if the entity wasn't Wi-Fi-trackable (or the
      // server lacked the handler), the error was invisibly written to
      // wifiFindErrorEl while the user stared at "— dBm" / "subscribing…".
      lastWifiSampleAt = 0;
      lastWifiSample = null;
      wifiFindStartBtn.disabled = true;
      let initialResult = null;
      try {
        initialResult = await wifiStreamer.start(pickedEntity.entity_id);
      } catch (e) {
        wifiFindStartBtn.disabled = false;
        const code = e?.error?.code ?? e?.code ?? null;
        const msg = e?.error?.message ?? e?.message ?? String(e);
        if (code === "unknown_command" || /unknown[_ ]command/i.test(msg)) {
          wifiFindErrorEl.innerHTML =
            "<strong>HA Insights v1.21.0 or newer required.</strong> "
            + "The <code>home_insights/wifi_find_self</code> WS handler "
            + "lives in v1.21.0+. Open HACS in Home Assistant and update "
            + "HA Insights, then retry.";
        } else {
          wifiFindErrorEl.textContent = "Wi-Fi find subscribe failed: " + msg;
        }
        wifiFindErrorEl.style.display = "block";
        return;
      }
      // Subscribe succeeded. Inspect the initial result BEFORE we hide
      // the wifi-find-section — otherwise the error message would land
      // on a hidden surface.
      if (initialResult && initialResult.is_trackable === false) {
        // Tear down the subscription cleanly.
        try { await wifiStreamer.stop(); } catch (_) { /* ignore */ }
        wifiFindStartBtn.disabled = false;
        const reason = initialResult.reason
          ?? "Entity is not Wi-Fi-trackable from the integration's state attributes.";
        wifiFindErrorEl.innerHTML =
          "<strong>" + pickedEntity.entity_id + " has no Wi-Fi signal data.</strong> "
          + reason
          + "<br><br>Try picking a different entity. UniFi exposes "
          + "<code>rx_rssi</code> + <code>ap_mac</code> on its "
          + "device-tracker entities; Asuswrt-Merlin exposes "
          + "<code>signal</code> + <code>host</code>. The HA mobile_app "
          + "device-tracker is GPS-only and won't work here.";
        wifiFindErrorEl.style.display = "block";
        return;
      }
      // Initial result OK — now swap surfaces.
      wifiFindSection.style.display = "none";
      rssiSection.style.display = "block";
      rssiSection.classList.add("scanning");
      // Hide nearby-devices section in Wi-Fi mode (BLE-only concept).
      const nearbyDetails = $("nearby-details");
      if (nearbyDetails) nearbyDetails.style.display = "none";
      if (freshnessPillEl) freshnessPillEl.style.display = "inline-block";
      // Initial RSSI display: if the server gave us a current reading,
      // it was already pushed through handleWifiSample by the streamer's
      // _maybeEmitInitialAsSample. Otherwise show a clear "waiting"
      // state instead of the misleading "subscribing…" placeholder.
      if (!lastWifiSampleAt) {
        rssiValue.textContent = "— dBm";
        rssiValue.className = "rssi-value";
        rssiBucket.textContent = "waiting for first sample…";
        rssiTrend.textContent = "·";
        rssiMeta.textContent = "polling cadence ~10–30 s on most routers";
      }
      // Freshness pill 1-Hz updater.
      if (freshnessTimer) clearInterval(freshnessTimer);
      freshnessTimer = setInterval(_updateFreshnessPill, 1000);
      // 45-second no-sample warning.
      if (wifiNoSampleTimer) clearTimeout(wifiNoSampleTimer);
      wifiNoSampleTimer = setTimeout(() => {
        if (!lastWifiSampleAt && wifiStreamer.isActive()) {
          rssiBucket.textContent = "no samples yet — router not polling?";
          rssiBucket.className = "rssi-label";
          rssiMeta.textContent =
            "Check your UniFi / Asuswrt / Omada controller's per-client "
            + "statistics interval (10–30 s typical).";
        }
      }, 45000);
      updateStepIndicator();
    });
  }

  async function stopWifiFindInternal() {
    if (freshnessTimer) { clearInterval(freshnessTimer); freshnessTimer = null; }
    if (wifiNoSampleTimer) { clearTimeout(wifiNoSampleTimer); wifiNoSampleTimer = null; }
    if (wifiStreamer.isActive()) {
      try { await wifiStreamer.stop(); } catch (_) { /* ignore */ }
    }
    rssiSection.classList.remove("scanning");
    rssiSection.style.display = "none";
    wifiFindSection.style.display = "block";
    if (freshnessPillEl) freshnessPillEl.style.display = "none";
    if (wifiFindStartBtn) wifiFindStartBtn.disabled = false;
    // Restore nearby-devices section visibility (BLE mode reuses it).
    const nearbyDetails = $("nearby-details");
    if (nearbyDetails) nearbyDetails.style.display = "";
    updateRssiDisplay(null);
    updateStepIndicator();
  }

  function handleAdvertisement(event) {
    const rssi = event.rssi;
    const name = event.device?.name ?? null;
    if (name) {
      // Always populate the "nearby" map regardless of filter — lets the
      // user switch target mid-scan via the picker.
      nearby.set(name, { latestRssi: rssi, latestTs: Date.now() });
    }
    const targetName = bleNameEl.value.trim().toLowerCase();
    if (targetName && (!name || !name.toLowerCase().includes(targetName))) {
      return; // not our target
    }
    pushRssi(rssi);
    lastTargetSampleAt = Date.now();
    updateRssiDisplay(smoothedRssi, name);
    if (streamer.isActive()) {
      streamer.pushSample(rssi, name);
      dlog("rssi", rssi, name);
    }
  }

  // v0.5.1: poll for staleness. When the user filters on a name prefix
  // and the target stops advertising (out of range, MAC rotation,
  // anti-stalking pause), we'd otherwise show stale data forever. This
  // poll runs alongside the scan and overrides the RSSI display with a
  // "lost target" message when no matching advertisement has arrived
  // for STALE_MS.
  let stalenessTimer = null;
  function startStalenessWatch() {
    stopStalenessWatch();
    stalenessTimer = setInterval(() => {
      if (lastTargetSampleAt === 0) return;  // never had a sample yet
      const age = Date.now() - lastTargetSampleAt;
      if (age > STALE_MS) {
        rssiBucket.textContent = "lost signal";
        rssiBucket.className = "rssi-label rssi-bucket-cold";
        rssiValue.className = "rssi-value rssi-bucket-cold";
        rssiTrend.textContent = "🔍 no recent advertisement";
        rssiMeta.textContent =
          `last seen ${Math.round(age / 1000)}s ago — target may have moved out of `
          + "range, paused advertising, or rotated its BLE MAC";
      }
    }, 1000);
  }
  function stopStalenessWatch() {
    if (stalenessTimer) {
      clearInterval(stalenessTimer);
      stalenessTimer = null;
    }
  }

  function stopScanInternal() {
    if (currentScan) {
      try { currentScan.stop(); } catch (_) { /* may already be stopped */ }
      currentScan = null;
    }
    if (scanAbortController) {
      scanAbortController.abort();
      scanAbortController = null;
    }
    if (nearbyRenderTimer) {
      clearInterval(nearbyRenderTimer);
      nearbyRenderTimer = null;
    }
    stopStalenessWatch();
    rssiSection.classList.remove("scanning");
    if (streamer.isActive()) {
      streamer.stop().catch(() => { /* ignore */ });
    }
    scanBtn.disabled = false;
    saveBtn.disabled = false;
    // v0.4.1: hide the RSSI display + show Start Scan again so the user
    // gets a clean "ready" surface, not the frozen Stop button sitting
    // next to stale RSSI numbers.
    rssiSection.style.display = "none";
    scanSection.style.display = "block";
    clearError();
    updateRssiDisplay(null);
    streamStateEl.style.display = "none";
    updateStepIndicator();
  }

  // ----- Identify mode handlers (v0.5) -----------------------------------
  // v0.5.8: Flash modes — single blink or repeat-until-stop loop.
  // SAFE interval = 2500 ms. Vendor reset/pairing thresholds we
  // explicitly avoid (from memory `identify_vendor_pairing_thresholds`):
  //   Tuya 3×/10s, Aqara 5×/5s, Hue 5×/10s, IKEA 6×/10s, Sengled 10×,
  //   LIFX 5×/5s, Shelly 5×/30s. At 1 toggle per 2.5s, no pattern
  //   reaches any vendor's reset count within their window.
  // Hard auto-stop after 60s as belt-and-braces.
  const FLASH_INTERVAL_MS = 2500;
  const FLASH_LOOP_MAX_MS = 60000;
  let flashLoopTimer = null;
  let flashLoopStartedAt = 0;

  function stopFlashLoop() {
    if (flashLoopTimer) {
      clearInterval(flashLoopTimer);
      flashLoopTimer = null;
    }
    flashStopBtn.style.display = "none";
    flashBtn.disabled = false;
    flashBtn.textContent = "🔆 Flash this entity";
  }

  flashBtn.addEventListener("click", async () => {
    identifyErrorEl.style.display = "none";
    if (!pickedEntity) {
      identifyErrorEl.textContent = "Pick an entity first.";
      identifyErrorEl.style.display = "block";
      return;
    }
    const flashMode = flashModeEl.value || "single";
    if (flashMode === "loop") {
      // Repeat until user stops or 60s elapses.
      stopFlashLoop();  // clear any previous loop
      flashBtn.disabled = true;
      flashBtn.textContent = "🔆 Flashing…";
      flashStopBtn.style.display = "block";
      flashLoopStartedAt = Date.now();
      // Fire immediately, then on interval.
      const tick = async () => {
        if (Date.now() - flashLoopStartedAt > FLASH_LOOP_MAX_MS) {
          stopFlashLoop();
          return;
        }
        try {
          await flashEntity(pickedEntity);
          if (typeof navigator.vibrate === "function") navigator.vibrate(20);
        } catch (e) {
          const msg = e?.error?.message ?? e?.message ?? String(e);
          identifyErrorEl.textContent = "Flash failed: " + msg;
          identifyErrorEl.style.display = "block";
          stopFlashLoop();
        }
      };
      tick();
      flashLoopTimer = setInterval(tick, FLASH_INTERVAL_MS);
      return;
    }
    // Single-blink mode.
    flashBtn.disabled = true;
    flashBtn.textContent = "🔆 Flashing…";
    try {
      await flashEntity(pickedEntity);
      flashBtn.textContent = "🔆 Flash again";
      if (typeof navigator.vibrate === "function") navigator.vibrate(40);
    } catch (e) {
      const msg = e?.error?.message ?? e?.message ?? String(e);
      identifyErrorEl.textContent = "Flash failed: " + msg;
      identifyErrorEl.style.display = "block";
      flashBtn.textContent = "🔆 Flash this entity";
    } finally {
      flashBtn.disabled = false;
    }
  });

  flashStopBtn.addEventListener("click", () => {
    stopFlashLoop();
  });

  confirmAreaBtn.addEventListener("click", async () => {
    identifyErrorEl.style.display = "none";
    identifyConfirmedEl.style.display = "none";
    if (!pickedEntity) {
      identifyErrorEl.textContent = "Pick an entity first.";
      identifyErrorEl.style.display = "block";
      return;
    }
    const areaId = areaSelectEl.value || null;
    if (!areaId) {
      identifyErrorEl.textContent = "Pick an area from the dropdown first.";
      identifyErrorEl.style.display = "block";
      return;
    }
    confirmAreaBtn.disabled = true;
    confirmAreaBtn.textContent = "Saving…";
    try {
      await ws.request({
        type: "config/entity_registry/update",
        entity_id: pickedEntity.entity_id,
        area_id: areaId,
      });
      // Mirror locally so subsequent picks reflect the new area.
      pickedEntity.area_id = areaId;
      const areaName = areas.find((a) => a.id === areaId)?.name || areaId;
      identifyConfirmedEl.innerHTML =
        '✓ Confirmed <strong>' + pickedEntity.entity_id + '</strong>'
        + ' is in <strong></strong>.';
      identifyConfirmedEl.querySelector("strong:last-child").textContent = areaName;
      identifyConfirmedEl.style.display = "block";
      // Update the displayed state area.
      const areaSpan = identifyStateEl.querySelector(".value.area");
      if (areaSpan) areaSpan.textContent = areaName;
    } catch (e) {
      const msg = e?.error?.message ?? e?.message ?? String(e);
      identifyErrorEl.textContent = "Failed to update area: " + msg;
      identifyErrorEl.style.display = "block";
    } finally {
      confirmAreaBtn.disabled = false;
      confirmAreaBtn.textContent = "I'm here ✓";
    }
  });

  // ----- Service worker — v0.5.2 auto-reload on new SW takeover ----------
  // Without this, a deploy lands a new SW + cache + HTML, the SW takes
  // over via clients.claim(), but the running page is STILL executing
  // the JS it loaded before — so user sees freshly-rendered HTML
  // wired to stale JS (e.g. new .tab-panel divs that no JS listener
  // ever activates → blank page below the step bar). Listening for
  // controllerchange catches the moment the new SW takes over and
  // forces a single reload to pull the fresh JS.
  if ("serviceWorker" in navigator) {
    let didReload = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (didReload) return;  // avoid reload loop
      didReload = true;
      window.location.reload();
    });
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").then((reg) => {
        reg.update().catch(() => { /* ignore */ });
      }).catch(() => { /* ok */ });
    });
  }

  // ----- Initial state ----------------------------------------------------
  switchTab(1);  // always start on Setup
  if (haUrlEl.value && haTokenEl.value) {
    ws.connect(haUrlEl.value, haTokenEl.value);
  }
})();
