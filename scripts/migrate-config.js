#!/usr/bin/env node
//
// Migrate user config: add missing top-level keys from defaults.
// Usage: node migrate-config.js <config-path> <defaults-path>
// Outputs added key names (one per line) for the caller to display.
//

const fs = require("fs");

const configPath = process.argv[2];
const defaultsPath = process.argv[3];
if (!configPath || !defaultsPath) process.exit(0);
if (!fs.existsSync(configPath) || !fs.existsSync(defaultsPath)) process.exit(0);

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));

const added = [];
for (const key of Object.keys(defaults)) {
  if (!(key in config)) {
    config[key] = defaults[key];
    added.push(key);
  }
}

if (added.length > 0) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n");
  added.forEach((k) => console.log(k));
}
