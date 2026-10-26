"use strict";

/**
 * Rewrite a verb's short flags to their long names. `shorts` maps "-t" to "--title";
 * `valueLongs` names the long flags that take the next word as their value (that word is
 * never rewritten). Stops at "--". Throws an Error with exitCode 2 on a bundle or an
 * unknown short flag.
 */
function expandShort(argv, shorts, valueLongs, verb) {
  const out = [];
  let nextIsValue = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { out.push(...argv.slice(i)); break; }
    if (nextIsValue) { out.push(arg); nextIsValue = false; continue; }
    if (arg === "-h" || !/^-[A-Za-z]/.test(arg)) {
      out.push(arg);
      if (arg.startsWith("--") && !arg.includes("=") && valueLongs.has(arg)) nextIsValue = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (name.length > 2) {
      const letters = name.slice(1).split("").map((c) => `-${c}`).join(" ");
      throw withExit(`Short flags do not combine: ${name}; write ${letters}`);
    }
    const long = shorts[name];
    if (!long) throw withExit(`Unknown flag ${name} for a ${verb}`);
    if (eq >= 0) out.push(`${long}${arg.slice(eq)}`);
    else {
      out.push(long);
      if (valueLongs.has(long)) nextIsValue = true;
    }
  }
  return out;
}

function withExit(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

module.exports = { expandShort };
