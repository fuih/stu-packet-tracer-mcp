/**
 * Student MCP Bridge — TUI WebView controller (bridge.js)
 *
 * Implements Bridge Protocol v1 (long-poll /v1/next + JSON /v1/result with
 * correlation IDs) with automatic fallback to legacy /next polling,
 * exponential reconnect backoff (1s -> 2s -> 5s -> 10s), live latency
 * sparklines, keyboard shortcuts, and 3 switchable TUI themes.
 */
(function () {
  "use strict";

  var BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000];
  var LONG_POLL_WAIT_MS = 25000;
  var LEGACY_POLL_MS = 500;
  var MAX_LOG_ENTRIES = 200;
  var SPARK_LEN = 24;
  var SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  var THEMES = ["claude", "btop", "abtop"];
  var LABEL_RE = /^\s*\/\*\s*([^*][\s\S]*?)\s*\*\/\s*/;

  var serverUrlInput = document.getElementById("server-url");
  var tokenInput = document.getElementById("bridge-token");
  var toggleBtn = document.getElementById("toggle-btn");
  var clearBtn = document.getElementById("clear-btn");
  var themeBtn = document.getElementById("theme-btn");
  var statusDot = document.getElementById("status-dot");
  var statusText = document.getElementById("status-text");
  var protocolBadge = document.getElementById("protocol-badge");
  var lastLabelEl = document.getElementById("last-label");
  var cmdCountEl = document.getElementById("cmd-count");
  var okCountEl = document.getElementById("ok-count");
  var errCountEl = document.getElementById("err-count");
  var healthBarEl = document.getElementById("health-bar");
  var healthPctEl = document.getElementById("health-pct");
  var lastMsEl = document.getElementById("last-ms");
  var avgMsEl = document.getElementById("avg-ms");
  var sparklineEl = document.getElementById("sparkline");
  var clockEl = document.getElementById("clock-text");
  var uptimeEl = document.getElementById("uptime-text");
  var logListEl = document.getElementById("log-list");
  var backoffNoteEl = document.getElementById("backoff-note");

  var running = true;
  var activeXhr = null;
  var retryTimer = null;
  var backoffIndex = 0;
  var wasConnected = false;
  var commandCount = 0;
  var okCount = 0;
  var errCount = 0;
  var totalLatencyMs = 0;
  var latencySamples = [];
  var themeIdx = 0;
  var startedAt = Date.now();
  var pendingResolvers = {};

  function getBaseUrl() {
    var raw = (serverUrlInput.value || "http://127.0.0.1:54321").trim();
    return raw.replace(/\/+$/, "");
  }

  function getToken() {
    return (tokenInput.value || "").trim();
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function nowTime() {
    var d = new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  function updateClock() {
    if (clockEl) clockEl.textContent = nowTime();
    if (uptimeEl) {
      var secs = Math.floor((Date.now() - startedAt) / 1000);
      var h = Math.floor(secs / 3600);
      var m = Math.floor((secs % 3600) / 60);
      var s = secs % 60;
      uptimeEl.textContent = h > 0
        ? "up " + pad2(h) + ":" + pad2(m) + ":" + pad2(s)
        : "up " + pad2(m) + ":" + pad2(s);
    }
  }

  function renderSparkline() {
    if (!sparklineEl) return;
    if (latencySamples.length === 0) {
      sparklineEl.textContent = "························";
      return;
    }
    var maxVal = 20;
    for (var i = 0; i < latencySamples.length; i++) {
      if (latencySamples[i] > maxVal) maxVal = latencySamples[i];
    }
    var out = "";
    var padCount = Math.max(0, SPARK_LEN - latencySamples.length);
    for (var p = 0; p < padCount; p++) out += "·";
    for (var j = 0; j < latencySamples.length; j++) {
      var ratio = Math.min(1, latencySamples[j] / maxVal);
      var gIdx = Math.min(SPARK_GLYPHS.length - 1, Math.floor(ratio * SPARK_GLYPHS.length));
      out += SPARK_GLYPHS[gIdx];
    }
    sparklineEl.textContent = out;
  }

  function renderHealth() {
    if (!healthBarEl || !healthPctEl) return;
    if (commandCount === 0) {
      healthBarEl.textContent = "──────────";
      healthPctEl.textContent = "--%";
      return;
    }
    var pct = Math.round((okCount / commandCount) * 100);
    var filled = Math.round((pct / 100) * 10);
    var bar = "";
    for (var i = 0; i < 10; i++) bar += i < filled ? "█" : "░";
    healthBarEl.textContent = bar;
    healthPctEl.textContent = pct + "%";
  }

  function formatDurationBar(ms) {
    if (typeof ms !== "number" || isNaN(ms)) return "";
    if (ms <= 2) return "▏";
    if (ms <= 8) return "▎";
    if (ms <= 25) return "▌";
    if (ms <= 80) return "▊";
    return "█";
  }

  function recordCommandMetrics(ok, elapsedMs) {
    commandCount++;
    if (ok) okCount++;
    else errCount++;
    if (cmdCountEl) cmdCountEl.textContent = String(commandCount);
    if (okCountEl) okCountEl.textContent = String(okCount);
    if (errCountEl) errCountEl.textContent = String(errCount);

    var ms = typeof elapsedMs === "number" && !isNaN(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0;
    totalLatencyMs += ms;
    latencySamples.push(ms);
    if (latencySamples.length > SPARK_LEN) latencySamples.shift();

    if (lastMsEl) lastMsEl.textContent = ms + "ms";
    if (avgMsEl) avgMsEl.textContent = Math.round(totalLatencyMs / commandCount) + "ms";
    renderSparkline();
    renderHealth();
  }

  function appendLog(kind, message, elapsedMs) {
    var row = document.createElement("div");
    row.className = "log-entry";

    var timeEl = document.createElement("span");
    timeEl.className = "log-time";
    timeEl.textContent = nowTime();

    var tagEl = document.createElement("span");
    tagEl.className = kind === "ok" ? "log-ok" : kind === "err" ? "log-err" : "log-info";
    tagEl.textContent = kind === "ok" ? "OK" : kind === "err" ? "ERR" : "SYS";

    var msEl = document.createElement("span");
    msEl.className = "log-ms";
    if (typeof elapsedMs === "number") {
      msEl.textContent = String(Math.round(elapsedMs)) + "ms";
      var barSpan = document.createElement("span");
      barSpan.className = "log-bar";
      barSpan.textContent = formatDurationBar(elapsedMs);
      msEl.appendChild(barSpan);
    } else {
      msEl.textContent = "--";
    }

    var msgEl = document.createElement("span");
    msgEl.className = "log-msg";
    msgEl.textContent = message;
    msgEl.title = message;

    row.appendChild(timeEl);
    row.appendChild(tagEl);
    row.appendChild(msEl);
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
    if (mode === "v1") {
      protocolBadge.className = "pill pill-v1";
      protocolBadge.textContent = "v1";
    } else if (mode === "legacy") {
      protocolBadge.className = "pill pill-legacy";
      protocolBadge.textContent = "legacy";
    } else {
      protocolBadge.className = "pill pill-muted";
      protocolBadge.textContent = "v--";
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
      appendLog("info", "Disconnected (" + reason + ") - reconnecting...");
      wasConnected = false;
    }

    setStatus("waiting", "Waiting...");
    backoffNoteEl.textContent = "retry " + (delay / 1000) + "s";

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
    setStatus("connected", "Connected");
    if (!wasConnected) {
      wasConnected = true;
      appendLog("info", "Connected to " + getBaseUrl() + " (" + mode + ")");
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
        setStatus("error", "Rejected " + status);
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
          recordCommandMetrics(!!resultPayload.ok, resultPayload.elapsedMs);
          if (resultPayload.ok) {
            appendLog("ok", label, resultPayload.elapsedMs);
          } else {
            appendLog("err", label + " -> " + (resultPayload.error || "failed"), resultPayload.elapsedMs);
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
        recordCommandMetrics(true, 1);
        appendLog("ok", "[legacy] " + label, 1);
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
    toggleBtn.className = "tui-btn btn-primary";
    appendLog("info", "Bridge paused by user.");
  }

  function startBridge() {
    if (running) return;
    running = true;
    backoffIndex = 0;
    toggleBtn.textContent = "Stop";
    toggleBtn.className = "tui-btn btn-danger";
    setStatus("waiting", "Connecting...");
    appendLog("info", "Starting bridge against " + getBaseUrl() + "...");
    detectAndStart();
  }

  function cycleTheme() {
    themeIdx = (themeIdx + 1) % THEMES.length;
    var name = THEMES[themeIdx];
    document.documentElement.setAttribute("data-theme", name);
    if (themeBtn) themeBtn.textContent = "Theme: " + name;
  }

  toggleBtn.addEventListener("click", function () {
    if (running) stopBridge();
    else startBridge();
  });

  clearBtn.addEventListener("click", function () {
    logListEl.innerHTML = "";
  });

  if (themeBtn) {
    themeBtn.addEventListener("click", cycleTheme);
  }

  document.addEventListener("keydown", function (ev) {
    var tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea") {
      if (ev.key === "Escape") ev.target.blur();
      return;
    }
    var k = (ev.key || "").toLowerCase();
    if (k === "s") {
      if (running) stopBridge();
      else startBridge();
    } else if (k === "c") {
      logListEl.innerHTML = "";
    } else if (k === "t") {
      cycleTheme();
    } else if (k === "u") {
      ev.preventDefault();
      serverUrlInput.focus();
      serverUrlInput.select();
    }
  });

  // Initialize TUI clock, sparkline, and auto-connect
  updateClock();
  setInterval(updateClock, 1000);
  renderSparkline();
  renderHealth();
  toggleBtn.textContent = "Stop";
  toggleBtn.className = "tui-btn btn-danger";
  appendLog("info", "stu-pt-bridge TUI initialized (themes: claude / btop / abtop).");
  detectAndStart();
})();
