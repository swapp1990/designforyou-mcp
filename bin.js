#!/usr/bin/env node
// designforyou-mcp — stdio→remote shim for the DesignForYou MCP server.
//
// MCP clients that only speak stdio (and npm-based directory crawlers) can't
// talk to a remote streamable-HTTP endpoint directly. This wrapper execs the
// standard `mcp-remote` proxy pointed at the DesignForYou endpoint, so
// `npx designforyou-mcp` bridges stdio ↔ the hosted server (OAuth handled by
// mcp-remote on the first paid call). Any extra args are passed through
// (e.g. `--transport sse-only`, `--debug`).
"use strict";

const { spawn } = require("node:child_process");

const ENDPOINT = "https://designforyou.swapp1990.org/mcp/v2/";

if (process.env.DESIGNFORYOU_PROVIDER === "grok-subscription") {
  // Explicit opt-in only. The normal invocation below remains the hosted
  // DesignForYou OAuth proxy and is intentionally unchanged.
  require("./local-provider").startLocalServer();
} else {

// Resolve mcp-remote's CLI entry from our own dependency so we don't depend on
// a global install or a second npx download.
const proxyBin = require.resolve("mcp-remote/dist/proxy.js");

const args = [proxyBin, ENDPOINT, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 0 : code);
});

// Forward termination signals so the proxy shuts down cleanly (and OAuth
// callback servers/ports are released) when the client kills us.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
}
