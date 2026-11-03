var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  judge: () => judge,
  normaliseUrl: () => normaliseUrl,
  parseFailOn: () => parseFailOn,
  parseStrategies: () => parseStrategies,
  rowsFromActor: () => rowsFromActor,
  sitemapLocs: () => sitemapLocs
});
module.exports = __toCommonJS(main_exports);
var import_node_fs = require("node:fs");
var import_node_crypto = require("node:crypto");
var import_node_zlib = require("node:zlib");

// src/psi.ts
var PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function round(value, digits) {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
function cleanText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\u00a0/g, " ").replace(/`/g, "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}
function scoreRating(score) {
  if (score === null) return null;
  if (score >= 90) return "good";
  if (score >= 50) return "needs_improvement";
  return "poor";
}
function pickFieldData(json) {
  const page = json?.loadingExperience;
  if (page?.metrics && Object.keys(page.metrics).length > 0 && !page.origin_fallback) return { scope: "page", metrics: page.metrics };
  const origin = json?.originLoadingExperience;
  if (origin?.metrics && Object.keys(origin.metrics).length > 0) return { scope: "origin", metrics: origin.metrics };
  return { scope: null, metrics: null };
}
function assessCoreWebVitals(metrics) {
  if (!metrics) return null;
  const lcp = metrics.LARGEST_CONTENTFUL_PAINT_MS?.category;
  const cls = metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category;
  const inp = metrics.INTERACTION_TO_NEXT_PAINT?.category;
  if (!lcp || !cls) return null;
  const good = (c) => c === "FAST";
  return good(lcp) && good(cls) && (inp === void 0 || good(inp)) ? "pass" : "fail";
}
function savingsOf(audit) {
  const overall = num(audit?.details?.overallSavingsMs) ?? 0;
  const metric = audit?.metricSavings ?? {};
  return Math.max(overall, num(metric.LCP) ?? 0, num(metric.FCP) ?? 0);
}
function topOpportunities(audits, limit) {
  if (!audits || limit <= 0) return [];
  const found = [];
  for (const audit of Object.values(audits)) {
    const score = num(audit?.score);
    if (score === null || score >= 0.9) continue;
    const savingsMs = savingsOf(audit);
    if (savingsMs <= 0) continue;
    const title = cleanText(audit.title);
    if (!title) continue;
    found.push({ title, detail: cleanText(audit.displayValue), savingsMs: Math.round(savingsMs) });
  }
  return found.sort((a, b) => b.savingsMs - a.savingsMs || a.title.localeCompare(b.title)).slice(0, limit);
}
function failedAudits(lighthouse, category) {
  const refs = lighthouse?.categories?.[category]?.auditRefs ?? [];
  const out = [];
  for (const ref of refs) {
    const audit = lighthouse.audits?.[ref.id];
    if (!audit || audit.scoreDisplayMode !== "binary" || audit.score !== 0) continue;
    const title = cleanText(audit.title);
    if (title) out.push(title);
  }
  return out;
}
function sameUrl(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(u);
      return `${x.protocol}//${x.hostname.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
    } catch {
      return u.replace(/\/+$/, "").toLowerCase();
    }
  };
  return norm(a) === norm(b);
}
var VITALS = [
  { key: "LARGEST_CONTENTFUL_PAINT_MS", label: "LCP", format: (p) => `${(p / 1e3).toFixed(1)} s` },
  { key: "INTERACTION_TO_NEXT_PAINT", label: "INP", format: (p) => `${p} ms` },
  { key: "CUMULATIVE_LAYOUT_SHIFT_SCORE", label: "CLS", format: (p) => (p / 100).toFixed(2) }
];
function failingVitals(metrics) {
  if (!metrics) return [];
  const out = [];
  for (const v of VITALS) {
    const m = metrics[v.key];
    const p = num(m?.percentile);
    if (!m || p === null || m.category === "FAST") continue;
    out.push(`${v.label} ${v.format(p)} (${m.category === "SLOW" ? "poor" : "needs improvement"})`);
  }
  return out;
}
function parsePageSpeed(json, requestedUrl, categories, maxOpportunities) {
  const lr = json?.lighthouseResult ?? {};
  const audits = lr.audits ?? {};
  const scores = {};
  for (const c of ["performance", "accessibility", "best-practices", "seo"]) {
    const raw = categories.includes(c) ? num(lr.categories?.[c]?.score) : null;
    scores[c] = raw === null ? null : Math.round(raw * 100);
  }
  const labMs = (id) => num(audits[id]?.numericValue);
  const seconds = (id) => round(labMs(id) === null ? null : labMs(id) / 1e3, 2);
  const finalUrl = cleanText(lr.finalDisplayedUrl) ?? cleanText(lr.finalUrl);
  const { scope, metrics } = pickFieldData(json);
  const p75 = (key) => num(metrics?.[key]?.percentile);
  const fieldCls = p75("CUMULATIVE_LAYOUT_SHIFT_SCORE");
  const weight = labMs("total-byte-weight");
  return {
    finalUrl,
    redirected: finalUrl !== null && !sameUrl(finalUrl, requestedUrl),
    lighthouseVersion: cleanText(lr.lighthouseVersion),
    analysedAt: cleanText(json?.analysisUTCTimestamp) ?? cleanText(lr.fetchTime),
    scores,
    lab: {
      fcpSeconds: seconds("first-contentful-paint"),
      lcpSeconds: seconds("largest-contentful-paint"),
      speedIndexSeconds: seconds("speed-index"),
      tbtMs: round(labMs("total-blocking-time"), 0),
      cls: round(labMs("cumulative-layout-shift"), 3),
      serverResponseMs: round(labMs("server-response-time"), 0),
      pageWeightKb: weight === null ? null : Math.round(weight / 1024)
    },
    field: {
      scope,
      coreWebVitals: assessCoreWebVitals(metrics),
      failingVitals: failingVitals(metrics),
      lcpMs: p75("LARGEST_CONTENTFUL_PAINT_MS"),
      inpMs: p75("INTERACTION_TO_NEXT_PAINT"),
      // The Chrome UX Report sends CLS multiplied by 100.
      cls: fieldCls === null ? null : round(fieldCls / 100, 2),
      fcpMs: p75("FIRST_CONTENTFUL_PAINT_MS"),
      ttfbMs: p75("EXPERIMENTAL_TIME_TO_FIRST_BYTE")
    },
    opportunities: categories.includes("performance") ? topOpportunities(audits, maxOpportunities) : [],
    failedSeoAudits: categories.includes("seo") ? failedAudits(lr, "seo") : [],
    failedAccessibilityAudits: categories.includes("accessibility") ? failedAudits(lr, "accessibility") : [],
    runWarnings: (Array.isArray(lr.runWarnings) ? lr.runWarnings : []).map(cleanText).filter((w) => w !== null)
  };
}
function buildRequestUrl(url, strategy, categories, apiKey) {
  const q = new URLSearchParams({ url, strategy });
  for (const c of categories) q.append("category", c);
  q.set("key", apiKey);
  return `${PSI_ENDPOINT}?${q.toString()}`;
}
var ApiKeyError = class extends Error {
};
var DEFAULT_BACKOFF_MS = [5e3, 2e4];
var DEFINITELY_UNREACHABLE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_FAILED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|DNS_FAILURE|NOT_HTML/;
async function runAudit(url, strategy, categories, opts) {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? (async (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
  const requestUrl = buildRequestUrl(url, strategy, categories, opts.apiKey);
  let last = { status: "api_error", statusDetail: "No request was made.", audit: null, attempts: 0 };
  let pageFailedRetried = false;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    if (attempt > 0) {
      if (opts.stopAt !== void 0 && Date.now() + backoff[attempt - 1] + opts.timeoutMs > opts.stopAt) return last;
      await sleep(backoff[attempt - 1]);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let status;
    let body;
    try {
      const res = await opts.fetchImpl(requestUrl, { signal: controller.signal });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (e) {
      const aborted = e?.name === "AbortError" || controller.signal.aborted;
      last = {
        status: aborted ? "timeout" : "api_error",
        statusDetail: aborted ? `Google did not finish testing the page within ${Math.round(opts.timeoutMs / 1e3)} seconds. Not charged.` : `Could not reach Google PageSpeed Insights: ${e?.message ?? String(e)}. Not charged.`,
        audit: null,
        attempts: attempt + 1
      };
      continue;
    } finally {
      clearTimeout(timer);
    }
    const message = cleanText(body?.error?.message) ?? "";
    if (status >= 200 && status < 300 && body?.lighthouseResult) {
      return { status: "ok", statusDetail: null, audit: parsePageSpeed(body, url, categories, opts.maxOpportunities), attempts: attempt + 1 };
    }
    if (/api key|API_KEY|keyInvalid|has not been used in project|is disabled/i.test(message) && (status === 400 || status === 403)) {
      throw new ApiKeyError(`Google refused the PageSpeed Insights API key: ${message}`);
    }
    if (/Lighthouse returned error/i.test(message)) {
      const code = /error: ([A-Z_]+)/.exec(message)?.[1];
      const failed = {
        status: "page_failed",
        statusDetail: `Google could not load the page${code ? ` (${code})` : ""}: ${message.replace(/^Lighthouse returned error: [A-Z_]+\.?\s*/, "")} Not charged.`.slice(0, 500),
        audit: null,
        attempts: attempt + 1
      };
      if (DEFINITELY_UNREACHABLE.test(message) || pageFailedRetried || attempt >= backoff.length) return failed;
      pageFailedRetried = true;
      last = failed;
      continue;
    }
    if (status === 400) {
      return { status: "invalid_url", statusDetail: `Google rejected the URL: ${message || "HTTP 400"}. Not charged.`, audit: null, attempts: attempt + 1 };
    }
    if (status === 429) {
      last = { status: "rate_limited", statusDetail: `Google's rate limit was hit and the retries did not clear it: ${message || "HTTP 429"}. Not charged.`, audit: null, attempts: attempt + 1 };
      continue;
    }
    last = {
      status: "api_error",
      statusDetail: `Google PageSpeed Insights returned HTTP ${status}${message ? `: ${message}` : ""}. Not charged.`.slice(0, 500),
      audit: null,
      attempts: attempt + 1
    };
    if (status < 500) return last;
  }
  return last;
}

// src/main.ts
var VERSION = "1.0.0";
var ACTOR_ID = "nerolabs~bulk-pagespeed-checker";
var ACTOR_URL = "https://apify.com/nerolabs/bulk-pagespeed-checker";
var KEY_HELP = "https://developers.google.com/speed/docs/insights/v5/get-started#APIKey";
var HARD_MAX = 100;
var inActions = process.env.GITHUB_ACTIONS === "true";
function input(name, fallback = "") {
  const v = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return v === void 0 || v.trim() === "" ? fallback : v.trim();
}
function splitList(v) {
  return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
function clampInt(v, def, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== "" ? Math.min(Math.max(n, min), max) : def;
}
function parseStrategies(v) {
  const s = v.toLowerCase();
  if (s === "both") return ["mobile", "desktop"];
  return s === "desktop" ? ["desktop"] : ["mobile"];
}
function parseFailOn(v) {
  const parts = splitList(v.toLowerCase());
  if (parts.includes("none")) return [];
  if (parts.length === 0 || parts.includes("any")) return ["cwv", "score"];
  return ["cwv", "score"].filter((r) => parts.includes(r));
}
function normaliseUrl(raw) {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
function readOptions() {
  if (inActions) {
    return {
      urls: splitList(input("urls")),
      sitemap: input("sitemap") || null,
      maxUrls: clampInt(input("max-urls"), 25, 1, HARD_MAX),
      strategies: parseStrategies(input("strategy", "mobile")),
      failOn: parseFailOn(input("fail-on", "any")),
      minScore: clampInt(input("min-score"), 50, 0, 100),
      googleKey: input("google-api-key") || null,
      apifyToken: input("apify-token") || null,
      timeoutMs: clampInt(input("timeout-seconds"), 90, 20, 180) * 1e3
    };
  }
  const args = process.argv.slice(2);
  const o = {
    urls: [],
    sitemap: null,
    maxUrls: 25,
    strategies: ["mobile"],
    failOn: ["cwv", "score"],
    minScore: 50,
    googleKey: process.env.GOOGLE_API_KEY || process.env.PAGESPEED_API_KEY || null,
    apifyToken: process.env.APIFY_TOKEN || null,
    timeoutMs: 9e4
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--sitemap") o.sitemap = args[++i] ?? null;
    else if (a === "--max") o.maxUrls = clampInt(args[++i] ?? "", 25, 1, HARD_MAX);
    else if (a === "--strategy") o.strategies = parseStrategies(args[++i] ?? "mobile");
    else if (a === "--fail-on") o.failOn = parseFailOn(args[++i] ?? "any");
    else if (a === "--min-score") o.minScore = clampInt(args[++i] ?? "", 50, 0, 100);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: GOOGLE_API_KEY=... node dist/index.js <url> [url...] [--sitemap https://site/sitemap.xml] [--max 25] [--strategy mobile|desktop|both] [--fail-on any|cwv|score|none] [--min-score 50]\n(or APIFY_TOKEN=... to run through the Apify actor)");
      process.exit(0);
    } else o.urls.push(a);
  }
  return o;
}
function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function warn(msg) {
  console.log(inActions ? `::warning::${escapeData(msg)}` : `WARNING: ${msg}`);
}
function annotate(level, title, msg) {
  if (inActions) console.log(`::${level} title=${escapeData(title).replace(/:/g, "%3A").replace(/,/g, "%2C")}::${escapeData(msg)}`);
}
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `EOF_${(0, import_node_crypto.randomBytes)(8).toString("hex")}`;
  (0, import_node_fs.appendFileSync)(file, `${name}<<${delim}
${value}
${delim}
`);
}
function summary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) (0, import_node_fs.appendFileSync)(file, md);
}
function fatal(msg) {
  if (inActions) console.log(`::error::${escapeData(msg)}`);
  else console.error(msg);
  setOutput("result", "error");
  summary(`## Core Web Vitals Check

**Not run:** ${msg}
`);
  process.exitCode = 1;
}
function sitemapLocs(xml) {
  const decode = (s) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => decode(m[1])).filter(Boolean);
  return isIndex ? { pages: [], children: locs } : { pages: locs, children: [] };
}
async function fetchText(url, timeoutMs) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": `core-web-vitals-check/${VERSION} (+https://github.com/Nero-Engine/core-web-vitals-check)` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return (buf[0] === 31 && buf[1] === 139 ? (0, import_node_zlib.gunzipSync)(buf) : buf).toString("utf8");
}
async function readSitemap(url, max) {
  const out = [];
  const queue = [url];
  let fetched = 0;
  while (queue.length && out.length < max && fetched < 10) {
    const next = queue.shift();
    fetched += 1;
    try {
      const { pages, children } = sitemapLocs(await fetchText(next, 3e4));
      out.push(...pages);
      queue.push(...children);
    } catch (e) {
      warn(`Could not read sitemap ${next}: ${e.message}`);
    }
  }
  return out;
}
function rowFromAudit(url, strategy, r) {
  const a = r.status === "ok" ? r.audit : null;
  const fix = a?.opportunities[0];
  return {
    url,
    strategy,
    status: r.status,
    detail: r.statusDetail?.replace(/ Not charged\.$/, "") ?? null,
    score: a?.scores.performance ?? null,
    cwv: a?.field.coreWebVitals ?? null,
    cwvScope: a?.field.scope ?? null,
    failingVitals: a?.field.failingVitals ?? [],
    fieldLcpMs: a?.field.lcpMs ?? null,
    fieldInpMs: a?.field.inpMs ?? null,
    fieldCls: a?.field.cls ?? null,
    labLcpSeconds: a?.lab.lcpSeconds ?? null,
    tbtMs: a?.lab.tbtMs ?? null,
    topFix: fix ? `${fix.title}${fix.detail ? ` (${fix.detail})` : ""}` : null,
    failing: []
  };
}
async function runGoogle(urls, o) {
  const tasks = urls.flatMap((url) => o.strategies.map((s) => ({ url, s })));
  const rows = new Array(tasks.length);
  let next = 0;
  let keyError = null;
  const workers = Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (next < tasks.length && !keyError) {
      const i = next++;
      const t = tasks[i];
      try {
        const r = await runAudit(t.url, t.s, ["performance"], { fetchImpl: fetch, apiKey: o.googleKey, timeoutMs: o.timeoutMs, maxOpportunities: 1 });
        rows[i] = rowFromAudit(t.url, t.s, r);
        console.log(`  ${t.s.padEnd(7)} ${rows[i].status === "ok" ? String(rows[i].score).padStart(3) : " --"}  ${t.url}`);
      } catch (e) {
        if (e instanceof ApiKeyError) keyError = e;
        else throw e;
      }
    }
  });
  await Promise.all(workers);
  if (keyError) throw keyError;
  return rows.filter(Boolean);
}
function rowsFromActor(items, strategies) {
  const rows = [];
  for (const it of items) {
    const url = String(it.testedUrl ?? it.url ?? "");
    if (!url) continue;
    for (const s of strategies) {
      const status = it[`${s}Status`];
      if (!status) continue;
      const fixes = typeof it[`${s}TopFixes`] === "string" ? it[`${s}TopFixes`].split("; ")[0] : null;
      const fv = it[`${s}FailingVitals`];
      rows.push({
        url,
        strategy: s,
        status,
        detail: it[`${s}StatusDetail`]?.replace(/ Not charged\.$/, "") ?? null,
        score: it[`${s}PerformanceScore`] ?? null,
        cwv: it[`${s}CoreWebVitals`] ?? null,
        cwvScope: it[`${s}FieldDataScope`] ?? null,
        failingVitals: typeof fv === "string" && fv ? fv.split("; ") : [],
        fieldLcpMs: it[`${s}FieldLcpMs`] ?? null,
        fieldInpMs: it[`${s}FieldInpMs`] ?? null,
        fieldCls: it[`${s}FieldCls`] ?? null,
        labLcpSeconds: it[`${s}LcpSeconds`] ?? null,
        tbtMs: it[`${s}TbtMs`] ?? null,
        topFix: fixes,
        failing: []
      });
    }
  }
  return rows;
}
async function runApify(urls, o) {
  const strategy = o.strategies.length === 2 ? "both" : o.strategies[0];
  const body = { urls, strategy, categories: ["performance"], maxOpportunities: 1, concurrency: 8 };
  const res = await fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?timeout=290&clean=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.apifyToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3e5)
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new ApiKeyError(`Apify refused the token (HTTP ${res.status}). Use an API token from https://console.apify.com/settings/integrations`);
  if (!res.ok) throw new Error(`Apify returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  const items = JSON.parse(text);
  return rowsFromActor(items, o.strategies);
}
function judge(row, o) {
  const out = [];
  if (row.status !== "ok") return out;
  if (o.failOn.includes("cwv") && row.cwv === "fail") out.push(`Core Web Vitals fail for real visitors${row.cwvScope === "origin" ? " (whole site)" : ""}: ${row.failingVitals.join(", ") || "see report"}`);
  if (o.failOn.includes("score") && row.score !== null && row.score < o.minScore) out.push(`Performance score ${row.score} is under ${o.minScore}`);
  return out;
}
var icon = (c) => c === "pass" ? "\u2705 pass" : c === "fail" ? "\u274C fail" : "\u2796 no data";
var fmtMs = (ms) => ms === null ? "" : ms >= 1e3 ? `${(ms / 1e3).toFixed(1)} s` : `${ms} ms`;
var scoreCell = (s) => s === null ? "" : `${s >= 90 ? "\u{1F7E2}" : s >= 50 ? "\u{1F7E0}" : "\u{1F534}"} ${s}`;
function markdown(rows, o, failed, engine) {
  const lines = ["## Core Web Vitals Check", ""];
  const fo = o.failOn.length ? o.failOn.map((r) => r === "score" ? `score under ${o.minScore}` : "real-visitor Core Web Vitals fail").join(" or ") : "nothing (report only)";
  lines.push(`**Result: ${failed ? "failing" : "passing"}** \xB7 fails on: ${fo} \xB7 ${rows.length} test(s) via ${engine}`, "");
  lines.push("| Page | Device | Score | Real visitors CWV | LCP | INP | CLS | Lab LCP | TBT | Biggest fix |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    if (r.status !== "ok") {
      lines.push(`| ${r.url} | ${r.strategy} | | \u26A0\uFE0F ${r.status} | | | | | | ${(r.detail ?? "").replace(/\|/g, "/").slice(0, 120)} |`);
      continue;
    }
    const scope = r.cwvScope === "origin" ? " (site)" : "";
    lines.push(`| ${r.url}${r.failing.length ? " \u2757" : ""} | ${r.strategy} | ${scoreCell(r.score)} | ${icon(r.cwv)}${r.cwv ? scope : ""} | ${fmtMs(r.fieldLcpMs)} | ${r.fieldInpMs === null ? "" : `${r.fieldInpMs} ms`} | ${r.fieldCls ?? ""} | ${r.labLcpSeconds === null ? "" : `${r.labLcpSeconds} s`} | ${r.tbtMs === null ? "" : `${r.tbtMs} ms`} | ${(r.topFix ?? "").replace(/\|/g, "/")} |`);
  }
  lines.push("", `<sub>Real visitors = Google's Chrome UX Report, 75th percentile over the last 28 days; "(site)" means the page has too little traffic so the whole site's numbers are shown. Pass needs good LCP (2.5 s or less), INP (200 ms or less) and CLS (0.1 or less). Score and Lab LCP and TBT are one Lighthouse test from Google's servers and move a few points between runs.</sub>`, "");
  lines.push(`<sub>Testing hundreds or thousands of pages, from a CSV, Google Sheet or crawl, on a schedule? [Bulk PageSpeed & Lighthouse Checker on Apify](${ACTOR_URL}) runs the same test with its own Google key, filters to slow or failing pages and exports CSV or Excel.</sub>`, "");
  return lines.join("\n");
}
async function main() {
  const o = readOptions();
  if (!o.googleKey && !o.apifyToken) {
    fatal(`No key given. Google no longer answers PageSpeed Insights calls without one. Add a free Google API key as a repository secret and pass it as \`google-api-key: \${{ secrets.PAGESPEED_API_KEY }}\` (how to get one: ${KEY_HELP}), or pass an Apify token as \`apify-token\` to run it through ${ACTOR_URL}.`);
    return;
  }
  let raw = [...o.urls];
  if (o.sitemap) {
    const fromMap = await readSitemap(o.sitemap, o.maxUrls * 3);
    console.log(`Sitemap ${o.sitemap}: ${fromMap.length} page(s) found.`);
    raw.push(...fromMap);
  }
  const seen = /* @__PURE__ */ new Set();
  const urls = [];
  for (const r of raw) {
    const u = normaliseUrl(r);
    if (!u) {
      if (r.trim()) warn(`Skipped, not a web address: ${r}`);
      continue;
    }
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
  }
  raw = [];
  if (urls.length === 0) {
    fatal("No pages to test. Set `urls` (one per line or comma separated) or `sitemap` (the URL of a sitemap.xml).");
    return;
  }
  if (urls.length > o.maxUrls) warn(`${urls.length} pages found; testing the first ${o.maxUrls} (raise max-urls up to ${HARD_MAX}, or use ${ACTOR_URL} for whole sites).`);
  const list = urls.slice(0, o.maxUrls);
  const engine = o.googleKey ? "Google PageSpeed Insights API" : "Apify (nerolabs/bulk-pagespeed-checker)";
  console.log(`Core Web Vitals Check v${VERSION}: ${list.length} page(s) x ${o.strategies.join("+")} via ${engine}`);
  let rows;
  try {
    rows = o.googleKey ? await runGoogle(list, o) : await runApify(list, o);
  } catch (e) {
    fatal(e instanceof ApiKeyError ? `${e.message}. How to get a free key: ${KEY_HELP}` : `Test failed: ${e.message}`);
    return;
  }
  for (const r of rows) r.failing = judge(r, o);
  for (const r of rows) {
    if (r.status !== "ok") annotate("warning", "Page not tested", `${r.url} (${r.strategy}): ${r.detail ?? r.status}`);
    for (const f of r.failing) annotate("error", "Core Web Vitals Check", `${r.url} (${r.strategy}): ${f}`);
  }
  const ok = rows.filter((r) => r.status === "ok");
  const failedRows = rows.filter((r) => r.failing.length > 0);
  const failed = failedRows.length > 0;
  const scores = ok.map((r) => r.score).filter((s) => s !== null);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  setOutput("result", failed ? "fail" : ok.length === 0 ? "error" : "pass");
  setOutput("failing-count", String(failedRows.length));
  setOutput("failing-urls", [...new Set(failedRows.map((r) => r.url))].join(","));
  setOutput("average-score", avg === null ? "" : String(avg));
  setOutput("cwv-fail-count", String(ok.filter((r) => r.cwv === "fail").length));
  setOutput("report", JSON.stringify(rows.map((r) => ({ ...r, rating: scoreRating(r.score) }))));
  summary(markdown(rows, o, failed, engine));
  console.log("");
  for (const r of rows) {
    const vit = r.status === "ok" ? `score ${String(r.score ?? "-").padStart(3)}  CWV ${r.cwv ?? "no data"}${r.cwvScope === "origin" ? " (site)" : ""}` : `${r.status}: ${r.detail ?? ""}`;
    console.log(`${r.failing.length ? "!" : " "} ${r.strategy.padEnd(7)} ${vit.padEnd(32)} ${r.url}`);
    for (const f of r.failing) console.log(`      ${f}`);
  }
  console.log(`
${failed ? "FAIL" : ok.length ? "PASS" : "ERROR"}: ${failedRows.length} failing of ${rows.length} test(s); average score ${avg ?? "n/a"}.`);
  console.log(`Whole sites, CSV or Sheet input and schedules: ${ACTOR_URL}`);
  if (failed || ok.length === 0) process.exitCode = 1;
}
if (process.env.CWV_CHECK_NO_MAIN !== "1") {
  main().catch((err) => fatal(`Core Web Vitals Check crashed: ${err.message}`));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  judge,
  normaliseUrl,
  parseFailOn,
  parseStrategies,
  rowsFromActor,
  sitemapLocs
});
