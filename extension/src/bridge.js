/**
 * Student MCP Bridge — Cyber Telemetry TUI WebView Controller (bridge.js)
 *
 * Implements Bridge Protocol v1 (long-poll /v1/next + JSON /v1/result with
 * correlation IDs and live AI agent identification), legacy /next fallback,
 * exponential reconnect backoff (1s -> 2s -> 5s -> 10s), live Packet Tracer
 * workspace telemetry (open .pkt, SIM state, device/link/power counts, and
 * clickable node health chips), filterable stream log, and CLI prompt.
 */
(function () {
  "use strict";

  var BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000];
  var LONG_POLL_WAIT_MS = 25000;
  var LEGACY_POLL_MS = 500;
  var TELEMETRY_POLL_MS = 3000;
  var TELEMETRY_DEBOUNCE_MS = 800;
  var MAX_LOG_ENTRIES = 250;
  var LABEL_RE = /^\s*\/\*\s*([^*][\s\S]*?)\s*\*\/\s*/;

  // DOM references
  var serverUrlInput = document.getElementById("server-url");
  var tokenInput = document.getElementById("bridge-token");
  var copyUrlBtn = document.getElementById("copy-url-btn");
  var revealTokenBtn = document.getElementById("reveal-token-btn");
  var toggleBtn = document.getElementById("toggle-btn");
  var toggleLabel = document.getElementById("toggle-label");
  var clearBtn = document.getElementById("clear-btn");
  var wrAllBtn = document.getElementById("wr-all-btn");
  var copyIpsBtn = document.getElementById("copy-ips-btn");
  var powerOnBtn = document.getElementById("power-on-btn");
  var configToggleBtn = document.getElementById("config-toggle-btn");
  var configDrawerEl = document.getElementById("config-drawer");
  var refreshTopoBtn = document.getElementById("refresh-topo-btn");
  var autoscrollBtn = document.getElementById("autoscroll-btn");
  var autoscrollLabel = document.getElementById("autoscroll-label");
  var cliInput = document.getElementById("cli-input");

  var headerStatusPill = document.getElementById("header-status-pill");
  var headerStatusText = document.getElementById("header-status-text");
  var statusDot = document.getElementById("status-dot");
  var statusText = document.getElementById("status-text");
  var backoffNoteEl = document.getElementById("backoff-note");
  var protocolBadge = document.getElementById("protocol-badge");
  var metaAgentEl = document.getElementById("meta-agent");

  var uptimeEl = document.getElementById("uptime-text");
  var pktNameEl = document.getElementById("pkt-name");
  var simBadgeEl = document.getElementById("sim-badge");
  var topoCountEl = document.getElementById("topo-count");
  var topoBreakdownEl = document.getElementById("topo-breakdown");
  var linkCountEl = document.getElementById("link-count");
  var powerStateEl = document.getElementById("power-state");
  var cmdCountEl = document.getElementById("cmd-count");
  var okCountEl = document.getElementById("ok-count");
  var errCountEl = document.getElementById("err-count");
  var avgMsEl = document.getElementById("avg-ms");
  var nodeStripEl = document.getElementById("node-strip");
  var nodeStripHintEl = document.getElementById("node-strip-hint");
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
  var autoScroll = true;
  var startedAt = Date.now();
  var pendingResolvers = {};
  var latestLabData = null;
  var telemetryDebounceTimer = null;
  var commandInFlight = false;

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

  function updateUptime() {
    if (uptimeEl) {
      var secs = Math.floor((Date.now() - startedAt) / 1000);
      var h = Math.floor(secs / 3600);
      var m = Math.floor((secs % 3600) / 60);
      var s = secs % 60;
      uptimeEl.textContent = pad2(h) + ":" + pad2(m) + ":" + pad2(s);
    }
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

  function inspectNodeToStream(dev) {
    if (!dev) return;
    var parts = [];
    if (dev.ports && dev.ports.length > 0) {
      for (var i = 0; i < dev.ports.length; i++) {
        var p = dev.ports[i];
        var desc = p.name + (p.ip ? "=" + p.ip : "") + (p.linked ? " [up]" : "");
        parts.push(desc);
      }
    }
    var summary =
      dev.name +
      " (" + (dev.model || dev.role) + ", " + (dev.powered ? "ON" : "POWER OFF") +
      ", " + dev.linkedCount + "/" + dev.portCount + " ports linked)" +
      (parts.length > 0 ? " -> " + parts.join(", ") : " -> no linked/addressed ports");
    appendLog(dev.powered ? "sys" : "err", summary);
  }

  window.__stuLabTelemetry = function (data) {
    if (!data) return;
    latestLabData = data;

    if (pktNameEl) {
      pktNameEl.textContent = data.pktName || "unsaved.pkt";
      pktNameEl.title = data.pktName || "unsaved.pkt";
    }
    if (simBadgeEl) {
      simBadgeEl.className = data.simPlaying ? "sub-chip chip-warn" : "sub-chip chip-ok";
      simBadgeEl.textContent = data.simPlaying ? "SIM PLAYING" : "REALTIME";
    }
    if (topoCountEl) topoCountEl.textContent = String(data.totalDevices || 0);
    if (topoBreakdownEl) {
      topoBreakdownEl.textContent =
        (data.routers || 0) + "R · " + (data.switches || 0) + "SW · " + (data.endpoints || 0) + "PC";
    }
    if (linkCountEl) linkCountEl.textContent = String(data.links || 0);

    if (powerStateEl) {
      if ((data.totalDevices || 0) === 0) {
        powerStateEl.className = "sub-chip chip-muted";
        powerStateEl.textContent = "empty canvas";
      } else if ((data.poweredOff || 0) > 0) {
        powerStateEl.className = "sub-chip chip-err";
        powerStateEl.textContent = data.poweredOff + " pwr off";
      } else if ((data.unwired || 0) > 0) {
        powerStateEl.className = "sub-chip chip-warn";
        powerStateEl.textContent = data.unwired + " unwired";
      } else {
        powerStateEl.className = "sub-chip chip-ok";
        powerStateEl.textContent = "all powered";
      }
    }

    if (powerOnBtn) {
      var offCount = Number(data.poweredOff) || 0;
      if (offCount > 0) {
        powerOnBtn.className = "tool-btn tool-btn-power";
        powerOnBtn.textContent = "power on (" + offCount + ")";
      } else {
        powerOnBtn.className = "tool-btn tool-btn-power is-hidden";
        powerOnBtn.textContent = "power on";
      }
    }

    if (nodeStripHintEl) {
      nodeStripHintEl.textContent = (data.totalDevices || 0) + " device(s) · click to inspect";
    }

    if (nodeStripEl) {
      nodeStripEl.innerHTML = "";
      var devs = data.devices || [];
      if (devs.length === 0) {
        var emptySpan = document.createElement("span");
        emptySpan.className = "node-empty";
        emptySpan.textContent = "Blank canvas — add devices or load a .pkt lab";
        nodeStripEl.appendChild(emptySpan);
      } else {
        for (var i = 0; i < devs.length; i++) {
          (function (dev) {
            var chip = document.createElement("button");
            chip.type = "button";
            var clsState = !dev.powered ? "is-off" : dev.linkedCount === 0 ? "is-unwired" : "is-up";
            chip.className = "node-chip " + clsState;
            chip.title = (dev.model || dev.role) + " · click to inspect interfaces";

            var dot = document.createElement("span");
            dot.className = "node-chip-dot";

            var nameSpan = document.createElement("span");
            nameSpan.textContent = dev.name;

            chip.appendChild(dot);
            chip.appendChild(nameSpan);

            if (!dev.powered) {
              var offSpan = document.createElement("span");
              offSpan.className = "node-chip-ip";
              offSpan.textContent = "OFF";
              chip.appendChild(offSpan);
            } else if (dev.primaryIp) {
              var ipSpan = document.createElement("span");
              ipSpan.className = "node-chip-ip";
              ipSpan.textContent = dev.primaryIp;
              chip.appendChild(ipSpan);
            }

            chip.addEventListener("click", function () {
              inspectNodeToStream(dev);
            });
            nodeStripEl.appendChild(chip);
          })(devs[i]);
        }
      }
    }
  };

  function requestTelemetry(force) {
    if (!force && commandInFlight) return;
    if (telemetryDebounceTimer) {
      clearTimeout(telemetryDebounceTimer);
      telemetryDebounceTimer = null;
    }
    try {
      if (typeof window.$se === "function") {
        window.$se("getLabTelemetry");
      }
    } catch (e) {}
  }

  function scheduleTelemetryRefresh(delayMs) {
    if (telemetryDebounceTimer) {
      clearTimeout(telemetryDebounceTimer);
    }
    var wait = typeof delayMs === "number" ? delayMs : TELEMETRY_DEBOUNCE_MS;
    telemetryDebounceTimer = setTimeout(function () {
      telemetryDebounceTimer = null;
      if (commandInFlight) {
        scheduleTelemetryRefresh(wait);
        return;
      }
      requestTelemetry(false);
    }, wait);
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

    if (avgMsEl) {
      avgMsEl.textContent = Math.round(totalLatencyMs / commandCount) + "ms";
    }
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
    } else if (mode === "legacy") {
      if (protocolBadge) {
        protocolBadge.className = "proto-badge proto-legacy";
        protocolBadge.textContent = "LEGACY";
      }
    } else {
      if (protocolBadge) {
        protocolBadge.className = "proto-badge";
        protocolBadge.textContent = "V--";
      }
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

        commandInFlight = true;
        executeInScriptEngine(env, function (resultPayload) {
          commandInFlight = false;
          postV1Result(resultPayload, function () {
            if (running) pollV1();
          });
          recordCommandMetrics(!!resultPayload.ok, resultPayload.elapsedMs);
          if (resultPayload.ok) {
            appendLog("ok", label, resultPayload.elapsedMs);
          } else {
            appendLog("err", label + " -> " + (resultPayload.error || "failed"), resultPayload.elapsedMs);
          }
          scheduleTelemetryRefresh(TELEMETRY_DEBOUNCE_MS);
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
        recordCommandMetrics(true, 1);
        appendLog("ok", "[legacy] " + label, 1);
        try {
          if (typeof window.$se === "function") {
            window.$se("runCode", text);
          }
        } catch (e) {
          appendLog("err", "Legacy execution failed: " + String(e));
        }
        scheduleTelemetryRefresh(TELEMETRY_DEBOUNCE_MS);
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
    appendLog("sys", "Starting bridge against " + getBaseUrl() + "...");
    detectAndStart();
  }

  function clearLogs() {
    if (logListEl) logListEl.innerHTML = "";
  }

  function flashButtonLabel(btn, tempText, origText) {
    if (!btn) return;
    btn.textContent = tempText;
    setTimeout(function () {
      btn.textContent = origText;
    }, 1200);
  }

  function copyTextToClipboard(text, btn, origLabel, doneLabel, fallbackLog) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(function () {
        flashButtonLabel(btn, doneLabel, origLabel);
      }, function () {
        fallbackCopyText(text, btn, origLabel, doneLabel, fallbackLog);
      });
    } else {
      fallbackCopyText(text, btn, origLabel, doneLabel, fallbackLog);
    }
  }

  function fallbackCopyText(text, btn, origLabel, doneLabel, fallbackLog) {
    var area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.focus();
    area.select();
    try {
      document.execCommand("copy");
      flashButtonLabel(btn, doneLabel, origLabel);
    } catch (e) {
      if (fallbackLog) appendLog("sys", fallbackLog);
    }
    document.body.removeChild(area);
  }

  function copyEndpoint() {
    var val = getBaseUrl();
    copyTextToClipboard(val, copyUrlBtn, "copy", "copied", "Endpoint: " + val);
  }

  function toggleConfigDrawer(forceOpen) {
    if (!configDrawerEl) return;
    var isCollapsed = configDrawerEl.className.indexOf("is-collapsed") >= 0;
    var shouldOpen = forceOpen !== undefined ? !!forceOpen : isCollapsed;
    configDrawerEl.className = shouldOpen ? "config-drawer" : "config-drawer is-collapsed";
    if (configToggleBtn) {
      configToggleBtn.className = shouldOpen ? "tool-btn tool-btn-config is-open" : "tool-btn tool-btn-config";
      configToggleBtn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    }
  }

  window.__stuActionResult = function (res) {
    if (!res) return;
    if (res.action === "wr_all") {
      var saved = res.saved || [];
      var skipped = res.skipped || [];
      if (saved.length > 0) {
        appendLog("ok", "Saved configs (write memory) on " + saved.length + " device(s): " + saved.join(", "));
      } else {
        appendLog("sys", "No powered-on routers or switches found to save.");
      }
      if (skipped.length > 0) {
        appendLog("sys", "Skipped: " + skipped.join(", "));
      }
    } else if (res.action === "power_on") {
      var powered = res.powered || [];
      if (powered.length > 0) {
        appendLog("ok", "Powered on " + powered.length + " device(s): " + powered.join(", "));
      } else {
        appendLog("sys", "All lab devices are already powered on.");
      }
    }
  };

  function runSaveAllConfigs() {
    try {
      if (typeof window.$se === "function") {
        window.$se("saveAllConfigs");
        flashButtonLabel(wrAllBtn, "saving...", "wr all");
      } else {
        appendLog("err", "$se is unavailable outside Packet Tracer.");
      }
    } catch (e) {
      appendLog("err", "Save configs failed: " + String(e));
    }
  }

  function runPowerOnAll() {
    try {
      if (typeof window.$se === "function") {
        window.$se("powerOnAll");
      } else {
        appendLog("err", "$se is unavailable outside Packet Tracer.");
      }
    } catch (e) {
      appendLog("err", "Power on failed: " + String(e));
    }
  }

  function copyAddressingTable() {
    var devs = latestLabData && latestLabData.devices ? latestLabData.devices : [];
    var rows = [];
    for (var i = 0; i < devs.length; i++) {
      var d = devs[i];
      var ports = d.ports || [];
      var gw = d.gateway || "-";
      for (var j = 0; j < ports.length; j++) {
        var p = ports[j];
        if (!p.ip) continue;
        rows.push(
          "| " + d.name + " | " + (d.model || d.role) + " | " + p.name +
          " | " + p.ip + " | " + (p.mask || "-") + " | " + gw + " | " + (p.linked ? "up" : "down") + " |"
        );
      }
    }
    if (rows.length === 0) {
      appendLog("sys", "No configured IPv4 addresses in latest PT snapshot.");
      return;
    }
    var md = [
      "| Device | Model | Interface | IP | Mask | Gateway | Link |",
      "| --- | --- | --- | --- | --- | --- | --- |"
    ].concat(rows).join("\n");
    copyTextToClipboard(md, copyIpsBtn, "copy ips", "copied!", md);
    appendLog("ok", "Copied addressing table (" + rows.length + " IP row(s)) to clipboard.");
  }

  function handleCliCommand(raw) {
    var trimmed = (raw || "").trim();
    if (!trimmed) return;
    var cmd = trimmed.charAt(0) === ":" ? trimmed.slice(1).trim() : trimmed;
    var parts = cmd.split(/\s+/);
    var verb = (parts[0] || "").toLowerCase();
    var arg = parts.slice(1).join(" ").trim();

    if (verb === "help" || verb === "?") {
      appendLog("sys", "Commands: start | stop | clear | refresh | wr | ips | power | config | filter [all|sys|ipc|err] | ping | status | inspect <dev> | url <endpoint> | token <secret|clear>");
    } else if (verb === "start") {
      startBridge();
    } else if (verb === "stop") {
      stopBridge();
    } else if (verb === "clear" || verb === "cls") {
      clearLogs();
    } else if (verb === "refresh" || verb === "nodes") {
      requestTelemetry(true);
      appendLog("sys", "Refreshed live Packet Tracer workspace telemetry.");
    } else if (verb === "wr" || verb === "save") {
      runSaveAllConfigs();
    } else if (verb === "ips") {
      copyAddressingTable();
    } else if (verb === "power") {
      runPowerOnAll();
    } else if (verb === "config") {
      toggleConfigDrawer();
    } else if (verb === "inspect" && arg) {
      var list = latestLabData && latestLabData.devices ? latestLabData.devices : [];
      var target = null;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].name).toLowerCase() === arg.toLowerCase()) {
          target = list[i];
          break;
        }
      }
      if (target) inspectNodeToStream(target);
      else appendLog("err", "Device '" + arg + "' not found in latest PT snapshot.");
    } else if (verb === "filter") {
      var f = arg.toLowerCase();
      if (f === "all" || f === "sys" || f === "ipc" || f === "err") {
        setFilter(f);
        appendLog("sys", "Stream filter set to " + f.toUpperCase());
      } else {
        appendLog("err", "Unknown filter '" + arg + "'. Expected: all, sys, ipc, err");
      }
    } else if (verb === "status") {
      var topoInfo = latestLabData
        ? latestLabData.totalDevices + " nodes / " + latestLabData.links + " links (" + latestLabData.pktName + ")"
        : "no PT snapshot";
      appendLog(
        "sys",
        "State=" + (running ? (wasConnected ? "connected" : "waiting") : "stopped") +
          " | agent=" + (activeAgent || "none") +
          " | lab=" + topoInfo +
          " | cmds=" + commandCount + " (ok=" + okCount + ", err=" + errCount + ")"
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

  if (wrAllBtn) {
    wrAllBtn.addEventListener("click", runSaveAllConfigs);
  }

  if (copyIpsBtn) {
    copyIpsBtn.addEventListener("click", copyAddressingTable);
  }

  if (powerOnBtn) {
    powerOnBtn.addEventListener("click", runPowerOnAll);
  }

  if (configToggleBtn) {
    configToggleBtn.addEventListener("click", function () {
      toggleConfigDrawer();
    });
  }

  if (refreshTopoBtn) {
    refreshTopoBtn.addEventListener("click", function () {
      requestTelemetry(true);
      appendLog("sys", "Refreshed live Packet Tracer lab telemetry.");
    });
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
    } else if (k === "r") {
      requestTelemetry(true);
    } else if (k === "u") {
      ev.preventDefault();
      toggleConfigDrawer(true);
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
  updateUptime();
  setInterval(updateUptime, 1000);
  requestTelemetry(true);
  setInterval(function () {
    requestTelemetry(false);
  }, TELEMETRY_POLL_MS);
  setFilter("all");
  setProtocol("none");
  setStatus("waiting", "Waiting for client...", "Awaiting Bridge");
  appendLog("sys", "stu-pt-bridge monitor initialized.");
  appendLog("auth", getToken() ? "STU_PT_BRIDGE_TOKEN loaded from field." : "STU_PT_BRIDGE_TOKEN unset — local loopback mode.");
  detectAndStart();
})();
