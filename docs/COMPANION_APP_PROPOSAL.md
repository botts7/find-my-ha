# Companion app: walking warmer/colder for non-BLE devices

> **Status**: reference architecture for a proposed Home Assistant
> Companion app feature. The PWA + HA Insights integration prove the
> contract end-to-end; the Companion app needs to fill one missing
> primitive to unlock walking-find for Wi-Fi devices on every install.

## TL;DR

- The find-my-ha PWA already does walking warmer/colder for **BLE**
  devices today, via Web Bluetooth.
- HA Insights v1.21.x adds a server-side primitive for **Wi-Fi**
  devices on installs with controller integrations (UniFi, Omada,
  Asuswrt-Merlin, Mikrotik, etc.).
- For the other ~60% of HA installs, the missing piece is a
  **device-side Wi-Fi RSSI streamer in the Companion app**.
- This document describes the contract + how the Companion app
  would slot in.

## Why this exists

Home Assistant has primitives for **identifying** a device
(`light.flash`, "ring my phone"), but no built-in
**walking warmer/colder** UX for arbitrary entities. The PWA +
HA Insights stack proves the architecture; the Companion app is
the natural device-side scanner for the Wi-Fi half of the problem.

Today:

| Device class | Walking find today? | How |
|---|---|---|
| BLE (Hue, AirTag, BTHome, BLE locks) | ✅ | PWA via Web Bluetooth |
| Wi-Fi on UniFi / Omada / Asuswrt-Merlin install | ✅ | HA Insights v1.21.x reads per-client signal sensor |
| Wi-Fi on stock-firmware router install | ❌ | No source of per-client RSSI |
| Zigbee / Z-Wave | ❌ | Stationary mesh nodes, no RSSI delta |

The 3rd row is what this proposal fixes.

## The flip

Naïve approach: phone reads target device's Wi-Fi signal. Doesn't
work — browsers + iOS apps can't scan arbitrary Wi-Fi devices;
Android can but only via background-scan APIs that throttle to
4 scans per 2 minutes (Android 9+).

Inverse approach (what HA Insights v1.21.x already does):
- User walks with phone in hand
- Phone's Wi-Fi radio reads the **AP's** signal continuously
  (this is how phones decide which AP to roam to)
- Companion app exposes that reading as a Home Assistant sensor
- HA Insights subscribes to state changes on that sensor
- As user walks closer to AP, sensor value increases
- Knowing which AP is near which target device (from
  v1.18 `WifiFindDetector` area inference), warmer/colder works

## The missing primitive

The HA Android Companion app **already** has an auto-sensor called
**WiFi Signal Strength**. Two problems with today's implementation:

### Problem 1: cadence

The sensor updates at the default auto-sensor interval (~minutes,
adjustable to ~15 s minimum on most versions). Walking find needs
1–2 Hz to feel responsive. UniFi controllers already feel sluggish
at their 10–30 s cadence; a per-minute sensor is unusable.

**Ask**: while a find session is active in HA Insights, the
Companion app should poll its own `WifiInfo.getRssi()` at 1–2 Hz
and push the value through the existing sensor channel.

### Problem 2: no BSSID

The v1.18 detector cross-references signal to area_id via the
AP's MAC address. Android knows the BSSID
(`WifiInfo.getBSSID()`), but doesn't expose it as a sensor today.

**Ask**: add a **WiFi BSSID** sensor that reports the MAC of the
currently-associated AP. Updates whenever it changes (roaming).

## Contract — what HA already accepts

The HA Insights WS handler `home_insights/wifi_find_self` is shipped
and stable from v1.21.0 onward. It subscribes to **any** entity
state change on the picked device and forwards smoothed RSSI to
the WS client:

```
PWA → HA:  { "type": "home_insights/wifi_find_self",
             "entity_id": "device_tracker.alice_phone" }

HA → PWA:  { "type": "result",
             "result": { "subscribed": true,
                         "is_trackable": true,
                         "rssi_raw": -55,
                         "rssi_smoothed": -55.0,
                         "ap_identifier": "aa:bb:cc:dd:ee:01",
                         "ap_name": "UniFi AP Kitchen",
                         "ap_matches_target": true } }

HA → PWA:  { "type": "event",
             "event": { "rssi_raw": -54,
                        "rssi_smoothed": -54.3,
                        "ap_identifier": "...",
                        "ap_matches_target": true,
                        "timestamp": "2026-05-20T19:42:18Z" } }
... (one per sensor state change, EMA-smoothed server-side) ...
```

The PWA already renders this stream as warmer/colder. The
Companion app's only job is **populate the sensor entity that
feeds it** at the right cadence.

## Reference implementation

| Component | Repo | File |
|---|---|---|
| WS handler | botts7/ha-insights | `custom_components/ha_insights/ws_api/wifi_find_self.py` |
| Capability lib | botts7/ha-insights | `custom_components/ha_insights/lib/wifi_find_capability.py` |
| Sister-entity merge | botts7/ha-insights | `_collect_device_state_attrs` in wifi_find_self.py |
| Detector (passive area inference) | botts7/ha-insights | `custom_components/ha_insights/detectors/wifi_find.py` |
| PWA streamer | botts7/find-my-ha | `wifi_streamer.js` |
| PWA mode wiring | botts7/find-my-ha | `app.js` (search for "wifi_find_self") |

The HA Insights side is **complete**. No further server-side work
is needed for the Companion app to slot in.

## Battery considerations

Running Wi-Fi scans at 1–2 Hz drains battery faster than the
default auto-sensor interval. Mitigations:

1. **Foreground-only**: only poll while the Companion app is in
   the foreground AND a find session is active. Background falls
   back to the existing slow auto-sensor cadence.
2. **Time-bounded session**: HA Insights' find session has a
   built-in timeout (60 s default in the PWA). Companion only
   needs to poll during that window.
3. **Optional**: hold a partial wake lock during the session so
   the screen-off-mid-walk case doesn't drop the poll rate.

Estimated cost: roughly equivalent to "background music streaming"
for the duration of the session. Users have already opted-in to
the find action.

## Privacy

The Companion app is already trusted with the user's location
and connected-network data. The proposed sensors expose less
information than `device_tracker.<phone>` already does:
- WiFi RSSI: nominally identifies which AP the phone is near.
  The user's HA already knows which APs they own; no new info.
- WiFi BSSID: same as above. Phone is on the user's network;
  the BSSID isn't secret to anyone who can see the phone's
  packets.

## Filing path

This document is the architectural reference for the upstream
feature request. Companion-app maintainers should be able to read
this + the linked source files + decide whether to:

1. Accept the proposal and we draft the Android Java/Kotlin PR.
2. Counter-propose a different shape (we adapt the HA Insights
   handler — already abstracted behind `wifi_find_capability_for`).
3. Decline, in which case Wi-Fi find remains UniFi/Omada-only.

The upstream issue draft lives at:
https://github.com/botts7/ha-insights/blob/main/docs/drafts/companion_app_wifi_rssi_streaming.md

## See also

- **BLE active scan sibling proposal**: same architectural pattern
  for BLE. `find-my-ha` PWA already streams BLE samples to HA via
  `companion_scan_*` messages; the Companion app could replace
  the PWA's role on iOS (Web Bluetooth is iOS-blocked).
- **HA Insights detector roadmap**: `WifiFindDetector` (v1.18),
  `ZigbeeFindDetector` (v1.19, planned), `ZWaveFindDetector`
  (v1.20, planned). Each adds a passive location-inference layer
  on top of the same architecture.
