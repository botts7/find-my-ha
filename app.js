// Find My HA Device — main wiring (v0.4).
//
// Controller — owns DOM refs and orchestrates the scanner ↔ ws_client ↔
// streamer ↔ entity_picker modules. Logic lives in those modules; this
// file is glue + step-flow UX + reconnect countdown + haptic feedback.

(function () {
  "use strict";

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
  const entityListEl = $("entity-list");
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
      entityPicker.load(ws);
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

  // ----- Entity picker ----------------------------------------------------
  const entityPicker = new EntityPicker({
    inputEl: entitySearchEl,
    listEl: entityListEl,
    statusEl: entityStatusEl,
    onPick: (entry) => {
      pickedEntity = entry;
      localStorage.setItem("ha_entity_id", entry.entity_id);
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
      updateStepIndicator();
      maybeAutoAdvance();
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
    updateStepIndicator();
    // Auto-scroll to top so the user sees the new panel from the start.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 1 = Setup tab reachable always; 2 reachable when connected; 3 when
  // connected AND entity picked.
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

  // Auto-advance helpers — call when state transitions complete.
  function maybeAutoAdvance() {
    const state = ws.getState();
    const connected = state === "authed" || state === "streaming";
    if (activeTab === 1 && connected) switchTab(2);
    else if (activeTab === 2 && pickedEntity) switchTab(3);
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
  const TREND_WINDOW = 12;
  const EMA_ALPHA = 0.25;
  const MEDIAN_WINDOW = 3;
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
    if (buf.length < 8) return { arrow: "·", label: "settling" };
    // Wider window: average last 4 vs prior 4. Less sensitive to single-
    // sample jitter than the v0.4 2-vs-2 comparison.
    const recent = (buf[buf.length - 1] + buf[buf.length - 2] + buf[buf.length - 3] + buf[buf.length - 4]) / 4;
    const earlier = (buf[buf.length - 5] + buf[buf.length - 6] + buf[buf.length - 7] + buf[buf.length - 8]) / 4;
    const delta = recent - earlier;
    if (delta > 2) return { arrow: "↑", label: "getting closer" };
    if (delta < -2) return { arrow: "↓", label: "getting further" };
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

  stopBtn.addEventListener("click", () => stopScanInternal());

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
    updateRssiDisplay(smoothedRssi, name);
    if (streamer.isActive()) {
      streamer.pushSample(rssi, name);
      dlog("rssi", rssi, name);
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

  // ----- Service worker — v0.4 versioned with cache busting --------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").then((reg) => {
        // Force update check whenever the page loads. The SW itself
        // claims clients on activate so a new version takes effect on
        // the next reload without manual cache clear.
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
