// Find My HA Device — main wiring.
//
// v0.1: local BLE scan + RSSI display.
// v0.2: HA WebSocket pairing + entity picker + live RSSI streaming.
//
// This file is the controller: it owns DOM refs and orchestrates the
// scanner ↔ WS client ↔ streamer modules. The actual logic is in
// ws_client.js / entity_picker.js / streamer.js.
//
// Local-only mode still works — users can run a scan without connecting
// to HA at all. Streaming kicks in only when (scanning ∧ authed ∧ entity-picked).
//
// Web Bluetooth API constraints:
//   - Only available in Chrome/Edge on Android
//   - requestLEScan() is behind chrome://flags/#enable-experimental-web-platform-features
//   - Background scanning from a tab is not permitted; standalone-installed
//     PWA + the user keeping the screen on is the closest we get today

(function () {
  "use strict";

  // ----- DEBUG flag -------------------------------------------------------
  // Local logging of RSSI samples is useful during development but the spec
  // says we must NOT log streamed samples in production. Flip this off
  // before deploying.
  const DEBUG = false;
  function dlog() {
    if (DEBUG) console.log.apply(console, arguments);
  }

  // ----- DOM refs ---------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const haUrlEl = $("ha-url");
  const haTokenEl = $("ha-token");
  const saveBtn = $("save-creds-btn");
  const connectBtn = $("connect-btn");
  const disconnectBtn = $("disconnect-btn");
  const connStateEl = $("conn-state");
  const connDetailEl = $("conn-detail");

  const entitySearchEl = $("entity-search");
  const entityListEl = $("entity-list");
  const entityStatusEl = $("entity-status");
  const entitySelectedEl = $("entity-selected");
  const refreshEntitiesBtn = $("refresh-entities-btn");

  const bleNameEl = $("ble-name");
  const bleMacEl = $("ble-mac");
  const scanBtn = $("scan-btn");
  const stopBtn = $("stop-btn");
  const rssiSection = $("rssi-section");
  const rssiValue = $("rssi-value");
  const rssiBucket = $("rssi-bucket");
  const rssiTrend = $("rssi-trend");
  const rssiMeta = $("rssi-meta");
  const streamStateEl = $("stream-state");
  const scanError = $("scan-error");

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

  // ----- WS client setup --------------------------------------------------
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

  ws.onStateChange(({ state, error }) => {
    const label = CONN_LABELS[state] ?? CONN_LABELS.disconnected;
    connStateEl.textContent = label.text;
    connStateEl.className = "conn-pill " + label.cls;
    connDetailEl.textContent = error ?? "";
    connDetailEl.style.display = error ? "block" : "none";

    // Show/hide disconnect button.
    const live = state !== "disconnected" && state !== "error";
    connectBtn.style.display = live ? "none" : "block";
    disconnectBtn.style.display = live ? "block" : "none";

    // Load entities on first successful auth.
    if (state === "authed") {
      entityPicker.load(ws);
    }
    if (state === "disconnected" || state === "error") {
      // Stop streaming if it was running; the WS layer already discarded the
      // subscription on close.
      if (streamer.isActive()) {
        streamer.stop().catch(() => { /* ignore */ });
      }
    }
  });

  connectBtn.addEventListener("click", () => {
    const url = haUrlEl.value.trim();
    const token = haTokenEl.value.trim();
    if (!url || !token) {
      connDetailEl.textContent = "Enter HA URL and token first.";
      connDetailEl.style.display = "block";
      return;
    }
    localStorage.setItem("ha_url", url);
    localStorage.setItem("ha_token", token);
    ws.connect(url, token);
  });

  disconnectBtn.addEventListener("click", () => {
    ws.disconnect();
    entityPicker.clear();
    pickedEntity = null;
    updateEntitySelectedDisplay();
  });

  // ----- Entity picker ----------------------------------------------------
  const entityPicker = new EntityPicker({
    inputEl: entitySearchEl,
    listEl: entityListEl,
    statusEl: entityStatusEl,
    onPick: (entry) => {
      pickedEntity = entry;
      localStorage.setItem("ha_entity_id", entry.entity_id);
      // v0.3: auto-fill BLE filter fields from the entity's HA device
      // record. Without this, the phone scans every advertisement in
      // range and the local trend arrow jitters across unrelated
      // devices. Overwriting unconditionally on each pick is the right
      // default: the common "I edited the field" case is "I picked the
      // wrong entity, now picking again" — wiping stale fields. Manual
      // overrides go in AFTER the final pick.
      const ble = entityPicker.getBleInfo(entry);
      if (ble) {
        bleNameEl.value = ble.suggested_name_prefix || "";
        bleMacEl.value = ble.bluetooth_mac || "";
        if (ble.bluetooth_mac) localStorage.setItem("ble_mac", ble.bluetooth_mac);
      } else {
        // No BLE info for this entity — clear fields so a previous
        // entity's auto-fill doesn't bleed through.
        bleNameEl.value = "";
        bleMacEl.value = "";
      }
      updateEntitySelectedDisplay(ble);
    },
  });

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
    // v0.3: surface what we auto-detected so the user can tell why
    // their filter fields got populated (and so they know to override
    // if the device's BLE name differs from its HA display name).
    if (bleInfo && (bleInfo.bluetooth_mac || bleInfo.suggested_name_prefix)) {
      const parts = [];
      if (bleInfo.suggested_name_prefix) {
        parts.push(`name prefix “${bleInfo.suggested_name_prefix}”`);
      }
      if (bleInfo.bluetooth_mac) parts.push(`MAC ${bleInfo.bluetooth_mac}`);
      txt += `\nAuto-detected: ${parts.join(", ")}`;
    } else if (bleInfo === null && pickedEntity) {
      // Picker reported no BLE info — common for esphome-proxy-discovered
      // entities whose underlying device isn't in HA's BT registry.
      txt += "\n(no Bluetooth info on file — type a name prefix manually)";
    }
    entitySelectedEl.textContent = txt;
    entitySelectedEl.style.whiteSpace = "pre-line";
    entitySelectedEl.style.display = "block";
  }

  // ----- Streamer ---------------------------------------------------------
  const streamer = new Streamer({
    wsClient: ws,
    onStateChange: (s) => {
      const labels = {
        idle: "",
        subscribing: "subscribing to HA…",
        streaming: "streaming to HA ✓",
        error: "stream error — check connection",
      };
      streamStateEl.textContent = labels[s] ?? "";
      streamStateEl.style.display = labels[s] ? "block" : "none";
      streamStateEl.className = "hint" + (s === "error" ? " error" : "");
    },
  });

  // ----- RSSI display state (local — unchanged from v0.1) -----------------
  const trendBuffer = [];
  const TREND_WINDOW = 8;
  const EMA_ALPHA = 0.4;
  let smoothedRssi = null;

  function pushRssi(raw) {
    if (smoothedRssi === null) {
      smoothedRssi = raw;
    } else {
      smoothedRssi = EMA_ALPHA * raw + (1 - EMA_ALPHA) * smoothedRssi;
    }
    trendBuffer.push(smoothedRssi);
    while (trendBuffer.length > TREND_WINDOW) trendBuffer.shift();
  }

  function computeTrend() {
    const buf = trendBuffer;
    if (buf.length < 4) return { arrow: "·", label: "settling" };
    const recent = (buf[buf.length - 1] + buf[buf.length - 2]) / 2;
    const earlier = (buf[buf.length - 4] + buf[buf.length - 3]) / 2;
    const delta = recent - earlier;
    if (delta > 2) return { arrow: "↑", label: "getting closer" };
    if (delta < -2) return { arrow: "↓", label: "getting further" };
    return { arrow: "→", label: "stable" };
  }

  function rssiBucketFor(rssi) {
    if (rssi >= -55) return { label: "HOT", cls: "rssi-bucket-hot" };
    if (rssi >= -70) return { label: "warm", cls: "rssi-bucket-warm" };
    if (rssi >= -85) return { label: "cool", cls: "rssi-bucket-cool" };
    return { label: "cold", cls: "rssi-bucket-cold" };
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
  }

  // ----- Active BLE scan --------------------------------------------------
  let currentScan = null;
  let scanAbortController = null;

  scanBtn.addEventListener("click", async () => {
    clearError();
    if (!navigator.bluetooth) {
      showError("Web Bluetooth not supported. Use Chrome or Edge on Android.");
      return;
    }
    if (!navigator.bluetooth.requestLEScan) {
      showError(
        "Active LE scan not available in this browser. Enable the flag "
        + "chrome://flags/#enable-experimental-web-platform-features, "
        + "then restart Chrome and try again.",
      );
      return;
    }

    // Persist optional BLE MAC hint for cross-reference with HA's proxies.
    localStorage.setItem("ble_mac", bleMacEl.value.trim());

    try {
      rssiSection.style.display = "block";
      trendBuffer.length = 0;
      smoothedRssi = null;
      updateRssiDisplay(null);

      const targetName = bleNameEl.value.trim().toLowerCase();
      const scanOpts = targetName
        ? { filters: [{ namePrefix: bleNameEl.value.trim() }] }
        : { acceptAllAdvertisements: true };

      scanAbortController = new AbortController();
      navigator.bluetooth.addEventListener(
        "advertisementreceived",
        handleAdvertisement,
        { signal: scanAbortController.signal },
      );

      currentScan = await navigator.bluetooth.requestLEScan(scanOpts);

      scanBtn.disabled = true;
      saveBtn.disabled = true;

      // Kick off the HA stream if we have everything.
      if ((ws.getState() === "authed" || ws.getState() === "streaming") && pickedEntity) {
        const mac = bleMacEl.value.trim() || null;
        try {
          await streamer.start(pickedEntity.entity_id, mac);
        } catch (e) {
          // Special-case unknown_command: the user's ha-insights install
          // doesn't have v1.15.0's companion_scan handlers yet. Local
          // scan still works fine; don't scare the user with a red error
          // banner for an expected server-side capability gap.
          const code = e?.error?.code ?? e?.code ?? null;
          const msg = e?.error?.message ?? e?.message ?? String(e);
          if (code === "unknown_command" || /unknown[_ ]command/i.test(msg)) {
            streamStateEl.textContent =
              "Local-only — install ha-insights v1.15+ for HA-side stream sync.";
            streamStateEl.style.display = "block";
            streamStateEl.className = "hint";
          } else {
            showError("HA stream subscribe failed: " + msg);
          }
        }
      } else if (!pickedEntity) {
        // Local-only scan; that's a supported mode per spec.
        // Don't error, just hint.
        streamStateEl.textContent = "Local only — pick an HA entity to stream.";
        streamStateEl.style.display = "block";
        streamStateEl.className = "hint";
      }
    } catch (err) {
      showError(`Scan failed: ${err.message ?? err}`);
      stopScanInternal();
    }
  });

  stopBtn.addEventListener("click", () => {
    stopScanInternal();
  });

  function handleAdvertisement(event) {
    const rssi = event.rssi;
    const name = event.device?.name ?? null;
    const targetName = bleNameEl.value.trim().toLowerCase();
    if (targetName && (!name || !name.toLowerCase().includes(targetName))) {
      return; // not our target
    }
    // Local display uses smoothed value (better UX for the trend arrow).
    pushRssi(rssi);
    updateRssiDisplay(smoothedRssi, name);
    // Server gets raw — it does its own smoothing.
    if (streamer.isActive()) {
      streamer.pushSample(rssi, name);
      dlog("rssi", rssi, name); // DEBUG-gated; off by default
    }
  }

  function stopScanInternal() {
    if (currentScan) {
      try { currentScan.stop(); } catch (e) { /* may already be stopped */ }
      currentScan = null;
    }
    if (scanAbortController) {
      scanAbortController.abort();
      scanAbortController = null;
    }
    if (streamer.isActive()) {
      streamer.stop().catch(() => { /* ignore */ });
    }
    scanBtn.disabled = false;
    saveBtn.disabled = false;
  }

  // ----- Service worker (PWA install path) --------------------------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => { /* ok */ });
    });
  }

  // ----- Auto-connect if creds already saved ------------------------------
  // Convenience: if the user has used the app before, attempt connection on
  // load. Reconnect logic in ws_client.js handles HA being offline; the
  // state pill will sit at "connecting…" / "error" without further action.
  if (haUrlEl.value && haTokenEl.value) {
    ws.connect(haUrlEl.value, haTokenEl.value);
  }
})();
