"use strict";

const assert = require("assert");
const {
  splitSegments,
  tokenizeSegment,
  findGitInvocations,
  classifyGit,
  unquote,
} = require("./lib/gitcmd");

function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("gitcmd tokeniser tests");

test("splitSegments: single command", () => {
  assert.deepStrictEqual(splitSegments("git status"), ["git status"]);
});

test("splitSegments: chained with &&", () => {
  assert.deepStrictEqual(splitSegments("git add x && git commit -m msg"), [
    "git add x",
    "git commit -m msg",
  ]);
});

test("splitSegments: chained with ;", () => {
  assert.deepStrictEqual(splitSegments("git fetch; git rebase main"), [
    "git fetch",
    "git rebase main",
  ]);
});

test("splitSegments: pipe", () => {
  assert.deepStrictEqual(splitSegments("git log | grep foo"), [
    "git log",
    "grep foo",
  ]);
});

test("splitSegments: && inside quotes is literal", () => {
  assert.deepStrictEqual(splitSegments("git commit -m 'a && b'"), [
    "git commit -m 'a && b'",
  ]);
});

test("splitSegments: | inside double quotes is literal", () => {
  assert.deepStrictEqual(splitSegments('echo "a|b" && git status'), [
    'echo "a|b"',
    "git status",
  ]);
});

test("tokenizeSegment: simple git command", () => {
  const { env, argv } = tokenizeSegment("git push origin main");
  assert.deepStrictEqual(env, {});
  assert.deepStrictEqual(argv, ["git", "push", "origin", "main"]);
});

test("tokenizeSegment: quoted args preserved", () => {
  const { argv } = tokenizeSegment('git commit -m "fix: a & b"');
  assert.deepStrictEqual(argv, ["git", "commit", "-m", '"fix: a & b"']);
});

test("tokenizeSegment: single-quoted args preserved", () => {
  const { argv } = tokenizeSegment("git commit -m 'needs work'");
  assert.deepStrictEqual(argv, ["git", "commit", "-m", "'needs work'"]);
});

test("tokenizeSegment: env-prefix assignment separated", () => {
  const { env, argv } = tokenizeSegment("AGENTS_LAND=1 git push origin main");
  assert.deepStrictEqual(env, { AGENTS_LAND: "1" });
  assert.deepStrictEqual(argv, ["git", "push", "origin", "main"]);
});

test("tokenizeSegment: multiple env-prefix assignments", () => {
  const { env, argv } = tokenizeSegment("FOO=bar BAZ=qux git status");
  assert.deepStrictEqual(env, { FOO: "bar", BAZ: "qux" });
  assert.deepStrictEqual(argv, ["git", "status"]);
});

test("tokenizeSegment: env-prefix with quoted value", () => {
  const { env, argv } = tokenizeSegment('GIT_AUTHOR="A B" git commit');
  assert.deepStrictEqual(env, { GIT_AUTHOR: "A B" });
  assert.deepStrictEqual(argv, ["git", "commit"]);
});

test("findGitInvocations: single git", () => {
  const invs = findGitInvocations("git push origin main");
  assert.strictEqual(invs.length, 1);
  assert.strictEqual(invs[0].program, "git");
  assert.deepStrictEqual(invs[0].argv, ["push", "origin", "main"]);
});

test("findGitInvocations: chained git commands", () => {
  const invs = findGitInvocations("git add x && git commit -m m && git push");
  assert.strictEqual(invs.length, 3);
  assert.strictEqual(invs[0].argv[0], "add");
  assert.strictEqual(invs[1].argv[0], "commit");
  assert.strictEqual(invs[2].argv[0], "push");
});

test("findGitInvocations: gh subcommand", () => {
  const invs = findGitInvocations("gh pr create --title t");
  assert.strictEqual(invs.length, 1);
  assert.strictEqual(invs[0].program, "gh");
  assert.deepStrictEqual(invs[0].argv, ["pr", "create", "--title", "t"]);
});

test("findGitInvocations: git with -C", () => {
  const invs = findGitInvocations("git -C /tmp/repo status");
  assert.strictEqual(invs.length, 1);
  assert.deepStrictEqual(invs[0].argv, ["-C", "/tmp/repo", "status"]);
});

test("findGitInvocations: env-prefix separated, not a grant", () => {
  const invs = findGitInvocations("AGENTS_LAND=1 git push origin main");
  assert.strictEqual(invs.length, 1);
  assert.strictEqual(invs[0].env.AGENTS_LAND, "1");
  assert.strictEqual(invs[0].program, "git");
  assert.deepStrictEqual(invs[0].argv, ["push", "origin", "main"]);
});

test("findGitInvocations: non-git commands ignored", () => {
  const invs = findGitInvocations("ls -la && echo hi && npm test");
  assert.strictEqual(invs.length, 0);
});

test("findGitInvocations: git and gh mixed", () => {
  const invs = findGitInvocations("git push origin main && gh pr create");
  assert.strictEqual(invs.length, 2);
  assert.strictEqual(invs[0].program, "git");
  assert.strictEqual(invs[1].program, "gh");
});

test("classifyGit: push to base", () => {
  const inv = { program: "git", argv: ["push", "origin", "main"] };
  const c = classifyGit(inv);
  assert.strictEqual(c.subcommand, "push");
  assert.strictEqual(c.pushRemote, "origin");
  assert.deepStrictEqual(c.pushRefSpec, ["main"]);
  assert.strictEqual(c.hasForce, false);
});

test("classifyGit: force push detected", () => {
  const inv = { program: "git", argv: ["push", "-f", "origin", "main"] };
  const c = classifyGit(inv);
  assert.strictEqual(c.hasForce, true);
});

test("classifyGit: --no-verify detected", () => {
  const inv = { program: "git", argv: ["commit", "--no-verify", "-m", "x"] };
  const c = classifyGit(inv);
  assert.strictEqual(c.hasNoVerify, true);
});

test("classifyGit: -C path detected", () => {
  const inv = { program: "git", argv: ["-C", "/tmp/repo", "status"] };
  const c = classifyGit(inv);
  assert.strictEqual(c.hasDashC, true);
  assert.strictEqual(c.dashCPath, "/tmp/repo");
});

test("classifyGit: add -A detected", () => {
  const inv = { program: "git", argv: ["add", "-A"] };
  const c = classifyGit(inv);
  assert.strictEqual(c.hasForce, true);
});

test("classifyGit: commit -a detected", () => {
  const inv = { program: "git", argv: ["commit", "-a", "-m", "x"] };
  const c = classifyGit(inv);
  assert.strictEqual(c.hasForce, true);
});

test("classifyGit: gh pr create subcommand", () => {
  const inv = { program: "gh", argv: ["pr", "create", "--title", "t"] };
  const c = classifyGit(inv);
  assert.strictEqual(c.subcommand, "pr");
});

test("unquote: strips single quotes", () => {
  assert.strictEqual(unquote("'hello'"), "hello");
});

test("unquote: strips double quotes", () => {
  assert.strictEqual(unquote('"hello"'), "hello");
});

test("unquote: no quotes unchanged", () => {
  assert.strictEqual(unquote("hello"), "hello");
});

console.log(
  `\n${process.exitCode ? "FAILED" : "PASSED"}: gitcmd tokeniser tests`
);
