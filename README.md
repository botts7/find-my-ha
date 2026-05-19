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

🚧 **v0.3 — Auto-filter from picked entity.** Pick an entity, the BLE
name prefix + MAC fields auto-populate from HA's device registry
(`config/device_registry/list`), so the local trend arrow tracks one
device instead of averaging across every BLE advertiser in the room.

Cumulative feature set:
- Manual entry of target Bluetooth name/address → live RSSI display (local-only mode still supported)
- HA URL + token pairing with persistent connection
- Connection-state indicator (disconnected / connecting / authed / streaming / error)
- Auto-reconnect with exponential backoff (2 → 4 → 8 → 16 → 30 s)
- Searchable HA entity picker (loaded from `config/entity_registry/list`)
- Live RSSI streaming to HA Insights via `home_insights/companion_scan_*` messages, server-rate-limited (default 4 Hz)
- Graceful teardown on stop / disconnect
- **v0.3:** pick-entity → BLE name + MAC auto-filled from device registry; "Auto-detected" hint shows what was matched; honest "no Bluetooth info on file" fallback when the entity has no BT connection in HA

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

- **v0.1**: single-page skeleton, manual BLE address, local log only — *shipped*
- **v0.2**: HA pairing + WS connection, entity picker, live RSSI streaming — *shipped*
- **v0.3** (this commit): pick-entity auto-fills BLE name + MAC from device registry
- **v0.4**: HA Insights server-side handler accepting `companion_scan_stream` subscription; card-side "Use phone scanner" toggle
- **v0.5**: Flutter native port (iOS + background scan)
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
