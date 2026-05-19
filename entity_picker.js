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
    const listEl = opts.listEl;       // <div> for results (we'll render <button>s)
    const statusEl = opts.statusEl;   // <div> for "Loading entities…" etc.
    const onPick = opts.onPick;       // (entry) => void

    let allEntities = [];
    let filtered = [];
    let selected = null;
    // device_id -> device record from HA's device_registry. Used by
    // getBleInfo() to look up an entity's underlying device.
    let devicesById = new Map();

    function setStatus(text, isError) {
      if (!statusEl) return;
      statusEl.textContent = text ?? "";
      statusEl.style.display = text ? "block" : "none";
      statusEl.className = "hint" + (isError ? " error" : "");
    }

    function render() {
      listEl.innerHTML = "";
      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = allEntities.length
          ? "No BLE-trackable entities match your search."
          : "Connect to HA to load entities.";
        listEl.appendChild(empty);
        return;
      }
      const shown = filtered.slice(0, 50); // cap for performance
      shown.forEach((entry) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "entity-row" + (selected?.entity_id === entry.entity_id ? " selected" : "");
        const label = entry.name || entry.original_name || entry.entity_id;
        btn.innerHTML =
          '<div class="entity-name"></div>' +
          '<div class="entity-id"></div>';
        btn.querySelector(".entity-name").textContent = label;
        btn.querySelector(".entity-id").textContent = entry.entity_id;
        btn.addEventListener("click", () => {
          selected = entry;
          render();
          if (onPick) onPick(entry);
        });
        listEl.appendChild(btn);
      });
      if (filtered.length > shown.length) {
        const more = document.createElement("div");
        more.className = "hint";
        more.textContent = `…and ${filtered.length - shown.length} more — refine search to narrow.`;
        listEl.appendChild(more);
      }
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
          allEntities = (list ?? [])
            .filter(isLikelyBleTrackable)
            .sort((a, b) => {
              const an = (a.name || a.original_name || a.entity_id).toLowerCase();
              const bn = (b.name || b.original_name || b.entity_id).toLowerCase();
              return an.localeCompare(bn);
            });
          if (!allEntities.length) {
            setStatus(
              "No BLE-trackable entities found. Add a Bluetooth proxy, "
              + "BTHome device, or iBeacon to get started.",
              true,
            );
          } else {
            setStatus(`${allEntities.length} BLE-trackable entities loaded.`);
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
          applyFilter();
        } catch (e) {
          setStatus("Failed to load entities: " + (e.message ?? e), true);
        }
      },
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
    };
  }

  global.EntityPicker = EntityPicker;
})(window);
