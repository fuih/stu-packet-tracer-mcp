/**
 * Student MCP Bridge — WebView controller (bridge.js)
 *
 * Implements Bridge Protocol v1 (long-poll /v1/next + JSON /v1/result with
 * correlation IDs) with automatic fallback to legacy /next polling and
 * exponential reconnect backoff (1s -> 2s -> 5s -> 10s).
 */
(function () {
  "use strict";

  var BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000];
  var LONG_POLL_WAIT_MS = 25000;
  var LEGACY_POLL_MS = 500;
  var MAX_LOG_ENTRIES = 200;
  var LABEL_RE = /^\s*\/\*\s*([^*][\s\S]*?)\s*\*\/\s*/;

  var serverUrlInput = document.getElementById("server-url");
  var tokenInput = document.getElementById("bridge-token");
  var toggleBtn = document.getElementById("toggle-btn");
  var clearBtn = document.getElementById("clear-btn");
  var statusDot = document.getElementById("status-dot");
  var statusText = document.getElementById("status-text");
  var protocolBadge = document.getElementById("protocol-badge");
  var lastLabelEl = document.getElementById("last-label");
  var cmdCountEl = document.getElementById("cmd-count");
  var logListEl = document.getElementById("log-list");
  var backoffNoteEl = document.getElementById("backoff-note");

  var running = true;
  var activeXhr = null;
  var retryTimer = null;
  var backoffIndex = 0;
  var wasConnected = false;
  var protocolMode = null; // "v1" | "legacy" | null
  var commandCount = 0;
  var pendingResolvers = {};

  function getBaseUrl() {
    var raw = (serverUrlInput.value || "http://127.0.0.1:54321").trim();
    return raw.replace(/\/+$/, "");
  }

  function getToken() {
    return (tokenInput.value || "").trim();
  }

  function nowTime() {
    var d = new Date();
    function pad(n) { return n < 10 ? "0" + n : String(n); }
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function appendLog(kind, message) {
    var row = document.createElement("div");
    row.className = "log-entry";

    var timeEl = document.createElement("span");
    timeEl.className = "log-time";
    timeEl.textContent = nowTime();

    var tagEl = document.createElement("span");
    tagEl.className = kind === "ok" ? "log-ok" : kind === "err" ? "log-err" : "log-info";
    tagEl.textContent = kind === "ok" ? "[OK]" : kind === "err" ? "[ERR]" : "[INFO]";

    var msgEl = document.createElement("span");
    msgEl.className = "log-msg";
    msgEl.textContent = message;

    row.appendChild(timeEl);
    row.appendChild(tagEl);
    row.appendChild(msgEl);
    logListEl.appendChild(row);

    while (logListEl.children.length > MAX_LOG_ENTRIES) {
      logListEl.removeChild(logListEl.firstChild);
    }
    logListEl.scrollTop = logListEl.scrollHeight;
  }

  function setStatus(state, text) {
    statusDot.className = "dot dot-" + state;
    statusText.textContent = text;
  }

  function setProtocol(mode) {
    protocolMode = mode;
    if (mode === "v1") {
      protocolBadge.className = "pill pill-v1";
      protocolBadge.textContent = "Protocol: v1";
    } else if (mode === "legacy") {
      protocolBadge.className = "pill pill-legacy";
      protocolBadge.textContent = "Protocol: legacy";
    } else {
      protocolBadge.className = "pill pill-muted";
      protocolBadge.textContent = "Protocol: --";
    }
  }

  function extractLabel(envelope) {
    if (envelope && envelope.label && String(envelope.label).trim()) {
      return String(envelope.label).trim();
    }
    if (envelope && typeof envelope.code === "string") {
      var m = envelope.code.match(LABEL_RE);
      if (m && m[1]) {
        return m[1].replace(/\s+/g, " ").trim();
      }
    }
    return "Packet Tracer IPC command";
  }

  function xhrRequest(method, url, body, timeoutMs, callback) {
    var xhr = new XMLHttpRequest();
    activeXhr = xhr;
    var finished = false;

    function done(err, status, text) {
      if (finished) return;
      finished = true;
      if (activeXhr === xhr) activeXhr = null;
      callback(err, status, text);
    }

    xhr.open(method, url, true);
    xhr.timeout = timeoutMs;
    var tok = getToken();
    if (tok) {
      xhr.setRequestHeader("X-Stu-Token", tok);
    }
    if (body !== null && body !== undefined) {
      xhr.setRequestHeader("Content-Type", "application/json");
    }

    xhr.onload = function () {
      done(null, xhr.status, xhr.responseText);
    };
    xhr.onerror = function () {
      done(new Error("Network error"), 0, "");
    };
    xhr.ontimeout = function () {
      done(new Error("Request timeout"), 0, "");
    };
    xhr.onabort = function () {
      done(new Error("Aborted"), 0, "");
    };

    try {
      xhr.send(body === undefined ? null : body);
    } catch (e) {
      done(e, 0, "");
    }
  }

  /**
   * Callback invoked by main.js after executing a v1 command in the Script Engine.
   */
  window.__stuBridgeResult = function (payload) {
    if (!payload || !payload.id) return;
    var resolver = pendingResolvers[payload.id];
    if (resolver) {
      delete pendingResolvers[payload.id];
      resolver(payload);
    }
  };

  function executeInScriptEngine(envelope, onDone) {
    var settled = false;
    var timeoutMs = Math.max(5000, Number(envelope.timeoutMs) || 15000);

    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      delete pendingResolvers[envelope.id];
      onDone({
        id: envelope.id,
        ok: false,
        error: "ERROR:Script Engine execution timed out in extension",
        elapsedMs: timeoutMs
      });
    }, timeoutMs);

    pendingResolvers[envelope.id] = function (payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onDone(payload);
    };

    try {
      if (typeof window.$se === "function") {
        window.$se("runEnvelope", envelope.id, envelope.code);
      } else {
        throw new Error("$se bridge function is unavailable outside Packet Tracer");
      }
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        delete pendingResolvers[envelope.id];
        onDone({
          id: envelope.id,
          ok: false,
          error: "ERROR:" + String(e && e.message ? e.message : e),
          elapsedMs: 0
        });
      }
    }
  }

  function postV1Result(payload, callback) {
    var url = getBaseUrl() + "/v1/result";
    xhrRequest("POST", url, JSON.stringify(payload), 10000, function (err, status) {
      if (err || status >= 400) {
        appendLog("err", "Failed to post result for " + payload.id + " (HTTP " + status + ")");
      }
      callback();
    });
  }

  function scheduleReconnect(reason) {
    if (!running) return;
    var delay = BACKOFF_STEPS_MS[Math.min(backoffIndex, BACKOFF_STEPS_MS.length - 1)];
    if (backoffIndex < BACKOFF_STEPS_MS.length - 1) backoffIndex++;

    if (wasConnected) {
      appendLog("info", "Disconnected from server (" + reason + "). Reconnecting...");
      wasConnected = false;
    }

    setStatus("waiting", "Waiting for server...");
    backoffNoteEl.textContent = "Retry in " + (delay / 1000) + "s";

    retryTimer = setTimeout(function () {
      retryTimer = null;
      backoffNoteEl.textContent = "";
      detectAndStart();
    }, delay);
  }

  function markConnected(mode) {
    backoffIndex = 0;
    backoffNoteEl.textContent = "";
    setProtocol(mode);
    setStatus("connected", "Connected (" + getBaseUrl() + ")");
    if (!wasConnected) {
      wasConnected = true;
      appendLog("info", "Connected to stu-packet-tracer-mcp using protocol " + mode + ".");
    }
  }

  function pollV1() {
    if (!running) return;
    var url = getBaseUrl() + "/v1/next?wait=" + LONG_POLL_WAIT_MS;
    xhrRequest("GET", url, null, LONG_POLL_WAIT_MS + 5000, function (err, status, text) {
      if (!running) return;

      if (err) {
        scheduleReconnect(err.message);
        return;
      }

      if (status === 401 || status === 403) {
        setStatus("error", "Auth/Origin rejected (HTTP " + status + ")");
        appendLog("err", "Server rejected request (HTTP " + status + "). Check token or origin.");
        scheduleReconnect("HTTP " + status);
        return;
      }

      if (status === 204) {
        markConnected("v1");
        pollV1();
        return;
      }

      if (status === 200 && text) {
        markConnected("v1");
        var env;
        try {
          env = JSON.parse(text);
        } catch (parseErr) {
          appendLog("err", "Malformed JSON envelope from server.");
          pollV1();
          return;
        }

        var label = extractLabel(env);
        lastLabelEl.textContent = label;

        executeInScriptEngine(env, function (resultPayload) {
          commandCount++;
          cmdCountEl.textContent = String(commandCount);
          var ms = typeof resultPayload.elapsedMs === "number" ? " (" + resultPayload.elapsedMs + "ms)" : "";
          if (resultPayload.ok) {
            appendLog("ok", label + ms);
          } else {
            appendLog("err", label + " -> " + (resultPayload.error || "failed") + ms);
          }
          postV1Result(resultPayload, function () {
            if (running) pollV1();
          });
        });
        return;
      }

      scheduleReconnect("HTTP " + status);
    });
  }

  function pollLegacy() {
    if (!running) return;
    var url = getBaseUrl() + "/next";
    xhrRequest("GET", url, null, 5000, function (err, status, text) {
      if (!running) return;
      if (err || status >= 400) {
        scheduleReconnect(err ? err.message : "HTTP " + status);
        return;
      }
      markConnected("legacy");
      if (status === 200 && text) {
        var label = extractLabel({ code: text });
        lastLabelEl.textContent = label;
        commandCount++;
        cmdCountEl.textContent = String(commandCount);
        appendLog("ok", "[legacy] " + label);
        try {
          if (typeof window.$se === "function") {
            window.$se("runCode", text);
          }
        } catch (e) {
          appendLog("err", "Legacy execution failed: " + String(e));
        }
      }
      retryTimer = setTimeout(function () {
        retryTimer = null;
        pollLegacy();
      }, LEGACY_POLL_MS);
    });
  }

  function detectAndStart() {
    if (!running) return;
    var statusUrl = getBaseUrl() + "/v1/status";
    xhrRequest("GET", statusUrl, null, 4000, function (err, status) {
      if (!running) return;
      if (err) {
        scheduleReconnect(err.message);
        return;
      }
      if (status === 200) {
        markConnected("v1");
        pollV1();
      } else if (status === 404) {
        markConnected("legacy");
        pollLegacy();
      } else {
        scheduleReconnect("HTTP " + status);
      }
    });
  }

  function stopBridge() {
    running = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (activeXhr) {
      try { activeXhr.abort(); } catch (e) {}
      activeXhr = null;
    }
    wasConnected = false;
    backoffNoteEl.textContent = "";
    setStatus("idle", "Stopped");
    toggleBtn.textContent = "Start";
    toggleBtn.className = "btn btn-primary";
    appendLog("info", "Bridge paused by user.");
  }

  function startBridge() {
    if (running) return;
    running = true;
    backoffIndex = 0;
    toggleBtn.textContent = "Stop";
    toggleBtn.className = "btn btn-danger";
    setStatus("waiting", "Connecting...");
    appendLog("info", "Starting bridge against " + getBaseUrl() + "...");
    detectAndStart();
  }

  toggleBtn.addEventListener("click", function () {
    if (running) stopBridge();
    else startBridge();
  });

  clearBtn.addEventListener("click", function () {
    logListEl.innerHTML = "";
  });

  // Start automatically on open
  toggleBtn.textContent = "Stop";
  toggleBtn.className = "btn btn-danger";
  appendLog("info", "Student MCP Bridge initialized.");
  detectAndStart();
})();
