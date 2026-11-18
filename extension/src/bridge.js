/**
 * Student MCP Bridge — Cyber Telemetry TUI WebView Controller (bridge.js)
 *
 * Implements Bridge Protocol v1 (long-poll /v1/next + JSON /v1/result with
 * correlation IDs and live AI agent identification via X-Stu-Agent / envelope.agent),
 * automatic fallback to legacy /next polling, exponential reconnect backoff
 * (1s -> 2s -> 5s -> 10s), live telemetry cards, 24-bar pulse visualizer,
 * filterable log stream, and interactive CLI prompt.
 */
(function () {
  "use strict";

  var BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000];
  var LONG_POLL_WAIT_MS = 25000;
  var LEGACY_POLL_MS = 500;
  var MAX_LOG_ENTRIES = 250;
  var PULSE_LEN = 24;
  var LABEL_RE = /^\s*\/\*\s*([^*][\s\S]*?)\s*\*\/\s*/;

  // DOM references
  var serverUrlInput = document.getElementById("server-url");
  var tokenInput = document.getElementById("bridge-token");
  var copyUrlBtn = document.getElementById("copy-url-btn");
  var revealTokenBtn = document.getElementById("reveal-token-btn");
  var toggleBtn = document.getElementById("toggle-btn");
  var toggleLabel = document.getElementById("toggle-label");
  var clearBtn = document.getElementById("clear-btn");
  var autoscrollBtn = document.getElementById("autoscroll-btn");
  var autoscrollLabel = document.getElementById("autoscroll-label");
  var cliInput = document.getElementById("cli-input");

  var headerStatusPill = document.getElementById("header-status-pill");
  var headerStatusText = document.getElementById("header-status-text");
  var statusDot = document.getElementById("status-dot");
  var statusText = document.getElementById("status-text");
  var backoffNoteEl = document.getElementById("backoff-note");
  var protocolBadge = document.getElementById("protocol-badge");
  var metaHostEl = document.getElementById("meta-host");
  var metaAgentEl = document.getElementById("meta-agent");
  var metaChannelEl = document.getElementById("meta-channel");

  var clockEl = document.getElementById("clock-text");
  var uptimeEl = document.getElementById("uptime-text");
  var cmdCountEl = document.getElementById("cmd-count");
  var okCountEl = document.getElementById("ok-count");
  var errCountEl = document.getElementById("err-count");
  var healthSegmentsEl = document.getElementById("health-segments");
  var healthPctEl = document.getElementById("health-pct");
  var lastMsEl = document.getElementById("last-ms");
  var avgMsEl = document.getElementById("avg-ms");
  var lastLabelEl = document.getElementById("last-label");
  var pulseBarsEl = document.getElementById("pulse-bars");
  var logListEl = document.getElementById("log-list");

  var filterButtons = document.querySelectorAll("[data-filter]");

  // Bridge & telemetry state
  var running = true;
  var activeXhr = null;
  var retryTimer = null;
  var backoffIndex = 0;
  var wasConnected = false;
  var protocolMode = "none";
  var activeAgent = null;
  var commandCount = 0;
  var okCount = 0;
  var errCount = 0;
  var totalLatencyMs = 0;
  var pulseSamples = [];
  var autoScroll = true;
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
      uptimeEl.textContent = pad2(h) + ":" + pad2(m) + ":" + pad2(s);
    }
  }

  function updateHostMeta() {
    if (!metaHostEl) return;
    var hostOnly = getBaseUrl().replace(/^https?:\/\//i, "");
    metaHostEl.textContent = hostOnly || "127.0.0.1:54321";
  }

  function updateAgentDisplay(nextName, shouldLog) {
    var normalized = typeof nextName === "string" && nextName.trim() ? nextName.trim() : null;
    var changed = activeAgent !== normalized;
    activeAgent = normalized;

    if (metaAgentEl) {
      metaAgentEl.textContent = activeAgent || "--";
      metaAgentEl.className = activeAgent ? "meta-val is-agent-live" : "meta-val";
    }

    if (changed && shouldLog && activeAgent) {
      appendLog("sys", "AI agent connected: " + activeAgent);
    }

    if (wasConnected) {
      applyConnectedHudText();
    }
  }

  function applyConnectedHudText() {
    if (activeAgent) {
      setStatus("connected", activeAgent, "Connected: " + activeAgent);
      if (backoffNoteEl) {
        backoffNoteEl.textContent = "agent connected (" + (protocolMode === "legacy" ? "legacy" : "v1") + ")";
      }
    } else {
      setStatus("connected", "Server ready", "Connected");
      if (backoffNoteEl) {
        backoffNoteEl.textContent = "awaiting AI agent...";
      }
    }
  }

  function initPulseBars() {
    if (!pulseBarsEl) return;
    pulseBarsEl.innerHTML = "";
    for (var i = 0; i < PULSE_LEN; i++) {
      pulseSamples.push({ ms: 0, ok: true, active: false });
      var bar = document.createElement("span");
      bar.className = "pulse-bar";
      bar.style.height = "4px";
      pulseBarsEl.appendChild(bar);
    }
  }

  function renderPulseBars() {
    if (!pulseBarsEl) return;
    var bars = pulseBarsEl.children;
    var maxMs = 40;
    var i;
    for (i = 0; i < pulseSamples.length; i++) {
      if (pulseSamples[i].ms > maxMs) maxMs = pulseSamples[i].ms;
    }
    for (i = 0; i < bars.length; i++) {
      var sample = pulseSamples[i];
      var barEl = bars[i];
      if (!sample || !sample.active) {
        barEl.style.height = "4px";
        barEl.className = "pulse-bar";
      } else {
        var ratio = Math.min(1, Math.max(0.15, sample.ms / maxMs));
        var px = Math.round(4 + ratio * 16);
        barEl.style.height = px + "px";
        barEl.className = sample.ok ? "pulse-bar is-hot" : "pulse-bar is-err";
      }
    }
  }

  function pushPulseSample(ms, ok) {
    pulseSamples.shift();
    pulseSamples.push({ ms: ms, ok: ok, active: true });
    renderPulseBars();
  }

  function renderHealth() {
    if (!healthSegmentsEl || !healthPctEl) return;
    var segs = healthSegmentsEl.children;
    if (commandCount === 0) {
      healthPctEl.textContent = "--%";
      for (var k = 0; k < segs.length; k++) {
        segs[k].className = "health-seg";
      }
      return;
    }
    var pct = Math.round((okCount / commandCount) * 100);
    var filled = Math.round((pct / 100) * segs.length);
    var tone = pct >= 80 ? "is-ok" : pct >= 50 ? "is-warn" : "is-err";
    healthPctEl.textContent = pct + "%";
    for (var i = 0; i < segs.length; i++) {
      segs[i].className = i < filled ? "health-seg " + tone : "health-seg";
    }
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

    if (lastMsEl) {
      lastMsEl.textContent = String(ms);
      lastMsEl.className = "metric-big";
    }
    if (avgMsEl) {
      avgMsEl.textContent = Math.round(totalLatencyMs / commandCount) + "ms";
    }

    pushPulseSample(ms, ok);
    renderHealth();
  }

  function setLastLabel(label) {
    if (!lastLabelEl) return;
    lastLabelEl.textContent = label;
    lastLabelEl.title = label;
  }

  /**
   * Append row to Panel 3 stream.
   * kind: "sys" | "ok" | "ipc" | "auth" | "err"
   */
  function appendLog(kind, message, elapsedMs) {
    if (!logListEl) return;
    var row = document.createElement("div");
    var cat = kind === "err" ? "err" : (kind === "ok" || kind === "ipc") ? "ipc" : "sys";
    row.className = kind === "ok" || kind === "ipc" ? "log-row is-highlight" : "log-row";
    row.setAttribute("data-cat", cat);

    var timeEl = document.createElement("span");
    timeEl.className = "log-time";
    timeEl.textContent = nowTime();

    var statWrap = document.createElement("span");
    statWrap.className = "log-stat-wrap";
    var badge = document.createElement("span");
    var statLabel = "SYS";
    var statClass = "stat-pill stat-sys";
    if (kind === "ok") {
      statLabel = "OK";
      statClass = "stat-pill stat-ok";
    } else if (kind === "ipc") {
      statLabel = "IPC";
      statClass = "stat-pill stat-ipc";
    } else if (kind === "auth") {
      statLabel = "AUTH";
      statClass = "stat-pill stat-auth";
    } else if (kind === "err") {
      statLabel = "ERR";
      statClass = "stat-pill stat-err";
    }
    badge.className = statClass;
    badge.textContent = statLabel;
    statWrap.appendChild(badge);

    var msEl = document.createElement("span");
    msEl.className = "log-ms";
    msEl.textContent = typeof elapsedMs === "number" && !isNaN(elapsedMs)
      ? String(Math.round(elapsedMs)) + "ms"
      : "--";

    var msgEl = document.createElement("span");
    msgEl.className = "log-msg";
    msgEl.textContent = message;
    msgEl.title = message;

    row.appendChild(timeEl);
    row.appendChild(statWrap);
    row.appendChild(msEl);
    row.appendChild(msgEl);
    logListEl.appendChild(row);

    while (logListEl.children.length > MAX_LOG_ENTRIES) {
      logListEl.removeChild(logListEl.firstChild);
    }
    if (autoScroll) {
      logListEl.scrollTop = logListEl.scrollHeight;
    }
  }

  function setStatus(state, hudText, pillText) {
    document.body.setAttribute("data-state", state);
    if (statusDot) statusDot.className = "dot dot-" + state;
    if (statusText) statusText.textContent = hudText;

    if (headerStatusPill) {
      headerStatusPill.className = "conn-pill conn-" + state;
    }
    if (headerStatusText) {
      headerStatusText.textContent = pillText || hudText;
    }
  }

  function setProtocol(mode) {
    protocolMode = mode;
    if (mode === "v1") {
      if (protocolBadge) {
        protocolBadge.className = "proto-badge proto-v1";
        protocolBadge.textContent = "V1";
      }
      if (metaChannelEl) metaChannelEl.textContent = "IPC/V1";
    } else if (mode === "legacy") {
      if (protocolBadge) {
        protocolBadge.className = "proto-badge proto-legacy";
        protocolBadge.textContent = "LEGACY";
      }
      if (metaChannelEl) metaChannelEl.textContent = "IPC/LEGACY";
    } else {
      if (protocolBadge) {
        protocolBadge.className = "proto-badge";
        protocolBadge.textContent = "V--";
      }
      if (metaChannelEl) metaChannelEl.textContent = "IPC/AUTO";
    }
  }

  function setFilter(filterName) {
    if (logListEl) logListEl.setAttribute("data-stream-filter", filterName);
    for (var i = 0; i < filterButtons.length; i++) {
      var btn = filterButtons[i];
      var f = btn.getAttribute("data-filter");
      var cls = f === "err" ? "filter-btn filter-err" : "filter-btn";
      if (f === filterName) cls += " is-active";
      btn.className = cls;
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

    function done(err, status, text, agentHeader) {
      if (finished) return;
      finished = true;
      if (activeXhr === xhr) activeXhr = null;
      callback(err, status, text, agentHeader);
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
      var agentHdr = null;
      try {
        agentHdr = xhr.getResponseHeader("X-Stu-Agent");
      } catch (e) {}
      done(null, xhr.status, xhr.responseText, agentHdr);
    };
    xhr.onerror = function () {
      done(new Error("Network error"), 0, "", null);
    };
    xhr.ontimeout = function () {
      done(new Error("Request timeout"), 0, "", null);
    };
    xhr.onabort = function () {
      done(new Error("Aborted"), 0, "", null);
    };

    try {
      xhr.send(body === undefined ? null : body);
    } catch (e) {
      done(e, 0, "", null);
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
      appendLog("ipc", "Disconnected (" + reason + ") -> retry scheduled in " + (delay / 1000) + "s");
      wasConnected = false;
    }

    updateAgentDisplay(null, false);
    setProtocol("none");
    setStatus("waiting", "Waiting for client...", "Awaiting Bridge");
    if (backoffNoteEl) backoffNoteEl.textContent = "retry scheduled: " + (delay / 1000) + "s";

    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (backoffNoteEl) backoffNoteEl.textContent = "probing endpoint...";
      detectAndStart();
    }, delay);
  }

  function markConnected(mode, maybeAgent) {
    backoffIndex = 0;
    setProtocol(mode);
    if (!wasConnected) {
      wasConnected = true;
      appendLog("sys", "Connected to " + getBaseUrl() + " (" + mode + ")");
    }
    if (maybeAgent !== undefined) {
      updateAgentDisplay(maybeAgent, true);
    } else {
      applyConnectedHudText();
    }
  }

  function pollV1() {
    if (!running) return;
    var url = getBaseUrl() + "/v1/next?wait=" + LONG_POLL_WAIT_MS;
    xhrRequest("GET", url, null, LONG_POLL_WAIT_MS + 5000, function (err, status, text, agentHdr) {
      if (!running) return;

      if (err) {
        scheduleReconnect(err.message);
        return;
      }

      if (status === 401 || status === 403) {
        setStatus("error", "Rejected " + status, "Rejected " + status);
        appendLog("err", "Server rejected request (HTTP " + status + "). Check token or origin.");
        scheduleReconnect("HTTP " + status);
        return;
      }

      if (status === 204) {
        markConnected("v1", agentHdr);
        pollV1();
        return;
      }

      if (status === 200 && text) {
        var env;
        try {
          env = JSON.parse(text);
        } catch (parseErr) {
          markConnected("v1", agentHdr);
          appendLog("err", "Malformed JSON envelope from server.");
          pollV1();
          return;
        }

        markConnected("v1", env.agent !== undefined ? env.agent : agentHdr);

        var label = extractLabel(env);
        setLastLabel(label);

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
      markConnected("legacy", undefined);
      if (status === 200 && text) {
        var label = extractLabel({ code: text });
        setLastLabel(label);
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
    updateHostMeta();
    var statusUrl = getBaseUrl() + "/v1/status";
    xhrRequest("GET", statusUrl, null, 4000, function (err, status, text, agentHdr) {
      if (!running) return;
      if (err) {
        scheduleReconnect(err.message);
        return;
      }
      if (status === 200) {
        var parsedAgent = agentHdr;
        try {
          var s = JSON.parse(text || "{}");
          if (s && s.agent !== undefined) parsedAgent = s.agent;
        } catch (e) {}
        markConnected("v1", parsedAgent);
        pollV1();
      } else if (status === 404) {
        markConnected("legacy", null);
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
    updateAgentDisplay(null, false);
    setProtocol("none");
    if (backoffNoteEl) backoffNoteEl.textContent = "bridge paused";
    setStatus("idle", "Stopped", "Paused");
    setLastLabel("paused");
    if (toggleBtn) toggleBtn.className = "cta-btn cta-start";
    if (toggleLabel) toggleLabel.textContent = "Start";
    appendLog("sys", "Bridge paused by operator.");
  }

  function startBridge() {
    if (running) return;
    running = true;
    backoffIndex = 0;
    if (toggleBtn) toggleBtn.className = "cta-btn cta-stop";
    if (toggleLabel) toggleLabel.textContent = "Stop";
    if (backoffNoteEl) backoffNoteEl.textContent = "connecting...";
    setStatus("waiting", "Connecting...", "Awaiting Bridge");
    setLastLabel("idle");
    appendLog("sys", "Starting bridge against " + getBaseUrl() + "...");
    detectAndStart();
  }

  function clearLogs() {
    if (logListEl) logListEl.innerHTML = "";
  }

  function copyEndpoint() {
    var val = getBaseUrl();
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(val).then(function () {
        if (copyUrlBtn) {
          copyUrlBtn.textContent = "copied";
          setTimeout(function () { copyUrlBtn.textContent = "copy"; }, 1200);
        }
      }, function () {
        fallbackCopy(val);
      });
    } else {
      fallbackCopy(val);
    }
  }

  function fallbackCopy(text) {
    if (!serverUrlInput) return;
    serverUrlInput.focus();
    serverUrlInput.select();
    try {
      document.execCommand("copy");
      if (copyUrlBtn) {
        copyUrlBtn.textContent = "copied";
        setTimeout(function () { copyUrlBtn.textContent = "copy"; }, 1200);
      }
    } catch (e) {
      appendLog("sys", "Endpoint: " + text);
    }
  }

  function handleCliCommand(raw) {
    var trimmed = (raw || "").trim();
    if (!trimmed) return;
    var cmd = trimmed.charAt(0) === ":" ? trimmed.slice(1).trim() : trimmed;
    var parts = cmd.split(/\s+/);
    var verb = (parts[0] || "").toLowerCase();
    var arg = parts.slice(1).join(" ").trim();

    if (verb === "help" || verb === "?") {
      appendLog("sys", "Commands: start | stop | clear | filter [all|sys|ipc|err] | ping | status | url <endpoint> | token <secret|clear>");
    } else if (verb === "start") {
      startBridge();
    } else if (verb === "stop") {
      stopBridge();
    } else if (verb === "clear" || verb === "cls") {
      clearLogs();
    } else if (verb === "filter") {
      var f = arg.toLowerCase();
      if (f === "all" || f === "sys" || f === "ipc" || f === "err") {
        setFilter(f);
        appendLog("sys", "Stream filter set to " + f.toUpperCase());
      } else {
        appendLog("err", "Unknown filter '" + arg + "'. Expected: all, sys, ipc, err");
      }
    } else if (verb === "status") {
      appendLog(
        "sys",
        "State=" + (running ? (wasConnected ? "connected" : "waiting") : "stopped") +
          " | agent=" + (activeAgent || "none") +
          " | cmds=" + commandCount +
          " (ok=" + okCount + ", err=" + errCount + ")" +
          " | endpoint=" + getBaseUrl()
      );
    } else if (verb === "ping") {
      var pingStart = Date.now();
      xhrRequest("GET", getBaseUrl() + "/v1/status", null, 3000, function (err, status, text, agentHdr) {
        var rtt = Date.now() - pingStart;
        if (err || status >= 400) {
          appendLog("err", "Ping failed (" + (err ? err.message : "HTTP " + status) + ")", rtt);
        } else {
          var pingAgent = agentHdr;
          try {
            var ps = JSON.parse(text || "{}");
            if (ps && ps.agent !== undefined) pingAgent = ps.agent;
          } catch (e) {}
          if (pingAgent !== undefined) updateAgentDisplay(pingAgent, true);
          appendLog("ok", "Ping /v1/status HTTP " + status + (activeAgent ? " (agent: " + activeAgent + ")" : " ready"), rtt);
        }
      });
    } else if (verb === "url" && arg) {
      serverUrlInput.value = arg;
      updateHostMeta();
      appendLog("sys", "Endpoint updated to " + getBaseUrl());
      if (running) {
        stopBridge();
        startBridge();
      }
    } else if (verb === "token") {
      tokenInput.value = arg === "clear" ? "" : arg;
      appendLog("auth", arg === "clear" || !arg ? "Bridge token cleared." : "Bridge token updated.");
    } else {
      appendLog("err", "Unknown command '" + trimmed + "'. Type :help for options.");
    }
  }

  // Event bindings
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      if (running) stopBridge();
      else startBridge();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", clearLogs);
  }

  if (copyUrlBtn) {
    copyUrlBtn.addEventListener("click", copyEndpoint);
  }

  if (revealTokenBtn && tokenInput) {
    revealTokenBtn.addEventListener("click", function () {
      var hidden = tokenInput.type === "password";
      tokenInput.type = hidden ? "text" : "password";
      revealTokenBtn.textContent = hidden ? "hide" : "reveal";
    });
  }

  if (serverUrlInput) {
    serverUrlInput.addEventListener("input", updateHostMeta);
  }

  if (autoscrollBtn) {
    autoscrollBtn.addEventListener("click", function () {
      autoScroll = !autoScroll;
      autoscrollBtn.className = autoScroll ? "autoscroll-btn is-on" : "autoscroll-btn";
      if (autoscrollLabel) autoscrollLabel.textContent = autoScroll ? "autoscroll: ON" : "autoscroll: OFF";
      if (autoScroll && logListEl) logListEl.scrollTop = logListEl.scrollHeight;
    });
  }

  for (var fIdx = 0; fIdx < filterButtons.length; fIdx++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        setFilter(btn.getAttribute("data-filter"));
      });
    })(filterButtons[fIdx]);
  }

  if (cliInput) {
    cliInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        handleCliCommand(cliInput.value);
        cliInput.value = "";
      } else if (ev.key === "Escape") {
        cliInput.blur();
      }
    });
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
      clearLogs();
    } else if (k === "u") {
      ev.preventDefault();
      if (serverUrlInput) {
        serverUrlInput.focus();
        serverUrlInput.select();
      }
    } else if (k === "l") {
      ev.preventDefault();
      if (logListEl) logListEl.focus();
    } else if (k === "/" || k === ":") {
      ev.preventDefault();
      if (cliInput) {
        cliInput.focus();
        if (k === ":") cliInput.value = ":";
      }
    }
  });

  // Boot initialization
  updateClock();
  setInterval(updateClock, 1000);
  updateHostMeta();
  initPulseBars();
  renderPulseBars();
  renderHealth();
  setFilter("all");
  setProtocol("none");
  setStatus("waiting", "Waiting for client...", "Awaiting Bridge");
  appendLog("sys", "stu-pt-bridge monitor initialized.");
  appendLog("auth", getToken() ? "STU_PT_BRIDGE_TOKEN loaded from field." : "STU_PT_BRIDGE_TOKEN unset — local loopback mode.");
  detectAndStart();
})();
