"use strict";
/**
 * Nexora AI — static file serving with traversal protection.
 * Only files under public/ are ever served. config/ and data/ are not reachable.
 */
const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

/**
 * Set by the server when responses are served behind HTTPS (public
 * deployments). Adds HSTS so browsers refuse to downgrade to plain HTTP.
 */
let secureMode = false;
function setSecure(on) {
  secureMode = !!on;
}

function send(res, status, body, type, extraHeaders) {
  const headers = Object.assign(
    {
      "Content-Type": type || "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      "Cache-Control": "no-cache"
    },
    secureMode ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {},
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj, extraHeaders) {
  send(res, status, JSON.stringify(obj) + "\n", "application/json; charset=utf-8", extraHeaders);
}

/**
 * Serve a request path from public/. Returns true when a response was written.
 */
function serve(req, res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_e) {
    sendJson(res, 400, { error: "Malformed path." });
    return true;
  }
  if (decoded.includes("\0")) {
    sendJson(res, 400, { error: "Malformed path." });
    return true;
  }

  // Normalize, then verify the resolved file is inside public/.
  const rel = path.normalize(decoded).replace(/^([/\\])+/, "");
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: "Forbidden." });
    return true;
  }

  let target = resolved;
  if (target === PUBLIC_DIR || decoded === "/" || decoded === "") {
    target = path.join(PUBLIC_DIR, "index.html");
  }

  let stat;
  try {
    stat = fs.statSync(target);
    if (stat.isDirectory()) target = path.join(target, "index.html");
    stat = fs.statSync(target);
  } catch (_e) {
    sendJson(res, 404, { error: "Not found." });
    return true;
  }

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  try {
    const data = fs.readFileSync(target);
    send(res, 200, data, type, { "Content-Length": String(data.length) });
  } catch (err) {
    sendJson(res, 500, { error: "Could not read file." });
  }
  return true;
}

module.exports = { serve, send, sendJson, setSecure, PUBLIC_DIR, MIME };
