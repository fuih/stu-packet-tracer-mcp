/**
 * Student MCP Bridge — Packet Tracer 9 Script Engine entry point (main.js)
 *
 * Runs inside Packet Tracer's QtScript/JavaScript Script Engine where `ipc`,
 * `scriptEngine`, and `gui` globals are available. Opens the WebView UI panel
 * (`index.html`) and exposes `runEnvelope` and `runCode` so the WebView can
 * execute commands sent by `stu-packet-tracer-mcp`.
 */

var stuWebView = null;

function main() {
  openBridgeWindow();
}

function cleanUp() {
  if (stuWebView) {
    try {
      stuWebView.close();
    } catch (e) {
      // Ignore cleanup errors during PT shutdown
    }
    stuWebView = null;
  }
}

function openBridgeWindow() {
  var wv = null;
  var uiUrl = "this-sm:index.html";
  try {
    if (typeof webViewManager !== "undefined" && webViewManager && typeof webViewManager.createWebView === "function") {
      wv = webViewManager.createWebView("Student MCP Bridge", uiUrl, 780, 680);
    } else if (
      typeof ipc !== "undefined" &&
      ipc &&
      typeof ipc.appWindow === "function" &&
      ipc.appWindow() &&
      typeof ipc.appWindow().getWebViewManager === "function"
    ) {
      var mgr = ipc.appWindow().getWebViewManager();
      if (mgr && typeof mgr.createWebView === "function") {
        wv = mgr.createWebView("Student MCP Bridge", uiUrl, 780, 680);
      }
    } else if (typeof gui !== "undefined" && gui && typeof gui.createWebView === "function") {
      wv = gui.createWebView("Student MCP Bridge", uiUrl, 780, 680);
    } else if (typeof window !== "undefined" && window.webview) {
      wv = window.webview;
    }
  } catch (err) {
    if (typeof print === "function") {
      print("[stu-mcp-bridge] Failed to open WebView: " + String(err));
    }
  }

  if (wv) {
    stuWebView = wv;
    if (typeof stuWebView.show === "function") {
      stuWebView.show();
    }
  } else if (typeof print === "function") {
    print("[stu-mcp-bridge] Warning: no WebView manager API found in this Packet Tracer build.");
  }
}

function getActiveWebView() {
  if (stuWebView) return stuWebView;
  if (typeof window !== "undefined" && window.webview) return window.webview;
  return null;
}

function classifyDeviceRole(cls, model) {
  var c = String(cls || "").toLowerCase();
  var m = String(model || "").toUpperCase();
  if (c.indexOf("router") >= 0) return "router";
  if (c.indexOf("switch") >= 0 || /2960|3560|3650|2950|IE-3400|IE-9320|SWITCH/.test(m)) return "switch";
  if (c === "pc" || c === "laptop" || c === "server" || /PC|LAPTOP|SERVER/.test(m)) return "endpoint";
  return "other";
}

/**
 * Snapshot lightweight live Packet Tracer workspace telemetry (open .pkt name,
 * device/link/power counts, simulation state, and per-node summaries) for Panel 1.
 */
function getLabTelemetry() {
  var pktName = "unsaved.pkt";
  var simPlaying = false;
  var devices = [];
  var routers = 0;
  var switches = 0;
  var endpoints = 0;
  var other = 0;
  var poweredOff = 0;
  var unwired = 0;
  var linkedPorts = 0;

  try {
    var aw = ipc.appWindow();
    if (aw) {
      try {
        var nf = aw.getActiveFile();
        if (nf && typeof nf.getSavedFilename === "function") {
          var saved = String(nf.getSavedFilename() || "").trim();
          if (saved) pktName = saved.replace(/^.*[\\\/]/, "");
        }
      } catch (e1) {}
      try {
        var sp = aw.getSimulationPanel();
        if (sp && typeof sp.isPlaying === "function") {
          simPlaying = !!sp.isPlaying();
        }
      } catch (e2) {}
    }
  } catch (e0) {}

  try {
    var net = ipc.network();
    var n = net ? net.getDeviceCount() : 0;
    for (var i = 0; i < n; i++) {
      var d = net.getDeviceAt(i);
      if (!d) continue;
      var model = "";
      try { model = String(d.getModel() || ""); } catch (em) {}
      if (model === "Power Distribution Device") continue;

      var name = "";
      var cls = "";
      var powered = true;
      try { name = String(d.getName() || ""); } catch (errName) {}
      try { cls = String(d.getClassName() || ""); } catch (ec) {}
      try { powered = !!d.getPower(); } catch (ep) {}

      var role = classifyDeviceRole(cls, model);
      if (role === "router") routers++;
      else if (role === "switch") switches++;
      else if (role === "endpoint") endpoints++;
      else other++;
      if (!powered) poweredOff++;

      var portCount = 0;
      try { portCount = Number(d.getPortCount()) || 0; } catch (epc) {}
      var devGateway = "";
      try { devGateway = String(d.getDefaultGateway() || ""); } catch (egw) {}
      if (devGateway === "0.0.0.0") devGateway = "";
      var devLinked = 0;
      var primaryIp = "";
      var ports = [];
      for (var j = 0; j < portCount; j++) {
        var p = null;
        try { p = d.getPortAt(j); } catch (egetp) {}
        if (!p) continue;
        var pName = "";
        var pIp = "";
        var pMask = "";
        var pLink = null;
        try { pName = String(p.getName() || ""); } catch (epn) {}
        try { pIp = String(p.getIpAddress() || ""); } catch (epi) {}
        try { pLink = p.getLink(); } catch (epl) {}
        if (!devGateway && typeof p.getDefaultGateway === "function") {
          try {
            var pgw = String(p.getDefaultGateway() || "");
            if (pgw && pgw !== "0.0.0.0") devGateway = pgw;
          } catch (epgw) {}
        }
        var isLinked = !!pLink;
        if (isLinked) {
          devLinked++;
          linkedPorts++;
        }
        if (pIp && pIp !== "0.0.0.0" && pIp !== "255.255.255.255") {
          try { pMask = String(p.getSubnetMask() || ""); } catch (epm) {}
          if (pMask === "0.0.0.0") pMask = "";
          if (!primaryIp) primaryIp = pIp;
          ports.push({ name: pName, ip: pIp, mask: pMask, linked: isLinked });
        } else if (isLinked) {
          ports.push({ name: pName, ip: "", mask: "", linked: true });
        }
      }
      if (devLinked === 0) unwired++;

      devices.push({
        name: name,
        model: model,
        role: role,
        powered: powered,
        gateway: devGateway,
        linkedCount: devLinked,
        portCount: portCount,
        primaryIp: primaryIp,
        ports: ports
      });
    }
  } catch (enet) {}

  var payload = {
    pktName: pktName,
    simPlaying: simPlaying,
    totalDevices: devices.length,
    routers: routers,
    switches: switches,
    endpoints: endpoints,
    other: other,
    links: Math.floor(linkedPorts / 2),
    poweredOff: poweredOff,
    unwired: unwired,
    devices: devices
  };

  var wv = getActiveWebView();
  if (wv && typeof wv.evaluateJavaScriptAsync === "function") {
    wv.evaluateJavaScriptAsync(
      "window.__stuLabTelemetry && window.__stuLabTelemetry(" + JSON.stringify(payload) + ");"
    );
  }
  return JSON.stringify(payload);
}

/**
 * Persist running-config to startup-config (`write memory`) on every powered-on
 * router and switch in the active workspace.
 */
function saveAllConfigs() {
  var saved = [];
  var skipped = [];
  try {
    var net = ipc.network();
    var n = net ? net.getDeviceCount() : 0;
    for (var i = 0; i < n; i++) {
      var d = net.getDeviceAt(i);
      if (!d) continue;
      var model = "";
      try { model = String(d.getModel() || ""); } catch (errModel) {}
      if (model === "Power Distribution Device") continue;

      var name = "";
      var cls = "";
      var powered = true;
      try { name = String(d.getName() || ""); } catch (errName) {}
      try { cls = String(d.getClassName() || ""); } catch (errCls) {}
      try { powered = !!d.getPower(); } catch (errPwr) {}

      var role = classifyDeviceRole(cls, model);
      if (role !== "router" && role !== "switch") continue;
      if (!powered) {
        skipped.push(name + " (off)");
        continue;
      }

      var cl = null;
      try { cl = d.getCommandLine(); } catch (errCli) {}
      if (!cl) {
        skipped.push(name + " (no CLI)");
        continue;
      }

      try {
        var mode = "";
        try { mode = String(cl.getMode() || ""); } catch (errMode) {}
        if (/config/i.test(mode)) cl.enterCommand("end");
        cl.enterCommand("write memory");
        saved.push(name);
      } catch (errWr) {
        skipped.push(name + " (error)");
      }
    }
  } catch (errNet) {}

  var result = { action: "wr_all", saved: saved, skipped: skipped };
  var wv = getActiveWebView();
  if (wv && typeof wv.evaluateJavaScriptAsync === "function") {
    wv.evaluateJavaScriptAsync(
      "window.__stuActionResult && window.__stuActionResult(" + JSON.stringify(result) + ");"
    );
  }
  return JSON.stringify(result);
}

/**
 * Power on every powered-off device in the active Packet Tracer workspace
 * and push an immediate telemetry refresh to the monitor window.
 */
function powerOnAll() {
  var powered = [];
  try {
    var net = ipc.network();
    var n = net ? net.getDeviceCount() : 0;
    for (var i = 0; i < n; i++) {
      var d = net.getDeviceAt(i);
      if (!d) continue;
      var model = "";
      try { model = String(d.getModel() || ""); } catch (errModel) {}
      if (model === "Power Distribution Device") continue;

      var isOn = true;
      try { isOn = !!d.getPower(); } catch (errPwr) {}
      if (isOn) continue;

      var name = "";
      try { name = String(d.getName() || ""); } catch (errName) {}
      try {
        d.setPower(true);
        try { d.skipBoot(); } catch (errBoot) {}
        powered.push(name || ("device-" + i));
      } catch (errSet) {}
    }
  } catch (errNet) {}

  var result = { action: "power_on", powered: powered };
  var wv = getActiveWebView();
  if (wv && typeof wv.evaluateJavaScriptAsync === "function") {
    wv.evaluateJavaScriptAsync(
      "window.__stuActionResult && window.__stuActionResult(" + JSON.stringify(result) + ");"
    );
  }
  getLabTelemetry();
  return JSON.stringify(result);
}

/**
 * Bridge Protocol v1 execution entry point.
 * Called from the WebView via `$se('runEnvelope', id, code)`.
 * Evaluates `code` synchronously in the Script Engine and delivers a JSON
 * ResultEnvelope back to the WebView via `window.__stuBridgeResult(...)`.
 */
function runEnvelope(id, code) {
  var start = Date.now();
  var payload;
  try {
    var result = eval(code);
    var dataStr = result === undefined || result === null ? "OK" : String(result);
    payload = {
      id: String(id),
      ok: true,
      data: dataStr,
      elapsedMs: Date.now() - start
    };
  } catch (err) {
    payload = {
      id: String(id),
      ok: false,
      error: "ERROR:" + String(err && err.message ? err.message : err),
      elapsedMs: Date.now() - start
    };
  }

  var wv = getActiveWebView();
  if (wv && typeof wv.evaluateJavaScriptAsync === "function") {
    wv.evaluateJavaScriptAsync(
      "window.__stuBridgeResult && window.__stuBridgeResult(" + JSON.stringify(payload) + ");"
    );
  }
  return JSON.stringify(payload);
}

/**
 * Legacy execution entry point (`$se('runCode', code)`).
 * Kept for compatibility with older servers and the paste-in bootstrap.
 */
function runCode(code) {
  try {
    return eval(code);
  } catch (err) {
    return "ERROR:" + String(err && err.message ? err.message : err);
  }
}

function toHexString(str) {
  var s = String(str);
  var hex = "";
  for (var i = 0; i < s.length; i++) {
    var h = s.charCodeAt(i).toString(16);
    if (h.length < 2) h = "0" + h;
    hex += h;
  }
  return hex;
}

/**
 * Legacy `__mcpEval(code, port)` helper used by older `/next` polling servers.
 */
function __mcpEval(code, port) {
  var out;
  try {
    var res = eval(code);
    out = res === undefined || res === null ? "OK" : String(res);
  } catch (err) {
    out = "ERROR:" + String(err && err.message ? err.message : err);
  }
  var hex = toHexString(out);
  var wv = getActiveWebView();
  if (wv && typeof wv.evaluateJavaScriptAsync === "function") {
    var url = "http://127.0.0.1:" + port + "/result";
    wv.evaluateJavaScriptAsync(
      "(function(){var x=new XMLHttpRequest();x.open('POST'," +
        JSON.stringify(url) +
        ",true);x.send(" +
        JSON.stringify(hex) +
        ");})();"
    );
  }
  return out;
}
