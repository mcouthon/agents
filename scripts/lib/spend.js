"use strict";

const fs = require("fs");
const path = require("path");

/**
 * The month's spend against the configured cap — an estimate the engine can
 * always derive locally: the current UTC month's assistant-record usage
 * tokens, summed per model over every transcript under the transcripts root
 * and priced by the config's own per-model table (a model the table does not
 * price stays visible by name and out of the figure). It is an estimate of
 * the capped surface, never the bill: pricing drift, cache mixes and service
 * tiers differ, and the provider's own figure is not engine-readable — a
 * warn needs runway, not reconciliation.
 *
 * The ledger is one machine-wide file beside the engine's database, kept by
 * the watcher's tick. The first refresh under a configured cap pays a
 * one-time full pass over every current-month transcript (measured ~60 s for
 * a few thousand files; launchd never overlaps a StartInterval tick, so the
 * pass rides the interval); later ticks stat-walk and re-read only the files
 * whose (mtime, size) moved. A vanished transcript's memo stays — retention
 * pruning a file must never uncount its spend. A month rollover resets the
 * whole ledger (the figure is the current month's). A throw escapes to the
 * caller, whose tick contains it — the refresh can never cost a home its
 * beat.
 */

// A bursty first day must not project a cap trip from one day's rate; under
// three elapsed days only the percentage threshold can warn.
const PACE_GUARD_DAYS = 3;

const monthKeyOf = (ms) => new Date(ms).toISOString().slice(0, 7);

function monthStartMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextMonthStartMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** The ledger's path: beside the engine's database, so every root override carries it into fixtures. */
function ledgerPath() {
  return path.join(path.dirname(require("./db").dbPath()), "spend-ledger.json");
}

function readLedgerFile(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function writeLedgerFile(p, ledger) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger) + "\n");
  fs.renameSync(tmp, p);
}

const numOr0 = (n) => {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
};

/**
 * One transcript's current-month token sums: assistant records deduped by
 * message id (last occurrence wins — the harness can write one record more
 * than once), bucketed by each record's own timestamp. Unparseable lines (a
 * live session's torn last line) are skipped and counted, never thrown.
 */
function scanFile(file, st, monthStart) {
  const byId = new Map();
  let skipped = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { skipped += 1; continue; }
    if (!row || row.type !== "assistant" || !row.message) continue;
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts) || ts < monthStart) continue;
    const { id, model, usage } = row.message;
    if (typeof id !== "string" || !id || typeof model !== "string" || !model) continue;
    if (!usage || typeof usage !== "object") continue;
    const cc = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : {};
    byId.set(id, {
      model,
      in: numOr0(usage.input_tokens),
      cr: numOr0(usage.cache_read_input_tokens),
      c5: numOr0(cc.ephemeral_5m_input_tokens),
      c1: numOr0(cc.ephemeral_1h_input_tokens),
      out: numOr0(usage.output_tokens),
    });
  }
  const models = {};
  for (const rec of byId.values()) {
    const m = models[rec.model] || (models[rec.model] = { in: 0, cr: 0, c5: 0, c1: 0, out: 0 });
    m.in += rec.in; m.cr += rec.cr; m.c5 += rec.c5; m.c1 += rec.c1; m.out += rec.out;
  }
  return { mtimeMs: st.mtimeMs, size: st.size, skipped, models };
}

/**
 * The incremental refresh: walk the transcripts root, and for every file
 * touched this month whose (mtime, size) moved since its memo, re-read it
 * whole and replace the memo with the current month's sums. Unchanged files
 * cost a stat; files older than the month start are skipped whole (they
 * cannot gain current-month records without an mtime bump); a vanished
 * file's memo stays. Writes only when something moved. The root is a
 * parameter — no path in here names a harness.
 */
function refreshLedger({ root, ledgerPath, nowMs = Date.now() }) {
  if (!root || !fs.existsSync(root)) return; // no transcripts root: nothing to count, no ledger
  const month = monthKeyOf(nowMs);
  const monthStart = monthStartMs(nowMs);
  const prior = readLedgerFile(ledgerPath);
  const sameMonth = Boolean(prior && prior.month === month && prior.files && typeof prior.files === "object");
  const files = sameMonth ? prior.files : {};
  let changed = !sameMonth;
  const dirs = [root];
  while (dirs.length > 0) {
    const dir = dirs.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { dirs.push(p); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; } // vanished between the readdir and here
      if (st.mtimeMs < monthStart) continue;
      const memo = files[p];
      if (memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size) continue;
      files[p] = scanFile(p, st, monthStart);
      changed = true;
    }
  }
  if (!changed) return;
  writeLedgerFile(ledgerPath, { month, refreshedAt: new Date(nowMs).toISOString(), files });
}

/**
 * The month's fact both surfaces read — null (and therefore silent) with no
 * cap configured, no ledger, a stale-month ledger, or no current-month
 * records. Prices come from the config's table; models it does not price are
 * named, never smoothed into the figure. `coming` fires over the cap, on the
 * warn threshold, or on the pace projection (past the guard, the cap trips
 * before month end) — `because` names which.
 */
function readMonth({ ledgerPath, config, nowMs = Date.now() }) {
  const spend = (config && config.spend) || null;
  const cap = spend ? Number(spend.cap_usd) : NaN;
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const prices = spend.prices_per_mtok && typeof spend.prices_per_mtok === "object"
    ? spend.prices_per_mtok : {};
  const warnPct = numOr0(spend.warn_pct) || 80;
  const ledger = readLedgerFile(ledgerPath);
  if (!ledger || ledger.month !== monthKeyOf(nowMs) || !ledger.files || typeof ledger.files !== "object") return null;
  const models = {};
  for (const memo of Object.values(ledger.files)) {
    if (!memo || !memo.models || typeof memo.models !== "object") continue;
    for (const [name, t] of Object.entries(memo.models)) {
      const m = models[name] || (models[name] = { in: 0, cr: 0, c5: 0, c1: 0, out: 0 });
      m.in += numOr0(t.in); m.cr += numOr0(t.cr); m.c5 += numOr0(t.c5); m.c1 += numOr0(t.c1); m.out += numOr0(t.out);
    }
  }
  if (Object.keys(models).length === 0) return null;
  let usd = 0;
  const unpricedModels = [];
  for (const [name, t] of Object.entries(models)) {
    const p = prices[name];
    if (!p) { unpricedModels.push(name); continue; }
    usd += (t.in * numOr0(p.input) + t.cr * numOr0(p.cache_read) + t.c5 * numOr0(p.cache_write_5m)
      + t.c1 * numOr0(p.cache_write_1h) + t.out * numOr0(p.output)) / 1e6;
  }
  unpricedModels.sort();
  const monthStart = monthStartMs(nowMs);
  const elapsedDays = (nowMs - monthStart) / 86400000;
  const daysLeftInMonth = (nextMonthStartMs(nowMs) - nowMs) / 86400000;
  const pct = (usd * 100) / cap;
  const ratePerDay = elapsedDays > 0 ? usd / elapsedDays : null;
  const daysToCap = ratePerDay !== null && ratePerDay > 0 ? (cap - usd) / ratePerDay : null;
  const over = usd >= cap;
  const byPct = pct >= warnPct;
  const byPace = elapsedDays >= PACE_GUARD_DAYS && daysToCap !== null && daysToCap <= daysLeftInMonth;
  return {
    month: ledger.month,
    usd,
    cap,
    pct,
    ratePerDay,
    daysToCap,
    daysLeftInMonth,
    coming: over || byPct || byPace,
    because: over ? "over" : byPct ? "pct" : byPace ? "pace" : null,
    unpricedModels,
    refreshedAt: typeof ledger.refreshedAt === "string" ? ledger.refreshedAt : null,
  };
}

module.exports = { refreshLedger, readMonth, ledgerPath };
