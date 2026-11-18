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
