#!/usr/bin/env node
// The state server's code-index tools (code_index_status, code_index_build), driven over JSON-RPC
// stdio against real temp git repos and a scratch $AGENTS_CONFIG_PATH. The engine tools are in
// test-mcp-adapter.js.
//
// Run: node scripts/test-state-server.js
// Exit 0 = pass, exit 1 = fail.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const os = require("os");

// Isolate the session registry and tasks root to tmpdirs so this test never writes to the
// real ~/.agents. Spawned state-server processes inherit them.
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-state-sessions-"));
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-state-tasks-"));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-state-test-"));


// ---------------------------------------------------------------------------
// Fresh-subprocess session helper (for precedence / auto-derive tests)
//
// The long-lived server above cannot have its process.env mutated post-spawn,
// so precedence tests that depend on env must each run in a FRESH subprocess
// with its own spawn-time env. Spawns via process.execPath (absolute node path)
// so overriding the child's PATH (e.g. to remove git) does not also break
// Node's own executable lookup for the outer spawn. CLAUDE_PROJECT_DIR is
// cleared first, then re-applied from envOverrides, so an ambient developer
// value cannot hijack resolution.
//
// Runs `fn({ call })` then closes the server; resolves to the captured stderr.
// ---------------------------------------------------------------------------

async function runSession(envOverrides, fn) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.AGENTS_CONFIG_PATH;
  // Clear parent Claude session identity so the subprocess uses the test's
  // AGENTS_SESSION_ID instead of the inherited CLAUDE_CODE_SESSION_ID.
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_PID;
  delete env.AGENTS_SESSION_DIR;
  Object.assign(env, envOverrides);

  const proc = spawn(process.execPath, ["scripts/state-server.js"], {
    env,
    cwd: path.join(__dirname, ".."),
  });

  let outBuf = "";
  let stderr = "";
  const responses = [];
  proc.stdout.on("data", (chunk) => {
    outBuf += chunk.toString();
    const lines = outBuf.split("\n");
    outBuf = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        try { responses.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
      }
    }
  });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  let localId = 1;
  const waitFor = (id) =>
    new Promise((resolve) => {
      const check = () => {
        const r = responses.find((x) => x.id === id);
        if (r) resolve(r);
        else setTimeout(check, 10);
      };
      check();
    });

  const call = (name, args) => {
    const id = localId++;
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n"
    );
    return waitFor(id);
  };

  const initId = localId++;
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-runner", version: "1.0" } },
    }) + "\n"
  );
  await waitFor(initId);

  try {
    await fn({ call });
  } finally {
    proc.stdin.end();
    await new Promise((resolve) => proc.on("close", resolve));
  }
  return stderr;
}

/** True if a git >= 2.31 (supports --path-format) binary is available. */
function gitSupportsPathFormat() {
  try {
    const v = execFileSync("git", ["--version"], { encoding: "utf8" });
    const m = v.match(/(\d+)\.(\d+)/);
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 2 || (major === 2 && minor >= 31);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Code-index lifecycle test helpers (real temp dir, real git, no mocks)
// ---------------------------------------------------------------------------

/**
 * Create a fresh temp dir that is a real git repo with the given tracked
 * files (name -> content), staged via a real `git add` (no commit needed --
 * `git ls-files` shows staged files). Returns the repo dir path.
 */
function makeScratchRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-ci-repo-"));
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  const names = Object.keys(files);
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  if (names.length > 0) {
    execFileSync("git", ["-C", dir, "add", ...names], { stdio: "ignore" });
  }
  return dir;
}

/**
 * Write a scratch AGENTS config.json to a fresh temp dir, for use via
 * $AGENTS_CONFIG_PATH (never the developer's real ~/.agents/config.json).
 * Pass `null` for codeIndex to produce a config with no `code_index` section
 * (the "not configured" case). Returns the config file path.
 */
function makeScratchConfig(codeIndex) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-ci-config-"));
  const configPath = path.join(dir, "config.json");
  const content = codeIndex === null ? {} : { code_index: codeIndex };
  fs.writeFileSync(configPath, JSON.stringify(content, null, 2), "utf8");
  return configPath;
}


async function runTests() {
  let pass = true;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); pass = false; };
  const ok = (msg) => console.log(`OK: ${msg}`);

  // =========================================================================
  // Code-index lifecycle tests (real temp git repos, real $AGENTS_CONFIG_PATH
  // scratch config, real mtime bumps -- no mocked child_process/fs/git)
  // =========================================================================

  // -------------------------------------------------------------------------
  // Test CI-A: code_index_status -- missing / fresh / stale transitions
  // -------------------------------------------------------------------------
  {
    const repoDir = makeScratchRepo({ "a.js": "// code\n", "docs.md": "# docs\n" });
    const configPath = makeScratchConfig({
      build: "mkdir -p graphify-out && touch graphify-out/graph.json",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });

    await runSession({ AGENTS_CONFIG_PATH: configPath, CLAUDE_PROJECT_DIR: repoDir }, async ({ call }) => {
      // CI-A1: graph_file missing -> "missing"
      const r1 = await call("code_index_status", {});
      const t1 = r1.result?.content?.[0]?.text || "";
      if (r1.error || r1.result?.isError || !t1.startsWith("missing:")) {
        fail(`CI-A1: expected missing status, got: ${r1.error?.message || t1}`);
      } else {
        ok("CI-A1: code_index_status reports missing when graph_file absent");
      }

      // Create graph_file; set code files older than it (fresh baseline).
      const graphPath = path.join(repoDir, "graphify-out", "graph.json");
      fs.mkdirSync(path.dirname(graphPath), { recursive: true });
      fs.writeFileSync(graphPath, "{}");
      const base = Date.now();
      const older = new Date(base - 60000);
      const graphTime = new Date(base);
      const newer = new Date(base + 60000);
      fs.utimesSync(graphPath, graphTime, graphTime);
      fs.utimesSync(path.join(repoDir, "a.js"), older, older);
      fs.utimesSync(path.join(repoDir, "docs.md"), older, older);

      // CI-A2: nothing newer -> "fresh"
      const r2 = await call("code_index_status", {});
      const t2 = r2.result?.content?.[0]?.text || "";
      if (r2.error || r2.result?.isError || !t2.startsWith("fresh:")) {
        fail(`CI-A2: expected fresh status, got: ${r2.error?.message || t2}`);
      } else {
        ok("CI-A2: code_index_status reports fresh when nothing newer than graph_file");
      }

      // CI-A3: touch only a tracked .md file newer -> still "fresh" (extension excluded)
      fs.utimesSync(path.join(repoDir, "docs.md"), newer, newer);
      const r3 = await call("code_index_status", {});
      const t3 = r3.result?.content?.[0]?.text || "";
      if (r3.error || r3.result?.isError || !t3.startsWith("fresh:")) {
        fail(`CI-A3: expected fresh status (md excluded), got: ${r3.error?.message || t3}`);
      } else {
        ok("CI-A3: code_index_status stays fresh when only a non-code (.md) file is newer");
      }

      // CI-A4: touch tracked .js file newer -> "stale"
      fs.utimesSync(path.join(repoDir, "a.js"), newer, newer);
      const r4 = await call("code_index_status", {});
      const t4 = r4.result?.content?.[0]?.text || "";
      if (r4.error || r4.result?.isError || !t4.startsWith("stale:") || !t4.includes("a.js")) {
        fail(`CI-A4: expected stale status naming a.js, got: ${r4.error?.message || t4}`);
      } else {
        ok("CI-A4: code_index_status reports stale when a tracked code file is newer");
      }
    });

    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test CI-B: code_index_build -- not_configured / skip-fresh / real build /
  // non-zero-exit surfaced as error (not a crash)
  // -------------------------------------------------------------------------
  {
    const repoDir = makeScratchRepo({ "a.js": "// code\n" });
    const graphPath = path.join(repoDir, "graphify-out", "graph.json");
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, "{}");
    const graphTime = new Date();
    fs.utimesSync(graphPath, graphTime, graphTime);
    fs.utimesSync(
      path.join(repoDir, "a.js"),
      new Date(graphTime.getTime() - 60000),
      new Date(graphTime.getTime() - 60000)
    );

    // CI-B1: no code_index section -> not_configured; graph_file mtime untouched.
    const noConfigPath = makeScratchConfig(null);
    const beforeMtime1 = fs.statSync(graphPath).mtimeMs;
    await runSession({ AGENTS_CONFIG_PATH: noConfigPath, CLAUDE_PROJECT_DIR: repoDir }, async ({ call }) => {
      const r = await call("code_index_build", {});
      const t = r.result?.content?.[0]?.text || "";
      if (r.error || r.result?.isError || !t.startsWith("not_configured:")) {
        fail(`CI-B1: expected not_configured, got: ${r.error?.message || t}`);
      } else {
        ok("CI-B1: code_index_build reports not_configured when code_index section absent");
      }
    });
    const afterMtime1 = fs.statSync(graphPath).mtimeMs;
    if (afterMtime1 !== beforeMtime1) {
      fail("CI-B1: graph_file mtime changed despite not_configured (something was spawned)");
    } else {
      ok("CI-B1: graph_file mtime untouched when not_configured");
    }
    fs.rmSync(path.dirname(noConfigPath), { recursive: true, force: true });

    // CI-B2: fresh + no force -> "skipped (fresh)"; graph_file mtime untouched.
    const freshConfigPath = makeScratchConfig({
      build: "mkdir -p graphify-out && touch graphify-out/graph.json",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });
    const beforeMtime2 = fs.statSync(graphPath).mtimeMs;
    await runSession({ AGENTS_CONFIG_PATH: freshConfigPath, CLAUDE_PROJECT_DIR: repoDir }, async ({ call }) => {
      const r = await call("code_index_build", {});
      const t = r.result?.content?.[0]?.text || "";
      if (r.error || r.result?.isError || !t.startsWith("skipped (fresh)")) {
        fail(`CI-B2: expected skipped (fresh), got: ${r.error?.message || t}`);
      } else {
        ok("CI-B2: code_index_build skips the build when already fresh");
      }
    });
    const afterMtime2 = fs.statSync(graphPath).mtimeMs;
    if (afterMtime2 !== beforeMtime2) {
      fail("CI-B2: graph_file mtime changed despite fresh skip (build command ran)");
    } else {
      ok("CI-B2: graph_file mtime untouched after fresh skip");
    }
    fs.rmSync(path.dirname(freshConfigPath), { recursive: true, force: true });

    // CI-B3: stale -> build actually runs; graph_file mtime advances.
    fs.utimesSync(path.join(repoDir, "a.js"), new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    const staleConfigPath = makeScratchConfig({
      build: "touch graphify-out/graph.json",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });
    const beforeMtime3 = fs.statSync(graphPath).mtimeMs;
    await runSession({ AGENTS_CONFIG_PATH: staleConfigPath, CLAUDE_PROJECT_DIR: repoDir }, async ({ call }) => {
      const r = await call("code_index_build", {});
      const t = r.result?.content?.[0]?.text || "";
      if (r.error || r.result?.isError || !t.startsWith("built (")) {
        fail(`CI-B3: expected built(...), got: ${r.error?.message || t}`);
      } else {
        ok("CI-B3: code_index_build runs the configured build command when stale");
      }
    });
    const afterMtime3 = fs.statSync(graphPath).mtimeMs;
    if (!(afterMtime3 > beforeMtime3)) {
      fail(`CI-B3: graph_file mtime did not advance after build (before=${beforeMtime3}, after=${afterMtime3})`);
    } else {
      ok("CI-B3: graph_file mtime advances after a real build runs");
    }
    fs.rmSync(path.dirname(staleConfigPath), { recursive: true, force: true });

    // CI-B4: build command exits non-zero -> surfaced as an error response, not a crash.
    const failConfigPath = makeScratchConfig({
      build: "exit 1",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });
    await runSession({ AGENTS_CONFIG_PATH: failConfigPath, CLAUDE_PROJECT_DIR: repoDir }, async ({ call }) => {
      const r = await call("code_index_build", { force: true });
      if (!(r.error || r.result?.isError)) {
        fail("CI-B4: expected an error response for a non-zero exit build command");
      } else {
        ok("CI-B4: non-zero exit build command surfaces as an error response");
      }
      // Confirm the server is still responsive (no crash / uncaught exception).
      const r2 = await call("code_index_status", {});
      if (!r2.result && !r2.error) {
        fail("CI-B4: server appears unresponsive after a failing build command");
      } else {
        ok("CI-B4: server remains responsive after a failing build command");
      }
    });
    fs.rmSync(path.dirname(failConfigPath), { recursive: true, force: true });

    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test CI-C: security -- build command is read ONLY from $AGENTS_CONFIG_PATH;
  // a repo-local code_index/build value is never consulted.
  // -------------------------------------------------------------------------
  {
    const repoDir = makeScratchRepo({ "a.js": "// code\n" });

    // Decoy repo-local config that must NEVER be consulted.
    const decoyDir = path.join(repoDir, ".agents");
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyDir, "config.json"),
      JSON.stringify({
        code_index: { build: "touch INJECTED_MARKER.txt", graph_file: "graphify-out/graph.json" },
      }),
      "utf8"
    );

    // Trusted scratch config, pointed to via $AGENTS_CONFIG_PATH.
    const trustedConfigPath = makeScratchConfig({
      build: "mkdir -p graphify-out && touch graphify-out/graph.json",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });

    await runSession({ AGENTS_CONFIG_PATH: trustedConfigPath, CLAUDE_PROJECT_DIR: repoDir }, async ({ call }) => {
      const r = await call("code_index_build", { force: true });
      const t = r.result?.content?.[0]?.text || "";
      if (r.error || r.result?.isError || !t.startsWith("built (")) {
        fail(`CI-C: expected built(...) from the trusted config, got: ${r.error?.message || t}`);
      } else {
        ok("CI-C: code_index_build runs the trusted $AGENTS_CONFIG_PATH build command");
      }
    });

    if (fs.existsSync(path.join(repoDir, "INJECTED_MARKER.txt"))) {
      fail("CI-C: repo-local decoy code_index.build was consulted (security boundary broken)");
    } else {
      ok("CI-C: repo-local decoy config.json is never consulted");
    }
    if (!fs.existsSync(path.join(repoDir, "graphify-out", "graph.json"))) {
      fail("CI-C: trusted build command did not run");
    } else {
      ok("CI-C: trusted build command's effect (graph_file created) is present");
    }

    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(trustedConfigPath), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test CI-D: implausible project_dir warning (code_index_status and
  // code_index_build, D1) -- advisory only; resolution and the explicit-argument
  // contract are untouched. No test references the real /Users/pavelbrodsky
  // or the developer's real ~/.agents/config.json.
  // -------------------------------------------------------------------------

  // CI-D1: Regression -- the exact Finding R12 replay, hermetically.
  {
    const repoDir = makeScratchRepo({ "a.js": "// code\n" });
    const graphPath = path.join(repoDir, "graphify-out", "graph.json");
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, "{}");
    const graphTime = new Date();
    fs.utimesSync(graphPath, graphTime, graphTime);
    fs.utimesSync(
      path.join(repoDir, "a.js"),
      new Date(graphTime.getTime() - 60000),
      new Date(graphTime.getTime() - 60000)
    );
    // Stands in for $HOME: a real, existing, non-git directory.
    const bogusDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-ci-d1-bogus-"));
    const configPath = makeScratchConfig({
      build: "touch BUILT_MARKER.txt",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });

    await runSession({ AGENTS_CONFIG_PATH: configPath, CLAUDE_PROJECT_DIR: repoDir }, async ({ call }) => {
      // Call 1: implausible project_dir (stands in for $HOME).
      const r1 = await call("code_index_status", { project_dir: bogusDir });
      const t1 = r1.result?.content?.[0]?.text || "";
      if (
        r1.error || r1.result?.isError ||
        !t1.includes("warning:") || !t1.includes(bogusDir) ||
        !t1.includes(repoDir) || !t1.includes("missing:")
      ) {
        fail(`CI-D1: expected a warning naming both dirs and still "missing:", got: ${r1.error?.message || t1}`);
      } else {
        ok("CI-D1: code_index_status warns on an implausible project_dir but still answers for the path given");
      }

      // Call 2: omitted project_dir -- resolves via CLAUDE_PROJECT_DIR, no warning.
      const r2 = await call("code_index_status", {});
      const t2 = r2.result?.content?.[0]?.text || "";
      if (r2.error || r2.result?.isError || !t2.startsWith("fresh") || t2.includes("warning:")) {
        fail(`CI-D1: expected "fresh" with no warning on omitted arg, got: ${r2.error?.message || t2}`);
      } else {
        ok("CI-D1: omitting project_dir resolves via CLAUDE_PROJECT_DIR with no warning (missing -> fresh transition)");
      }
    });

    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(bogusDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }

  // CI-D2: No false positive -- a legitimate cross-repo argument is never warned about.
  {
    const repoA = makeScratchRepo({ "a.js": "// code\n" }); // no graph_file -> "missing"
    const repoB = makeScratchRepo({ "b.js": "// code\n" });
    const configPath = makeScratchConfig({
      build: "touch BUILT_MARKER.txt",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });

    await runSession({ AGENTS_CONFIG_PATH: configPath, CLAUDE_PROJECT_DIR: repoB }, async ({ call }) => {
      const r = await call("code_index_status", { project_dir: repoA });
      const t = r.result?.content?.[0]?.text || "";
      if (r.error || r.result?.isError || !t.startsWith("missing:") || t.includes("warning:")) {
        fail(`CI-D2: expected "missing:" with no warning, got: ${r.error?.message || t}`);
      } else {
        ok("CI-D2: a legitimate cross-repo project_dir argument is never warned about");
      }
    });

    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }

  // CI-D3: process.cwd() never contradicts an explicit argument (D1.2). No
  // CLAUDE_PROJECT_DIR is set; the child's cwd (this repo) IS a git repo.
  {
    const bogusDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-ci-d3-bogus-"));
    const configPath = makeScratchConfig({
      build: "touch BUILT_MARKER.txt",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });

    await runSession({ AGENTS_CONFIG_PATH: configPath }, async ({ call }) => {
      const r = await call("code_index_status", { project_dir: bogusDir });
      const t = r.result?.content?.[0]?.text || "";
      if (r.error || r.result?.isError || t.includes("warning:")) {
        fail(`CI-D3: expected no warning even though cwd is a git repo, got: ${r.error?.message || t}`);
      } else {
        ok("CI-D3: process.cwd() never contradicts an explicit project_dir (no warning without CLAUDE_PROJECT_DIR)");
      }
    });

    fs.rmSync(bogusDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test CI-E: code_index_build hard refusal (D2) -- home directory,
  // filesystem root, or outside any git repository. Every build command used
  // is harmless (`touch BUILT_MARKER.txt`).
  // -------------------------------------------------------------------------

  // CI-E1: build refused outside a git repo, with no filesystem event.
  {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-ci-e1-nongit-"));
    const repoDir = makeScratchRepo({ "a.js": "// code\n" });
    const configPath = makeScratchConfig({
      build: "touch BUILT_MARKER.txt",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });

    await runSession({ AGENTS_CONFIG_PATH: configPath, CLAUDE_PROJECT_DIR: repoDir }, async ({ call }) => {
      const r = await call("code_index_build", { project_dir: nonGitDir, force: true });
      const errText = r.error?.message || r.result?.content?.[0]?.text || "";
      if (
        !(r.error || r.result?.isError) ||
        !/refusing to run the build command/.test(errText) ||
        !errText.includes(nonGitDir)
      ) {
        fail(`CI-E1: expected a refusal naming the bogus dir, got: ${errText}`);
      } else {
        ok("CI-E1: code_index_build refuses to run outside a git repository");
      }
    });

    if (fs.existsSync(path.join(nonGitDir, "BUILT_MARKER.txt"))) {
      fail("CI-E1: build command ran despite the refusal (guard did not precede execSync)");
    } else {
      ok("CI-E1: no filesystem event occurred -- the refusal precedes execSync");
    }

    fs.rmSync(nonGitDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }

  // CI-E2: $HOME is refused even when $HOME is itself a git repo (dotfiles
  // case, D2). code_index_status against the same project_dir is unaffected
  // -- read-only is never refused.
  {
    const homeRepo = makeScratchRepo({ "a.js": "// code\n" });
    const configPath = makeScratchConfig({
      build: "touch BUILT_MARKER.txt",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });

    await runSession({ AGENTS_CONFIG_PATH: configPath, HOME: homeRepo }, async ({ call }) => {
      const r = await call("code_index_build", { project_dir: homeRepo, force: true });
      const errText = r.error?.message || r.result?.content?.[0]?.text || "";
      if (!(r.error || r.result?.isError) || !/home directory/.test(errText)) {
        fail(
          `CI-E2: expected a home-directory refusal (Node's os.homedir() should honour $HOME on ` +
          `POSIX -- if this platform disagrees, that is a real finding), got: ${errText}`
        );
      } else {
        ok("CI-E2: code_index_build refuses even when $HOME is itself a git repository");
      }

      const r2 = await call("code_index_status", { project_dir: homeRepo });
      if (r2.error || r2.result?.isError) {
        fail(`CI-E2: code_index_status should not be refused (read-only), got: ${r2.error?.message || r2.result?.content?.[0]?.text}`);
      } else {
        ok("CI-E2: code_index_status is never refused -- read-only is unaffected by the build guard");
      }
    });

    if (fs.existsSync(path.join(homeRepo, "BUILT_MARKER.txt"))) {
      fail("CI-E2: build command ran against $HOME despite the refusal");
    } else {
      ok("CI-E2: no filesystem event occurred against $HOME");
    }

    fs.rmSync(homeRepo, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }

  // CI-E3: no over-refusal -- a legitimate explicit project_dir build still works.
  {
    const repoDir = makeScratchRepo({ "a.js": "// code\n" });
    const configPath = makeScratchConfig({
      build: "touch BUILT_MARKER.txt",
      graph_file: "graphify-out/graph.json",
      code_extensions: [".js"],
    });

    await runSession({ AGENTS_CONFIG_PATH: configPath }, async ({ call }) => {
      const r = await call("code_index_build", { project_dir: repoDir, force: true });
      const t = r.result?.content?.[0]?.text || "";
      if (r.error || r.result?.isError || !t.startsWith("built (")) {
        fail(`CI-E3: expected built(...), got: ${r.error?.message || t}`);
      } else {
        ok("CI-E3: an explicit, legitimate project_dir build still runs (no over-refusal)");
      }
    });

    if (!fs.existsSync(path.join(repoDir, "BUILT_MARKER.txt"))) {
      fail("CI-E3: build command did not actually run");
    } else {
      ok("CI-E3: build command's effect (BUILT_MARKER.txt) is present");
    }

    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }


  fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.rmSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true, force: true }); } catch {}
  if (pass) {
    console.log("\nAll tests passed.");
    process.exit(0);
  } else {
    console.error("\nSome tests FAILED.");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.rmSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
