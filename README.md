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

🚧 **MVP skeleton.** Use cases:
- Manual entry of target Bluetooth address → live RSSI display
- HA URL + token pairing
- Forward RSSI to HA Insights' `home_insights/companion_scan_stream` WS endpoint *(planned — currently writes to local log only)*

## Quick start (early-access)

1. Open Chrome on Android (Web Bluetooth not yet supported in iOS Safari)
2. Visit `https://botts7.github.io/find-my-ha/` (deploy planned)
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

- **v0.1** (this commit): single-page skeleton, manual BLE address, local log only
- **v0.2**: HA pairing + WS connection, configurable entity picker
- **v0.3**: HA Insights server-side handler accepting `companion_scan_stream` subscription; card-side "Use phone scanner" toggle
- **v0.4**: Flutter native port (iOS + background scan)
- **v0.5**: Upstream proposal to Companion app team

## Status pages

- Companion-app feature request draft: [HA Insights `docs/drafts/companion_app_ble_active_scan_issue.md`](https://github.com/botts7/ha-insights/blob/main/docs/drafts/companion_app_ble_active_scan_issue.md)
- Memory roadmap notes:
  - `ha_insights_find_my_device_core_donation.md` — HA core service donation path
  - `ha_insights_companion_app_mobile_scanner_request.md` — Companion app feature path

## License

MIT
