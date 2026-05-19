# `home_insights/companion_scan_stream` — WebSocket protocol

**Shared contract between this PWA and the `ha-insights` integration.**
Defines how the phone (PWA) streams BLE RSSI readings to HA Insights' live-find feature.

---

## Setup

1. **Auth.** Standard HA WS auth: PWA opens `wss://<ha-url>/api/websocket`, completes
   `{"type": "auth", "access_token": "<long-lived>"}`.
2. **Subscribe.** PWA sends a `home_insights/companion_scan_stream` message naming
   the target entity. HA Insights replies with success, opening the stream.
3. **Stream.** PWA sends N RSSI samples as updates. HA Insights threads them into
   the existing BLE live-find machinery (v1.12.0 backend; the same flow that
   stationary proxies feed today).
4. **Unsubscribe.** PWA sends an unsubscribe / closes WS; HA Insights tears down.

---

## Messages

### `companion_scan_subscribe` — open the stream

**PWA → HA:**

```json
{
  "id": 42,
  "type": "home_insights/companion_scan_subscribe",
  "entity_id": "binary_sensor.lost_phone",
  "ble_mac": "AA:BB:CC:11:22:33"
}
```

- `entity_id` (required): the HA entity the user is looking for. Used to scope
  insights + audit attribution.
- `ble_mac` (optional): the BLE MAC the PWA is filtering on. Sent for
  cross-reference with the integration's stationary-proxy data.

**HA → PWA (success):**

```json
{
  "id": 42,
  "type": "result",
  "success": true,
  "result": {
    "subscription_id": "uuid-here",
    "max_sample_rate_hz": 4
  }
}
```

- `subscription_id` correlates subsequent sample messages.
- `max_sample_rate_hz` — server-side rate limit. PWA buffers locally, sends at
  ≤ this rate.

**HA → PWA (error):** standard HA WS error shape.

---

### `companion_scan_sample` — RSSI reading

**PWA → HA (no response expected, fire-and-forget):**

```json
{
  "id": 43,
  "type": "home_insights/companion_scan_sample",
  "subscription_id": "uuid-here",
  "rssi": -67,
  "ts_ms": 1716123456789,
  "device_name": "BC127"
}
```

- `rssi`: integer dBm.
- `ts_ms`: phone-clock unix-ms when the advertisement was seen (HA reconciles
  against its own clock).
- `device_name`: optional, surfaced in the live-find log.

The PWA should send raw samples (not smoothed) — server applies its own EMA so
multiple scanners (phone + stationary proxies) feed the same smoothing.

---

### `companion_scan_unsubscribe` — close the stream

**PWA → HA:**

```json
{
  "id": 44,
  "type": "home_insights/companion_scan_unsubscribe",
  "subscription_id": "uuid-here"
}
```

**HA → PWA (success):** `{"id": 44, "type": "result", "success": true}`

WS close also implicitly unsubscribes.

---

## Server-side behavior

- One PWA subscription per (HA user, entity_id) tuple. Re-subscribing replaces.
- Samples older than 60 seconds (per `ts_ms`) are dropped.
- Sample rate > `max_sample_rate_hz` → server keeps the most-recent-per-window,
  no warning (PWA shouldn't be sending that fast).
- Subscription expires after 10 min of no samples → unsubscribed.

## Privacy

- The phone's BLE MAC + advertised names enter HA Insights' redactor like any
  other entity field.
- `companion_scan_subscribe` calls are audited in the same `outbound_calls`
  table as other LLM/external traffic (mode: `companion-scan`).

## Version

`schema_version: 1`. Forward-incompatible changes bump this; the integration
side validates.
