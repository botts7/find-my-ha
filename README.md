# Find My HA Device

A Progressive Web App (PWA) that turns any phone into a mobile BLE scanner for Home Assistant. Walk around with your phone, watch the trend arrow tell you whether you're getting closer (↑) or further (↓) from a target device. Streams live RSSI back to your HA instance via WebSocket so HA Insights' "Find Device" feature can show real warmer/colder UX instead of room-level localization.

## Why this exists

Home Assistant has scattered identification primitives (`light.flash`, companion "Ring my phone") but **no unified "find any entity" UX with directional feedback**. Stationary Bluetooth proxies tell you "the device is in the kitchen" but not "you're getting warmer." The phone is the obvious mobile scanner, but the HA Companion app doesn't currently do active BLE scanning + streaming.

This PWA fills the gap **today**, without waiting for the Companion app to add the feature. If the workflow catches on, real adoption becomes the argument for upstream contribution.

## Architecture

```
Phone (PWA in Chrome)                Home Assistant
  ┌────────────────────┐              ┌──────────────┐
  │  Web Bluetooth API │   active     │              │
  │  - permission once │   BLE scan   │  HA Insights │
  │  - scan-in-bg WIP  │   ┌──────►   │  integration │
  └────────┬───────────┘              │              │
           │                          │   ┌────────┐ │
           │   live RSSI events       │   │ ble    │ │
           └───────────────────────►  │   │ live   │ │
              WebSocket subscription  │   │ find   │ │
              home_insights/          │   └────────┘ │
                companion_scan_stream │              │
                                      └──────────────┘
```

## Status

🚧 **v0.7.4 — Wi-Fi find graceful sunset on non-controller installs.**
Live at https://botts7.github.io/find-my-ha/. Tab 1 hardcoded
visible; SW network-first for everything; visible version pill; JS
error banner; force-update self-rescue button at the bottom.

Cumulative feature set:
- Manual entry of target Bluetooth name/address → live RSSI display (local-only mode still supported)
- HA URL + token pairing with persistent connection
- Connection-state indicator (disconnected / connecting / authed / streaming / error)
- Auto-reconnect with exponential backoff (2 → 4 → 8 → 16 → 30 s)
- Searchable HA entity picker (loaded from `config/entity_registry/list`)
- Live RSSI streaming to HA Insights via `home_insights/companion_scan_*` messages, server-rate-limited (default 4 Hz)
- Graceful teardown on stop / disconnect
- **v0.3** — pick-entity auto-fills BLE name + MAC from device registry
- **v0.4** — tabs, RSSI noise filtering (median + EMA + hysteretic buckets), staleness detection, theme toggle, reconnect countdown, auto-resubscribe across WS drops
- **v0.4.3** — HOT-zone freeze (honest UX at sub-meter range where physics noise > step delta)
- **v0.5** — walking-verify mode: pick ANY controllable entity, Flash button, area picker, "I'm here ✓" writes `config/entity_registry/update`
- **v0.5.8** — sticky Continue bar, mode-aware search placeholder, Flash style dropdown (Single / Loop), safe 2.5 s inter-toggle interval (avoids every vendor reset/pairing threshold), 60 s auto-stop, vibration feedback
- **v0.5.9** — body padding now respects `env(safe-area-inset-bottom)` on notched iOS so the last entity row isn't covered by the Continue bar; Tab 2 search auto-focuses on entry for instant type-to-filter
- **v0.6.0** — device picker is now a native `<select>` (matches the area picker pattern on Tab 3); on Android Chrome opens the full-screen searchable picker, on iOS opens the wheel modal. Inline scrollable list replaced; search box still filters the underlying option set
- **v0.7.0** — third mode `📶 Wi-Fi`: pick your phone's `device_tracker`, walk through the house, the PWA subscribes to HA Insights `home_insights/wifi_find_self` (ships in v1.21.0) and streams your phone's per-AP RSSI through the same warmer/colder UI as BLE find. Inverse multilateration — the APs measure the phone, not the other way around. Freshness pill shows update cadence (UniFi is ~10-30 s)
- **v0.7.1** — fix Wi-Fi find stuck on "subscribing…" when the picked entity has no RSSI / no AP attribute. Start handler now inspects the initial subscribe result BEFORE swapping surfaces, surfaces "update HA Insights to v1.21.0+" for `unknown_command`, and shows a 45 s no-sample warning with router-polling guidance
- **v0.7.2** — Wi-Fi mode pre-filters the device picker to only entities exposing RSSI + AP attrs via the new `home_insights/wifi_find_capability` batch query (ships in HA Insights v1.21.1). UniFi/Asuswrt/Omada trackers stay; `mobile_app` GPS trackers and Plex/iCloud entries are filtered out. Status line shows "N of M device-trackers expose Wi-Fi RSSI"
- **v0.7.3** — dropdown placeholder distinguishes "connect to HA first" from "no Wi-Fi-trackable devices found" — three empty states now have three distinct messages
- **v0.7.4** — Wi-Fi mode button hides entirely when the install has zero controller-side trackable candidates (paired with HA Insights v1.21.3 controller-platform whitelist that excludes ESPHome/Shelly/Tasmota self-reports). Tooltip explains why the button is hidden when hovered on a development snapshot. New `docs/COMPANION_APP_PROPOSAL.md` describes the upstream Wi-Fi RSSI streaming primitive that would unlock Wi-Fi find for the ~60% of HA installs without a controller integration

## Quick start (early-access)

1. Open Chrome on Android (Web Bluetooth not yet supported in iOS Safari)
2. Visit `https://botts7.github.io/find-my-ha/` (auto-deployed from `main` via `.github/workflows/pages.yml`; needs Pages → Settings source = "GitHub Actions" once)
3. Enter your HA URL + a long-lived access token
4. Search/select an entity to locate
5. Tap "Start scan", grant the BLE permission
6. Walk around — the arrow tells you which direction warms up

## Platform notes

| Platform | Active BLE scan | Status |
|---|---|---|
| Chrome Android | ✅ Web Bluetooth API | Primary target |
| Edge Android | ✅ Web Bluetooth API | Should work |
| Chrome iOS | ❌ no Web Bluetooth | Blocked by Apple's WebKit policy |
| Safari iOS | ❌ no Web Bluetooth | Blocked |
| Firefox | ⚠️ disabled by default | `dom.webcomponents.shadowdom.enabled` flag |

iOS users: install the HA Companion app — once the Companion feature request (https://github.com/botts7/ha-insights/blob/main/docs/drafts/companion_app_ble_active_scan_issue.md) lands, you get the same feature natively.

## Roadmap

- **v0.1 → v0.7.4**: all *shipped*. See Status above + git log for the detailed trail.

### Deferred — v0.6 walking-verify expansion (parked 2026-05-19)

Adding find methods beyond BLE warmer/colder and binary Flash, mirroring HA Insights' capability system. Confirmed user direction; not started.

- **Touch-test mode** for sensors (third mode toggle, alongside BLE find / Identify & verify). Pick a temperature / motion / contact sensor → PWA subscribes via `subscribe_trigger` → modal shows live value → user touches the physical device → value changes → location confirmed.
- **Capability-based filter** — currently domain-whitelisted (light / switch / fan / cover / lock / siren / scene / etc.). Tighten using `entity_registry` + `device_registry` data: query `supported_features` on each entity, filter out those that can't actually be physically identified.
- **HA Insights `home_insights/identify` integration** — when present, use the vendor-aware identify endpoint (ZHA effect / Z-Wave Indicator CC / LIFX flash) instead of generic toggle. Includes the v1.10.13 live-power-consumption gate for critical-load safety. Graceful fallback to `light.toggle` when HA Insights isn't installed.

Reference: HA Insights v1.10.5–v1.10.13 ships all the server-side primitives we'd call into. Memory: `find_my_ha_hardware_topology.md` (scanner-role architecture), `identify_vendor_pairing_thresholds.md` (reset/pairing thresholds we already respect with the 2.5 s loop interval).

### Long-term

- **v0.7**: Companion-app upstream proposal. Lifts the active BLE scan + RSSI streaming into the HA Companion app proper. PWA proves the workflow → Companion native gets iOS support + background scan for free.
- **Flutter native port**: only if Companion-upstream is rejected. iOS + background scan otherwise blocked by Web Bluetooth limitations (see Platform notes).
- **v0.6**: Upstream proposal to Companion app team

## Module layout (v0.2)

```
index.html         — UI shell + section markup
app.js             — controller: wires DOM → ws_client/entity_picker/streamer
ws_client.js       — HA WebSocket: auth, request/response correlation, reconnect
entity_picker.js   — searchable BLE-trackable entity dropdown
streamer.js        — subscribe / rate-limited sample emit / unsubscribe
docs/WS_PROTOCOL.md — shared contract with the ha-insights integration
```

## Verification (v0.2)

1. Save HA URL + long-lived token, tap **Connect**. State pill goes `connecting…` → `connected`.
2. Entity picker populates with BLE-trackable entities. Pick one — green confirmation appears.
3. Tap **Start scan**, grant the BLE permission. State pill flips to `streaming`; the stream-state hint reads "streaming to HA ✓".
4. Server-side log line (in ha-insights) shows the inbound `companion_scan_sample` messages at ≤ `max_sample_rate_hz`.
5. Tap **Stop scan** → unsubscribe is sent, pill returns to `connected`.
6. Pull the HA URL out of reach (airplane mode) → pill flips to `connecting…` and retries with backoff; restoring connectivity resumes within ≤30 s.

## Status pages

- Companion-app feature request draft: [HA Insights `docs/drafts/companion_app_ble_active_scan_issue.md`](https://github.com/botts7/ha-insights/blob/main/docs/drafts/companion_app_ble_active_scan_issue.md)
- Memory roadmap notes:
  - `ha_insights_find_my_device_core_donation.md` — HA core service donation path
  - `ha_insights_companion_app_mobile_scanner_request.md` — Companion app feature path

## License

MIT
