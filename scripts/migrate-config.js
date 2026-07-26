#!/usr/bin/env node
//
// Migrate user config: backfill missing keys from defaults, recursively.
// Usage: node migrate-config.js <config-path> <defaults-path>
// Outputs added key paths (dot-notation, one per line) for the caller to display.
//
// Merge rules (never overwrite anything the user has already set):
// - Key absent from the user config at any nesting level -> copied whole from
//   defaults and recorded as added (dot-notation path, e.g. "agentTools.cc.explorer").
// - Key present in both as plain objects -> recurse into it so nested keys added
//   in a later `defaults/config.json` (e.g. a new agent grant) get backfilled into
//   configs that already have the parent key, without touching sibling keys the
//   user customized.
// - Key present in both as arrays -> the user's array wins if non-empty (arrays are
//   treated as a deliberate, fully-specified list once the user has populated one).
//   An empty array is treated the same as "not yet configured" and backfilled from
//   defaults, since `[]` in a shipped default (e.g. `defaultTools.cc`) commonly
//   just means "nothing pre-wired yet", not "explicitly cleared by the user".
// - Key present in both as anything else (scalar, or a type mismatch between user
//   and default) -> left untouched; the user's value always wins.
// - `__proto__` / `constructor` / `prototype` keys are always skipped (prototype-
//   pollution guard) regardless of what defaults/config.json contains.
//

const fs = require("fs");

const configPath = process.argv[2];
const defaultsPath = process.argv[3];
if (!configPath || !defaultsPath) process.exit(0);
if (!fs.existsSync(configPath) || !fs.existsSync(defaultsPath)) process.exit(0);

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively backfill keys present in `defaultsObj` but absent from
 * `targetObj`, mutating `targetObj` in place. Records each backfilled key's
 * dot-notation path in `added`. Never overwrites a key the user already set.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function mergeMissing(targetObj, defaultsObj, pathPrefix, added) {
  for (const key of Object.keys(defaultsObj)) {
    if (UNSAFE_KEYS.has(key)) continue;

    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const defaultVal = defaultsObj[key];

    if (!Object.prototype.hasOwnProperty.call(targetObj, key)) {
      targetObj[key] = defaultVal;
      added.push(path);
      continue;
    }

    const userVal = targetObj[key];

    if (isPlainObject(userVal) && isPlainObject(defaultVal)) {
      mergeMissing(userVal, defaultVal, path, added);
    } else if (Array.isArray(userVal) && Array.isArray(defaultVal)) {
      if (userVal.length === 0 && defaultVal.length > 0) {
        targetObj[key] = defaultVal;
        added.push(path);
      }
    }
    // Scalars and type mismatches: the user's existing value always wins.
  }
}

const added = [];
mergeMissing(config, defaults, "", added);

if (added.length > 0) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n");
  added.forEach((k) => console.log(k));
}
