// Find My HA Device — MVP scanner
// Phase 1: local BLE scan + RSSI display. HA WebSocket streaming
// lands in Phase 2 once we've validated the scanner half works.
//
// Web Bluetooth API constraints:
//   - Only available in Chrome/Edge on Android (Apple's WebKit doesn't
//     expose it on iOS)
//   - requestLEScan() is behind a flag in Chrome stable; the user has
//     to enable chrome://flags/#enable-experimental-web-platform-features
//     OR we use requestDevice() as a fallback (one-shot but well-supported)
//   - Background scanning is not permitted from a tab. PWA installed as
//     a standalone app + the "Bluetooth" permission policy is the closest
//     thing to background scanning available today.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const haUrlEl = $("ha-url");
  const haTokenEl = $("ha-token");
  const saveBtn = $("save-creds-btn");
  const bleNameEl = $("ble-name");
  const scanBtn = $("scan-btn");
  const stopBtn = $("stop-btn");
  const rssiSection = $("rssi-section");
  const rssiValue = $("rssi-value");
  const rssiBucket = $("rssi-bucket");
  const rssiTrend = $("rssi-trend");
  const rssiMeta = $("rssi-meta");
  const scanError = $("scan-error");

  // Restore saved creds on load.
  haUrlEl.value = localStorage.getItem("ha_url") ?? "";
  haTokenEl.value = localStorage.getItem("ha_token") ?? "";

  saveBtn.addEventListener("click", () => {
    localStorage.setItem("ha_url", haUrlEl.value.trim());
    localStorage.setItem("ha_token", haTokenEl.value.trim());
    saveBtn.textContent = "Saved ✓";
    setTimeout(() => (saveBtn.textContent = "Save credentials (local only)"), 1500);
  });

  // Trend buffer: keep last N RSSI smoothed values; compare recent vs older
  // half to derive direction arrow. EMA smoothing avoids per-advertisement
  // jitter dominating the verdict.
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

  // Active scanning state.
  let currentScan = null;          // BluetoothLEScan handle
  let scanAbortController = null;  // for event listener teardown

  scanBtn.addEventListener("click", async () => {
    clearError();
    if (!navigator.bluetooth) {
      showError(
        "Web Bluetooth not supported. Use Chrome or Edge on Android.",
      );
      return;
    }
    if (!navigator.bluetooth.requestLEScan) {
      // Fallback: requestDevice() works but is one-shot and shows a
      // picker dialog rather than a continuous stream. Chrome stable
      // hides requestLEScan() behind chrome://flags/#enable-experimental-
      // web-platform-features. Surface a clear message before falling
      // back.
      showError(
        "Active LE scan not available in this browser. Enable the flag "
        + "chrome://flags/#enable-experimental-web-platform-features, "
        + "then restart Chrome and try again.",
      );
      return;
    }

    try {
      rssiSection.style.display = "block";
      trendBuffer.length = 0;
      smoothedRssi = null;
      updateRssiDisplay(null);

      // Filter by name if user provided one, otherwise accept all
      // advertisements. acceptAllAdvertisements is required when no
      // filter is set — Chrome will reject otherwise.
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
    } catch (err) {
      showError(`Scan failed: ${err.message ?? err}`);
      stopScanInternal();
    }
  });

  stopBtn.addEventListener("click", () => {
    stopScanInternal();
  });

  function handleAdvertisement(event) {
    // event.device.name, event.rssi, event.uuids, event.manufacturerData…
    // For Phase 1 we just display the LATEST observed RSSI. Phase 2
    // will forward to HA WebSocket.
    const rssi = event.rssi;
    const name = event.device?.name ?? null;
    const targetName = bleNameEl.value.trim().toLowerCase();
    if (targetName && (!name || !name.toLowerCase().includes(targetName))) {
      return; // not our target
    }
    pushRssi(rssi);
    updateRssiDisplay(smoothedRssi, name);
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
    scanBtn.disabled = false;
    saveBtn.disabled = false;
  }

  // Register service worker if available — enables installable PWA.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => { /* ok */ });
    });
  }
})();
