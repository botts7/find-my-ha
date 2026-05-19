// wifi_streamer.js — server-pushed Wi-Fi RSSI streaming for v0.7+ Wi-Fi find.
//
// The flip-side of streamer.js. Where streamer.js PUSHES BLE samples from
// Web Bluetooth to the server, this module SUBSCRIBES to a server-side
// stream (home_insights/wifi_find_self) and forwards events to the UI.
//
// Why this exists: browsers can't read Wi-Fi RSSI directly. But UniFi /
// Asuswrt / Omada controllers DO see the phone's RSSI as the user walks,
// and they report it as state.attributes on the phone's device-tracker
// entity. v1.21.0 wifi_find_self subscribes to those state changes and
// streams them down. We just connect to that stream and call onSample
// for each event.
//
// Cadence note: UniFi polls per-client signal every ~30 s by default
// (configurable to ~10 s on UDM). So events arrive much slower than
// BLE's ~1 Hz advertisements. The freshness pill in the UI tells the
// user when the last update arrived so they know it's not frozen.

(function (global) {
  "use strict";

  function WifiStreamer(opts) {
    const wsClient = opts.wsClient;
    const onSample = opts.onSample;        // (event) => void
    const onStateChange = opts.onStateChange; // (s) => void: idle / subscribing / streaming / error / resubscribing
    const onInitialResult = opts.onInitialResult; // (result) => void

    let active = false;
    let subscription = null;  // { result, unsubscribe }
    let entityId = null;
    let targetApDeviceId = null;
    let lastWsState = wsClient.getState();

    // v0.7.0: auto-resubscribe across WS reconnects. Same model as the
    // BLE streamer in streamer.js — if the user is mid-find and the
    // phone briefly drops Wi-Fi to HA, we re-fire the subscribe when
    // the WS comes back so they don't have to tap Stop / Start again.
    wsClient.onStateChange(({ state }) => {
      const wasAuthed = lastWsState === "authed" || lastWsState === "streaming";
      const isAuthed = state === "authed" || state === "streaming";
      lastWsState = state;
      if (active && !subscription && isAuthed && !wasAuthed) {
        _resubscribe();
      }
    });

    function setState(s) {
      if (onStateChange) { try { onStateChange(s); } catch (_) { /* ignore */ } }
    }

    function _maybeEmitInitialAsSample(result) {
      // The wifi_find_self handler's initial result carries the entity's
      // CURRENT readings so the PWA has something to render before the
      // first state change arrives (UniFi's 30 s poll would otherwise
      // leave the UI blank). Feed it into onSample as if it were the
      // first event.
      if (!result || result.rssi_raw === undefined || result.rssi_raw === null) return;
      if (!onSample) return;
      try {
        onSample({
          rssi_raw: result.rssi_raw,
          rssi_smoothed: result.rssi_smoothed,
          ap_device_id: result.ap_device_id ?? null,
          ap_name: result.ap_name ?? result.ap_identifier ?? null,
          ap_identifier: result.ap_identifier ?? null,
          ap_matches_target: !!result.ap_matches_target,
          signal_attribute: result.signal_attribute ?? null,
          timestamp: null,  // initial result is "now" — no server timestamp
          _initial: true,
        });
      } catch (_) { /* ignore */ }
    }

    async function _doSubscribe() {
      const payload = {
        type: "home_insights/wifi_find_self",
        entity_id: entityId,
      };
      if (targetApDeviceId) payload.target_ap_device_id = targetApDeviceId;
      const sub = await wsClient.subscribe(payload, (event) => {
        if (!active) return;
        if (onSample) { try { onSample(event); } catch (_) { /* ignore */ } }
      });
      return sub;
    }

    async function _resubscribe() {
      if (!entityId) return;
      setState("resubscribing");
      try {
        const sub = await _doSubscribe();
        if (!active) {
          // User stopped during reconnect — tear the new sub down.
          try { await sub.unsubscribe(); } catch (_) { /* ignore */ }
          setState("idle");
          return;
        }
        subscription = sub;
        setState("streaming");
        if (onInitialResult) { try { onInitialResult(sub.result); } catch (_) {} }
        _maybeEmitInitialAsSample(sub.result);
      } catch (_) {
        // Reconnect attempt failed — WS will retry; we'll re-fire from
        // the next state-change event. Don't flap the UI to "error".
        setState("resubscribing");
      }
    }

    async function start(phoneEntityId, target) {
      if (active) return;
      entityId = phoneEntityId;
      targetApDeviceId = target || null;
      active = true;
      setState("subscribing");
      try {
        const sub = await _doSubscribe();
        if (!active) {
          // User stopped scan while subscribe was in flight — tear down.
          try { await sub.unsubscribe(); } catch (_) { /* ignore */ }
          setState("idle");
          return;
        }
        subscription = sub;
        wsClient.markStreaming(true);
        setState("streaming");
        if (onInitialResult) { try { onInitialResult(sub.result); } catch (_) {} }
        _maybeEmitInitialAsSample(sub.result);
      } catch (e) {
        active = false;
        setState("error");
        throw e;
      }
    }

    async function stop() {
      if (!active) return;
      active = false;
      setState("idle");
      const sub = subscription;
      subscription = null;
      entityId = null;
      targetApDeviceId = null;
      wsClient.markStreaming(false);
      if (sub) {
        try { await sub.unsubscribe(); } catch (_) { /* ignore */ }
      }
    }

    function isActive() { return active; }

    return { start, stop, isActive };
  }

  global.WifiStreamer = WifiStreamer;
})(window);
