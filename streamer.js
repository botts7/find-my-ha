// streamer.js — rate-limited RSSI sample streamer.
//
// Owns the subscribe/sample/unsubscribe lifecycle defined in
// docs/WS_PROTOCOL.md. Buffers raw samples and emits at the server's
// max_sample_rate_hz cap. If the server hasn't returned a subscription
// confirmation yet, samples are buffered without being sent (and the
// most-recent-per-window strategy is applied so we never spew a backlog).
//
// Design choices:
//   - Per WS_PROTOCOL.md: "PWA should send raw samples (not smoothed)".
//     Server applies EMA. We pass raw event.rssi straight through.
//   - We don't ack samples. They're fire-and-forget.
//   - On unsubscribe we await the result so the server can clean up before
//     we drop the subscription_id; teardown is fast (<100ms typical).

(function (global) {
  "use strict";

  function Streamer(opts) {
    const wsClient = opts.wsClient;     // HaWsClient instance
    const onStateChange = opts.onStateChange; // (s) => void: idle / subscribing / streaming / error

    let subscriptionId = null;
    let maxRateHz = 4;              // server tells us; default per spec
    let pending = null;             // most-recent buffered sample {rssi, ts_ms, device_name}
    let emitTimer = null;
    let entityId = null;
    let bleMac = null;
    let streamingActive = false;    // local state separate from ws state

    function setState(s) {
      if (onStateChange) {
        try { onStateChange(s); } catch (_) { /* ignore */ }
      }
    }

    function intervalMs() {
      return Math.max(50, Math.floor(1000 / Math.max(1, maxRateHz)));
    }

    function startEmitLoop() {
      stopEmitLoop();
      // setInterval rather than recursive setTimeout so the cadence is stable
      // even if the page is briefly throttled (browsers will batch calls but
      // not duplicate them).
      emitTimer = setInterval(() => {
        if (!pending || !subscriptionId) return;
        const sample = pending;
        pending = null;
        wsClient.send({
          type: "home_insights/companion_scan_sample",
          subscription_id: subscriptionId,
          rssi: sample.rssi,
          ts_ms: sample.ts_ms,
          device_name: sample.device_name ?? null,
        });
      }, intervalMs());
    }

    function stopEmitLoop() {
      if (emitTimer) {
        clearInterval(emitTimer);
        emitTimer = null;
      }
    }

    async function start(entity, mac) {
      entityId = entity;
      bleMac = mac ?? null;
      streamingActive = true;
      setState("subscribing");
      try {
        const payload = {
          type: "home_insights/companion_scan_subscribe",
          entity_id: entityId,
        };
        if (bleMac) payload.ble_mac = bleMac;
        const result = await wsClient.request(payload);
        if (!streamingActive) {
          // User stopped scan while subscribe was in flight — tear down.
          if (result?.subscription_id) {
            wsClient.send({
              type: "home_insights/companion_scan_unsubscribe",
              subscription_id: result.subscription_id,
            });
          }
          setState("idle");
          return;
        }
        subscriptionId = result?.subscription_id ?? null;
        if (typeof result?.max_sample_rate_hz === "number" && result.max_sample_rate_hz > 0) {
          maxRateHz = result.max_sample_rate_hz;
        }
        if (!subscriptionId) {
          setState("error");
          streamingActive = false;
          return;
        }
        wsClient.markStreaming(true);
        setState("streaming");
        startEmitLoop();
      } catch (e) {
        streamingActive = false;
        setState("error");
        // Surface for the caller via wsClient.getLastError? They get the
        // state change; specific message comes through onStateChange's caller.
        throw e;
      }
    }

    async function stop() {
      streamingActive = false;
      stopEmitLoop();
      pending = null;
      const subId = subscriptionId;
      subscriptionId = null;
      wsClient.markStreaming(false);
      setState("idle");
      if (subId) {
        try {
          await wsClient.request({
            type: "home_insights/companion_scan_unsubscribe",
            subscription_id: subId,
          });
        } catch (_) {
          // Unsubscribe failure isn't user-visible — WS close also implicitly
          // unsubscribes per spec, so worst case the server reaps in 10 min.
        }
      }
    }

    function pushSample(rssi, deviceName) {
      if (!streamingActive || !subscriptionId) return;
      // Most-recent-per-window: just overwrite. Server doesn't want backlog.
      pending = {
        rssi: rssi,
        ts_ms: Date.now(),
        device_name: deviceName ?? null,
      };
    }

    function isActive() { return streamingActive; }

    return { start, stop, pushSample, isActive };
  }

  global.Streamer = Streamer;
})(window);
