#!/usr/bin/env node
"use strict";
// Registers the installed snapshot's state server as the user-scope `state-manager` MCP server
// through `claude mcp`. Builtins only; it never writes ~/.claude.json itself.
//   node install-mcp.js --home <HOME>
// Exit 0 when the entry is registered or already matches; exit 1, naming the cause, otherwise.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const NAME = "state-manager";
const NEEDED = ["@modelcontextprotocol/sdk/server/mcp.js", "zod"];

function fail(message) {
  process.stderr.write(`install-mcp: ${message}\n`);
  process.exit(1);
}

/** The snapshot can serve only when each module resolves through its own node_modules link. */
function checkServes(server) {
  const scripts = path.dirname(server);
  const link = path.join(path.dirname(scripts), "node_modules");
  let tree = null;
  try {
    tree = fs.realpathSync(link);
  } catch {
    /* reported with the first module below */
  }
  for (const mod of NEEDED) {
    let resolved = null;
    try {
      resolved = fs.realpathSync(require.resolve(mod, { paths: [scripts] }));
    } catch {
      /* not found */
    }
    if (!resolved || !tree || !resolved.startsWith(tree + path.sep)) {
      fail(`cannot resolve ${mod} through ${link}; the snapshot has no usable node_modules link (run ./install.sh)`);
    }
  }
}

function readEntry(file) {
  if (!fs.existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${file} is not valid JSON (${e.message}); fix or move it aside, then re-run`);
  }
  const servers = doc && typeof doc === "object" ? doc.mcpServers : null;
  return servers && typeof servers === "object" && servers[NAME] ? servers[NAME] : null;
}

function matches(entry, command, args) {
  const env = entry.env === undefined ? {} : entry.env;
  return (entry.type === undefined || entry.type === "stdio") && entry.command === command &&
    JSON.stringify(entry.args) === JSON.stringify(args) && env !== null && typeof env === "object" && Object.keys(env).length === 0;
}

function claude(args, manual) {
  const r = spawnSync("claude", args, { encoding: "utf8", env: process.env });
  if (r.error) fail(`claude could not run (${r.error.message}); register by hand: ${manual}`);
  if (r.status !== 0) fail(`claude ${args.join(" ")} exited ${r.status}\n${(r.stderr || "").trim()}`);
}

function main(argv) {
  const i = argv.indexOf("--home");
  const home = i >= 0 ? argv[i + 1] : undefined;
  if (!home) fail("usage: install-mcp.js --home <home>");
  const bin = path.join(home, ".agents", "bin");
  const node = path.join(bin, "node");
  const server = path.join(bin, "current", "scripts", "state-server.js");
  const manual = `claude mcp add --scope user ${NAME} ${node} ${server}`;

  if (!fs.existsSync(server)) fail(`${server} is missing; run ./install.sh`);
  checkServes(server);

  const entry = readEntry(path.join(home, ".claude.json"));
  if (entry && matches(entry, node, [server])) {
    process.stdout.write(`${NAME}: registered (unchanged)\n`);
    return;
  }
  if (entry) claude(["mcp", "remove", "--scope", "user", NAME], manual);
  claude(["mcp", "add", "--scope", "user", NAME, node, server], manual);
  process.stdout.write(`${NAME}: registered\n`);
}

main(process.argv.slice(2));
