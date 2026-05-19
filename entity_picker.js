// entity_picker.js — searchable BLE-trackable entity dropdown for Find My HA.
//
// Fetches HA's entity registry over WS, filters to entities likely to be BLE
// trackable, and renders a searchable picker. Plain DOM, no framework.
//
// "BLE trackable" heuristic (intentionally permissive — server side validates):
//   - domain === "device_tracker", OR
//   - domain === "binary_sensor" AND original_name / unique_id / platform hints
//     at bluetooth, iBeacon, BTHome, or similar
//
// The HA entity_registry response doesn't include current attributes, only
// registry metadata (entity_id, platform, original_name, device_id, etc.).
// So we filter on platform + entity_id keyword for v0.2; v0.3 can enrich
// with state attrs once the server side exposes them.

(function (global) {
  "use strict";

  // HA's device_registry connection types we treat as Bluetooth-bearing.
  // "bluetooth" is the canonical one (BTHome, private_ble_device, etc.).
  // "mac" can also appear for devices that don't distinguish — we only
  // accept those when the integration is BLE-related.
  const BT_CONNECTION_TYPES = new Set(["bluetooth"]);

  const BLE_PLATFORM_HINTS = [
    "bluetooth",
    "bluetooth_le_tracker",
    "bluetooth_tracker",
    "ibeacon",
    "bthome",
    "esphome", // many ble proxies expose presence as binary_sensor via esphome
    "private_ble_device",
    "mobile_app", // companion-app device_tracker, sometimes BLE-sourced
  ];

  const BLE_ID_KEYWORDS = ["ble", "bluetooth", "beacon", "ibeacon", "bthome"];

  // v0.5: domains that can be physically identified by toggling state.
  // Light/switch/fan are obvious. Cover (blinds) opens/closes visibly.
  // Lock has a click. Siren makes noise. media_player has play/pause.
  // Scenes/scripts/automations can be activated; they may visibly fire.
  const IDENTIFIABLE_DOMAINS = new Set([
    "light", "switch", "fan", "cover", "lock", "siren",
    "media_player", "scene", "script", "automation",
    "input_boolean", "humidifier", "valve", "vacuum",
    "remote", "climate",
  ]);

  function isLikelyBleTrackable(entry) {
    const eid = entry.entity_id ?? "";
    const domain = eid.split(".")[0];
    if (domain === "device_tracker") return true;
    if (domain === "binary_sensor") {
      const plat = (entry.platform ?? "").toLowerCase();
      if (BLE_PLATFORM_HINTS.includes(plat)) return true;
      const hay = (eid + " " + (entry.original_name ?? "")).toLowerCase();
      if (BLE_ID_KEYWORDS.some((k) => hay.includes(k))) return true;
    }
    if (domain === "sensor") {
      // RSSI sensors are often binary_sensor's companions; surface if BLE-hinted.
      const hay = (eid + " " + (entry.original_name ?? "")).toLowerCase();
      if (hay.includes("rssi") && BLE_ID_KEYWORDS.some((k) => hay.includes(k))) {
        return true;
      }
    }
    return false;
  }

  function isIdentifiable(entry) {
    const eid = entry.entity_id ?? "";
    const domain = eid.split(".")[0];
    return IDENTIFIABLE_DOMAINS.has(domain);
  }

  // Look up a device's Bluetooth MAC + a sensible short name to use as a
  // BLE namePrefix filter. Returns null when the device has no BLE
  // connection on record — that's the signal to the UI that auto-filter
  // isn't possible for this entity.
  function bleInfoFromDevice(device) {
    if (!device) return null;
    const connections = device.connections ?? [];
    let mac = null;
    for (const c of connections) {
      // connections is shaped [[type, value], ...]. BT MACs come as
      // ["bluetooth", "AA:BB:CC:..."].
      if (Array.isArray(c) && c.length >= 2 && BT_CONNECTION_TYPES.has(c[0])) {
        mac = String(c[1]).toUpperCase();
        break;
      }
    }
    const displayName = device.name_by_user || device.name || "";
    // First space-separated word is usually the best namePrefix match:
    // "Hue White lamp 1" → "Hue", "ESPHome bedroom beacon" → "ESPHome",
    // "AirTag - Keys" → "AirTag". The user can hand-edit if the actual
    // BLE advertisement uses a different prefix.
    const namePrefix = displayName.split(/[\s\-_]+/)[0] || "";
    if (!mac && !namePrefix) return null;
    return {
      bluetooth_mac: mac,
      device_name: displayName,
      suggested_name_prefix: namePrefix,
      manufacturer: device.manufacturer || null,
      model: device.model || null,
    };
  }

  function EntityPicker(opts) {
    const inputEl = opts.inputEl;     // <input type="text"> (search box)
    const selectEl = opts.selectEl;   // <select> — v0.6.0: native modal picker
    const statusEl = opts.statusEl;   // <div> for "Loading entities…" etc.
    const onPick = opts.onPick;       // (entry) => void

    // v0.6.0: legacy `listEl` alias for any external caller still
    // passing the old div-based picker. Drop the alias once the PWA
    // is fully on the native-select path.
    if (!selectEl && opts.listEl && opts.listEl.tagName === "SELECT") {
      opts.selectEl = opts.listEl;
    }

    let allEntities = [];      // full registry list (filtered to BLE OR identifiable)
    let filtered = [];
    let selected = null;
    // v0.7.2: per-entity Wi-Fi trackability map populated by the host
    // via setWifiCapabilities() after it calls home_insights/wifi_find_capability.
    // When non-null, wifi-mode filtering narrows to only is_trackable=true
    // entities. When null (HA Insights pre-v1.21.1, or query failed),
    // we fall back to showing every device_tracker.
    let wifiCapabilities = null;
    // v0.5: mode toggle — "ble" (default) shows BLE-trackable entities for
    // warmer/colder; "identify" shows controllable entities for the
    // flash-and-verify workflow.
    let mode = "ble";
    // device_id -> device record from HA's device_registry. Used by
    // getBleInfo() to look up an entity's underlying device.
    let devicesById = new Map();
    // Full registry pulled once; applyMode re-filters in-place.
    let rawEntities = [];

    function applyMode() {
      let predicate;
      if (mode === "identify") {
        predicate = isIdentifiable;
      } else if (mode === "wifi") {
        // v0.7.0: Wi-Fi find — entity IS the user's phone tracker.
        // v0.7.2: when wifi_find_capability batch data is available,
        // narrow to is_trackable=true entries. Otherwise (pre-v1.21.1
        // backend, or query failed), fall back to all device_trackers
        // so the user can still try.
        predicate = (e) => {
          const eid = e.entity_id ?? "";
          if (!eid.startsWith("device_tracker.")) return false;
          if (wifiCapabilities) {
            const cap = wifiCapabilities.get(eid);
            return cap?.is_trackable === true;
          }
          return true;
        };
      } else {
        predicate = isLikelyBleTrackable;
      }
      allEntities = rawEntities
        .filter(predicate)
        .sort((a, b) => {
          const an = (a.name || a.original_name || a.entity_id).toLowerCase();
          const bn = (b.name || b.original_name || b.entity_id).toLowerCase();
          return an.localeCompare(bn);
        });
      applyFilter();
    }

    function setStatus(text, isError) {
      if (!statusEl) return;
      statusEl.textContent = text ?? "";
      statusEl.style.display = text ? "block" : "none";
      statusEl.className = "hint" + (isError ? " error" : "");
    }

    // v0.6.0: render into a native <select>. On mobile this opens
    // as the OS native picker (Android full-screen list with search,
    // iOS wheel). On desktop it's the standard dropdown. Mirrors the
    // area picker pattern used on Tab 3.
    function render() {
      if (!selectEl) return;
      // Preserve current value across rebuilds when the user is
      // mid-search; otherwise the option flicker forces a re-pick.
      const currentValue = selected?.entity_id || "";
      // Clear + add placeholder.
      selectEl.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = filtered.length
        ? `— pick a device (${filtered.length}) —`
        : allEntities.length
          ? "— no matches; clear search —"
          : "— connect to HA first —";
      selectEl.appendChild(placeholder);
      // Cap rendered options so a 3000-entity install doesn't drop a
      // huge DOM tree under iOS's wheel picker. 200 covers any
      // realistic post-filter set.
      const RENDER_CAP = 200;
      const shown = filtered.slice(0, RENDER_CAP);
      shown.forEach((entry) => {
        const opt = document.createElement("option");
        opt.value = entry.entity_id;
        const friendly = entry.name || entry.original_name || entry.entity_id;
        // Native pickers show option.textContent as one line. Compose
        // friendly + entity_id with a separator so both are visible.
        opt.textContent =
          friendly === entry.entity_id
            ? entry.entity_id
            : `${friendly}  ·  ${entry.entity_id}`;
        if (entry.entity_id === currentValue) opt.selected = true;
        selectEl.appendChild(opt);
      });
      if (filtered.length > RENDER_CAP) {
        const more = document.createElement("option");
        more.value = "";
        more.disabled = true;
        more.textContent =
          `…and ${filtered.length - RENDER_CAP} more — refine search to narrow`;
        selectEl.appendChild(more);
      }
      selectEl.disabled = !allEntities.length;
    }

    function applyFilter() {
      const q = (inputEl.value ?? "").trim().toLowerCase();
      if (!q) {
        filtered = allEntities;
      } else {
        filtered = allEntities.filter((e) => {
          const hay = (
            e.entity_id + " " +
            (e.name ?? "") + " " +
            (e.original_name ?? "") + " " +
            (e.platform ?? "")
          ).toLowerCase();
          return hay.includes(q);
        });
      }
      render();
    }

    inputEl.addEventListener("input", applyFilter);

    // v0.6.0: native select change → pick.
    if (selectEl) {
      selectEl.addEventListener("change", () => {
        const v = selectEl.value;
        if (!v) return;
        const entry = allEntities.find((e) => e.entity_id === v);
        if (entry) {
          selected = entry;
          if (onPick) onPick(entry);
        }
      });
    }

    // Public API.
    return {
      async load(wsClient) {
        setStatus("Loading entities…");
        try {
          // Pull entity + device registries in parallel. Device registry
          // is best-effort — if it fails, picker still works without
          // auto-filter info.
          const [list, deviceList] = await Promise.all([
            wsClient.request({ type: "config/entity_registry/list" }),
            wsClient
              .request({ type: "config/device_registry/list" })
              .catch(() => []),
          ]);
          devicesById = new Map(
            (deviceList ?? []).map((d) => [d.id, d]),
          );
          rawEntities = list ?? [];
          applyMode();
          if (!allEntities.length) {
            setStatus(
              mode === "identify"
                ? "No identifiable entities found in your HA instance."
                : mode === "wifi"
                  ? "No device_tracker entities. UniFi / Asuswrt / "
                    + "Omada integrations expose your phone as a "
                    + "device_tracker — install one to enable Wi-Fi find."
                  : "No BLE-trackable entities. Add a Bluetooth proxy, "
                    + "BTHome device, or iBeacon to enable BLE find — or "
                    + "switch to Identify mode to walk-verify other entities.",
              true,
            );
          } else {
            const label =
              mode === "identify"
                ? "identifiable"
                : mode === "wifi"
                  ? "device-tracker"
                  : "BLE-trackable";
            setStatus(`${allEntities.length} ${label} entities loaded.`);
          }
          // Restore previous selection if it still exists.
          const lastId = localStorage.getItem("ha_entity_id");
          if (lastId) {
            const prior = allEntities.find((e) => e.entity_id === lastId);
            if (prior) {
              selected = prior;
              if (onPick) onPick(prior);
            }
          }
        } catch (e) {
          setStatus("Failed to load entities: " + (e.message ?? e), true);
        }
      },
      setMode(newMode) {
        if (newMode !== "ble" && newMode !== "identify" && newMode !== "wifi") return;
        if (mode === newMode) return;
        mode = newMode;
        selected = null;
        // Switching AWAY from wifi clears the cap data; the host
        // re-fetches when switching back. Keeps caches fresh and
        // avoids stale is_trackable flags after device state changes.
        if (newMode !== "wifi") wifiCapabilities = null;
        if (rawEntities.length) {
          applyMode();
          const label =
            mode === "identify"
              ? "identifiable"
              : mode === "wifi"
                ? wifiCapabilities ? "Wi-Fi-trackable" : "device-tracker"
                : "BLE-trackable";
          setStatus(`${allEntities.length} ${label} entities.`);
        }
      },
      // v0.7.2: ingest the batch wifi_find_capability response.
      // `caps` is a {entity_id: {is_trackable, reason, ...}} dict.
      // Re-runs the filter so the picker narrows in place.
      setWifiCapabilities(caps) {
        if (!caps) {
          wifiCapabilities = null;
        } else {
          wifiCapabilities = new Map(Object.entries(caps));
        }
        if (mode === "wifi") {
          applyMode();
          if (wifiCapabilities) {
            const trackable = allEntities.length;
            const total = rawEntities.filter(
              (e) => (e.entity_id ?? "").startsWith("device_tracker."),
            ).length;
            setStatus(
              `${trackable} of ${total} device-trackers expose Wi-Fi RSSI.`,
            );
          }
        }
      },
      getMode() { return mode; },
      clear() {
        allEntities = [];
        filtered = [];
        selected = null;
        devicesById = new Map();
        setStatus("");
        render();
      },
      getSelected() { return selected; },
      // Resolve an entity registry entry to its device's BLE info
      // (MAC + name + suggested namePrefix). Returns null when the
      // device registry isn't loaded, the entity has no device, or the
      // device has no Bluetooth connection on record.
      getBleInfo(entry) {
        if (!entry || !entry.device_id) return null;
        return bleInfoFromDevice(devicesById.get(entry.device_id));
      },
      // True when the entity has Bluetooth info in the device registry
      // (i.e. eligible for warmer/colder). Distinct from the broader
      // BLE_TRACKABLE filter that just guesses from entity_id / platform.
      isBleTrackable(entry) {
        return this.getBleInfo(entry) !== null;
      },
    };
  }

  global.EntityPicker = EntityPicker;
})(window);
