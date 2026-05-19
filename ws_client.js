// ws_client.js — Home Assistant WebSocket client for Find My HA Device.
//
// Responsibilities:
//   - Open wss://<ha-url>/api/websocket
//   - Walk the HA auth handshake (auth_required → auth → auth_ok | auth_invalid)
//   - Track connection state and notify listeners (disconnected / connecting /
//     authed / streaming / error)
//   - Auto-reconnect with exponential backoff (2s → 4s → 8s → 16s → 30s cap)
//   - Provide request/response correlation via auto-incrementing message ids
//   - Provide a fire-and-forget send() for stream samples
//   - Expose explicit disconnect() that suppresses reconnect (user intent)
//
// HA WS reference: https://developers.home-assistant.io/docs/api/websocket
//
// Deliberately kept dependency-free — vanilla browser WebSocket API.

(function (global) {
  "use strict";

  const STATES = Object.freeze({
    DISCONNECTED: "disconnected",
    CONNECTING: "connecting",
    AUTHENTICATING: "authenticating",
    AUTHED: "authed",
    STREAMING: "streaming",
    ERROR: "error",
  });

  const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

  function deriveWsUrl(haUrl) {
    // Accepts "https://homeassistant.local:8123" or "http://192.168.x.x:8123"
    // or even "homeassistant.local:8123". Always lands at <scheme>://<host>/api/websocket.
    let u = (haUrl ?? "").trim();
    if (!u) throw new Error("HA URL is empty");
    if (!/^https?:\/\//i.test(u) && !/^wss?:\/\//i.test(u)) {
      // Default to https — HA's recommended setup.
      u = "https://" + u;
    }
    // Strip trailing slash to keep concatenation predictable.
    u = u.replace(/\/+$/, "");
    // http → ws, https → wss.
    u = u.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    return u + "/api/websocket";
  }

  function HaWsClient() {
    let ws = null;
    let state = STATES.DISCONNECTED;
    let userClosed = false;
    let backoffIndex = 0;
    let reconnectTimer = null;
    // v0.4: surface countdown so the UI can show "reconnecting in Xs" +
    // a "Retry now" button instead of just an infinite "connecting…".
    let reconnectScheduledAt = null;  // epoch ms when the timer was set
    let reconnectDelayMs = 0;
    let reconnectAttempt = 0;         // 1-indexed; 0 = no retry pending
    let nextId = 1;
    let pending = new Map(); // id -> { resolve, reject }
    let haUrl = "";
    let token = "";
    let listeners = new Set();
    let messageListeners = new Set(); // raw inbound after auth
    let lastError = null;

    function setState(next, errMsg) {
      if (next === state && !errMsg) return;
      state = next;
      lastError = errMsg ?? null;
      const snapshot = { state, error: lastError };
      listeners.forEach((cb) => {
        try { cb(snapshot); } catch (_) { /* listener errors are theirs */ }
      });
    }

    function onStateChange(cb) {
      listeners.add(cb);
      // v0.5.3: defer initial fire to a microtask. Subscribers
      // registered during their host's IIFE init can reference `let`-
      // declared symbols below the registration point — firing
      // synchronously here would hit a temporal-dead-zone
      // ReferenceError and crash the entire IIFE. Microtask runs after
      // current sync frame, by which point all declarations are
      // initialised. Net effect on real-world use is identical:
      // subscribers still get the initial state before any user
      // interaction.
      Promise.resolve().then(() => {
        if (!listeners.has(cb)) return;  // unsubscribed during the gap
        try { cb({ state, error: lastError }); } catch (_) { /* ignore */ }
      });
      return () => listeners.delete(cb);
    }

    function onMessage(cb) {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    }

    function connect(url, accessToken) {
      // Caller may pass new creds (Save → Connect); store them so reconnect
      // uses the current values.
      if (url !== undefined) haUrl = url;
      if (accessToken !== undefined) token = accessToken;
      userClosed = false;
      clearReconnect();
      openSocket();
    }

    function openSocket() {
      if (ws) {
        try { ws.close(); } catch (_) { /* ignore */ }
        ws = null;
      }
      let wsUrl;
      try {
        wsUrl = deriveWsUrl(haUrl);
      } catch (e) {
        setState(STATES.ERROR, e.message);
        return;
      }
      setState(STATES.CONNECTING);
      let socket;
      try {
        socket = new WebSocket(wsUrl);
      } catch (e) {
        setState(STATES.ERROR, "Bad WS URL: " + (e.message ?? e));
        scheduleReconnect();
        return;
      }
      ws = socket;

      socket.addEventListener("open", () => {
        // HA sends auth_required first; we wait for it. Nothing to do on open.
      });

      socket.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        handleInbound(msg);
      });

      socket.addEventListener("close", () => {
        ws = null;
        // Fail any outstanding promises so callers don't hang forever.
        pending.forEach((p) => p.reject(new Error("WebSocket closed")));
        pending.clear();
        if (!userClosed) {
          setState(STATES.DISCONNECTED);
          scheduleReconnect();
        } else {
          setState(STATES.DISCONNECTED);
        }
      });

      socket.addEventListener("error", () => {
        // 'error' is always followed by 'close' in browser WS — let close
        // drive the reconnect. Just surface the error state if we weren't
        // already past handshake.
        if (state === STATES.CONNECTING || state === STATES.AUTHENTICATING) {
          setState(STATES.ERROR, "WebSocket error (check URL / network)");
        }
      });
    }

    function handleInbound(msg) {
      // HA auth lifecycle.
      if (msg.type === "auth_required") {
        setState(STATES.AUTHENTICATING);
        sendRaw({ type: "auth", access_token: token });
        return;
      }
      if (msg.type === "auth_ok") {
        backoffIndex = 0; // successful auth resets backoff
        reconnectAttempt = 0;
        setState(STATES.AUTHED);
        return;
      }
      if (msg.type === "auth_invalid") {
        // Don't reconnect — token is bad and will just fail again.
        userClosed = true;
        setState(STATES.ERROR, "Auth invalid: " + (msg.message ?? "bad token"));
        try { ws && ws.close(); } catch (_) { /* ignore */ }
        return;
      }

      // Correlated request/response.
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const handler = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.type === "result") {
          if (msg.success) handler.resolve(msg.result);
          else handler.reject(new Error(msg.error?.message ?? "WS call failed"));
          return;
        }
        // Subscription events arrive with the same id repeatedly; we don't
        // use server-pushed events yet, so just fall through to listeners.
      }

      // Anything else: broadcast to message listeners.
      messageListeners.forEach((cb) => {
        try { cb(msg); } catch (_) { /* ignore listener errors */ }
      });
    }

    function sendRaw(obj) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(JSON.stringify(obj));
        return true;
      } catch (_) {
        return false;
      }
    }

    // Promise-returning request: assigns id and resolves on the matching
    // result message.
    function request(payload) {
      return new Promise((resolve, reject) => {
        if (state !== STATES.AUTHED && state !== STATES.STREAMING) {
          reject(new Error("Not authed"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const ok = sendRaw(Object.assign({}, payload, { id }));
        if (!ok) {
          pending.delete(id);
          reject(new Error("Send failed"));
        }
      });
    }

    // Fire-and-forget; used for sample messages where the server doesn't
    // ack each one. Still increments id so HA's per-connection id rule holds.
    function send(payload) {
      if (state !== STATES.AUTHED && state !== STATES.STREAMING) return false;
      const id = nextId++;
      return sendRaw(Object.assign({}, payload, { id }));
    }

    function scheduleReconnect() {
      if (userClosed) return;
      clearReconnect();
      const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
      backoffIndex++;
      reconnectDelayMs = delay;
      reconnectScheduledAt = Date.now();
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectScheduledAt = null;
        reconnectDelayMs = 0;
        openSocket();
      }, delay);
      // Re-emit current state so subscribers re-render countdown UI even
      // though state itself didn't change. UI reads getReconnectInfo()
      // from the listener callback.
      listeners.forEach((cb) => {
        try { cb({ state, error: lastError }); } catch (_) { /* ignore */ }
      });
    }

    function clearReconnect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectScheduledAt = null;
      reconnectDelayMs = 0;
    }

    // v0.4: let the UI bypass the backoff timer. Useful for the "Retry
    // now" button when the user knows the network is back.
    function retryNow() {
      if (userClosed) return;
      clearReconnect();
      openSocket();
    }

    function getReconnectInfo() {
      if (reconnectScheduledAt === null) return null;
      const remainingMs = Math.max(
        0,
        reconnectScheduledAt + reconnectDelayMs - Date.now(),
      );
      return {
        attemptNumber: reconnectAttempt,
        remainingMs,
        delayMs: reconnectDelayMs,
      };
    }

    function disconnect() {
      userClosed = true;
      clearReconnect();
      if (ws) {
        try { ws.close(); } catch (_) { /* ignore */ }
        ws = null;
      }
      pending.forEach((p) => p.reject(new Error("Disconnected by user")));
      pending.clear();
      setState(STATES.DISCONNECTED);
    }

    function getState() { return state; }
    function getLastError() { return lastError; }
    function markStreaming(on) {
      if (on && state === STATES.AUTHED) setState(STATES.STREAMING);
      else if (!on && state === STATES.STREAMING) setState(STATES.AUTHED);
    }

    return {
      STATES,
      connect,
      disconnect,
      retryNow,
      request,
      send,
      onStateChange,
      onMessage,
      getState,
      getLastError,
      getReconnectInfo,
      markStreaming,
    };
  }

  global.HaWsClient = HaWsClient;
  global.HaWsStates = STATES;
})(window);
