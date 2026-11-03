// Core Web Vitals Check, a GitHub Action (and a plain Node CLI).
// Tests a list of pages, or every page in a sitemap, with Google PageSpeed Insights. For each page it
// reads the real-visitor Core Web Vitals (Chrome UX Report: LCP, INP, CLS at the 75th percentile) and the
// Lighthouse performance score, writes a job summary table, step outputs and annotations, and can fail
// the build when real visitors fail Core Web Vitals or the score drops under a floor.
// Two ways to run: the user's own free Google API key (calls Google directly), or their Apify token
// (runs nerolabs/bulk-pagespeed-checker, which holds its own Google key). Node's built-in fetch only.

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { ApiKeyError, runAudit, scoreRating, type FetchLike } from './psi.js';
import type { AuditResult, Strategy } from './types.js';

const VERSION = '1.0.0';
const ACTOR_ID = 'nerolabs~bulk-pagespeed-checker';
const ACTOR_URL = 'https://apify.com/nerolabs/bulk-pagespeed-checker';
const KEY_HELP = 'https://developers.google.com/speed/docs/insights/v5/get-started#APIKey';
const HARD_MAX = 100;

type FailRule = 'cwv' | 'score';

interface Options {
    urls: string[];
    sitemap: string | null;
    maxUrls: number;
    strategies: Strategy[];
    failOn: FailRule[];
    minScore: number;
    googleKey: string | null;
    apifyToken: string | null;
    timeoutMs: number;
}

export interface PageRow {
    url: string;
    strategy: Strategy;
    status: string;
    detail: string | null;
    score: number | null;
    cwv: 'pass' | 'fail' | null;
    cwvScope: 'page' | 'origin' | null;
    failingVitals: string[];
    fieldLcpMs: number | null;
    fieldInpMs: number | null;
    fieldCls: number | null;
    labLcpSeconds: number | null;
    tbtMs: number | null;
    topFix: string | null;
    failing: string[];
}

const inActions = process.env.GITHUB_ACTIONS === 'true';

function input(name: string, fallback = ''): string {
    const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
    return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function splitList(v: string): string[] {
    return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function clampInt(v: string, def: number, min: number, max: number): number {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && v !== '' ? Math.min(Math.max(n, min), max) : def;
}

export function parseStrategies(v: string): Strategy[] {
    const s = v.toLowerCase();
    if (s === 'both') return ['mobile', 'desktop'];
    return s === 'desktop' ? ['desktop'] : ['mobile'];
}

export function parseFailOn(v: string): FailRule[] {
    const parts = splitList(v.toLowerCase());
    if (parts.includes('none')) return [];
    if (parts.length === 0 || parts.includes('any')) return ['cwv', 'score'];
    return (['cwv', 'score'] as FailRule[]).filter((r) => parts.includes(r));
}

export function normaliseUrl(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;
    try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (!u.hostname.includes('.')) return null;
        u.hash = '';
        return u.toString();
    } catch {
        return null;
    }
}

function readOptions(): Options {
    if (inActions) {
        return {
            urls: splitList(input('urls')),
            sitemap: input('sitemap') || null,
            maxUrls: clampInt(input('max-urls'), 25, 1, HARD_MAX),
            strategies: parseStrategies(input('strategy', 'mobile')),
            failOn: parseFailOn(input('fail-on', 'any')),
            minScore: clampInt(input('min-score'), 50, 0, 100),
            googleKey: input('google-api-key') || null,
            apifyToken: input('apify-token') || null,
            timeoutMs: clampInt(input('timeout-seconds'), 90, 20, 180) * 1000,
        };
    }
    // CLI: node dist/index.js <url> [url...] [--sitemap URL] [--max N] [--strategy mobile|desktop|both]
    //      [--fail-on any|cwv|score|none] [--min-score N]; keys from GOOGLE_API_KEY or APIFY_TOKEN.
    const args = process.argv.slice(2);
    const o: Options = {
        urls: [], sitemap: null, maxUrls: 25, strategies: ['mobile'], failOn: ['cwv', 'score'], minScore: 50,
        googleKey: process.env.GOOGLE_API_KEY || process.env.PAGESPEED_API_KEY || null, apifyToken: process.env.APIFY_TOKEN || null, timeoutMs: 90_000,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--sitemap') o.sitemap = args[++i] ?? null;
        else if (a === '--max') o.maxUrls = clampInt(args[++i] ?? '', 25, 1, HARD_MAX);
        else if (a === '--strategy') o.strategies = parseStrategies(args[++i] ?? 'mobile');
        else if (a === '--fail-on') o.failOn = parseFailOn(args[++i] ?? 'any');
        else if (a === '--min-score') o.minScore = clampInt(args[++i] ?? '', 50, 0, 100);
        else if (a === '--help' || a === '-h') {
            console.log('Usage: GOOGLE_API_KEY=... node dist/index.js <url> [url...] [--sitemap https://site/sitemap.xml] [--max 25] [--strategy mobile|desktop|both] [--fail-on any|cwv|score|none] [--min-score 50]\n(or APIFY_TOKEN=... to run through the Apify actor)');
            process.exit(0);
        } else o.urls.push(a);
    }
    return o;
}

// ----- GitHub workflow commands -----
function escapeData(s: string): string {
    return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function warn(msg: string): void {
    console.log(inActions ? `::warning::${escapeData(msg)}` : `WARNING: ${msg}`);
}
function annotate(level: 'error' | 'warning' | 'notice', title: string, msg: string): void {
    if (inActions) console.log(`::${level} title=${escapeData(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}::${escapeData(msg)}`);
}
function setOutput(name: string, value: string): void {
    const file = process.env.GITHUB_OUTPUT;
    if (!file) return;
    const delim = `EOF_${randomBytes(8).toString('hex')}`;
    appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}
function summary(md: string): void {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) appendFileSync(file, md);
}
function fatal(msg: string): void {
    if (inActions) console.log(`::error::${escapeData(msg)}`); else console.error(msg);
    setOutput('result', 'error');
    summary(`## Core Web Vitals Check\n\n**Not run:** ${msg}\n`);
    process.exitCode = 1;
}

// ----- sitemap -----
/** Every <loc> in a sitemap or sitemap index, entity-decoded, in file order. */
export function sitemapLocs(xml: string): { pages: string[]; children: string[] } {
    const decode = (s: string) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => decode(m[1])).filter(Boolean);
    return isIndex ? { pages: [], children: locs } : { pages: locs, children: [] };
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': `core-web-vitals-check/${VERSION} (+https://github.com/Nero-Engine/core-web-vitals-check)` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
}

async function readSitemap(url: string, max: number): Promise<string[]> {
    const out: string[] = [];
    const queue = [url];
    let fetched = 0;
    while (queue.length && out.length < max && fetched < 10) {
        const next = queue.shift() as string;
        fetched += 1;
        try {
            const { pages, children } = sitemapLocs(await fetchText(next, 30_000));
            out.push(...pages);
            queue.push(...children);
        } catch (e) {
            warn(`Could not read sitemap ${next}: ${(e as Error).message}`);
        }
    }
    return out;
}

// ----- the two engines -----
function rowFromAudit(url: string, strategy: Strategy, r: AuditResult): PageRow {
    const a = r.status === 'ok' ? r.audit : null;
    const fix = a?.opportunities[0];
    return {
        url, strategy, status: r.status, detail: r.statusDetail?.replace(/ Not charged\.$/, '') ?? null,
        score: a?.scores.performance ?? null, cwv: a?.field.coreWebVitals ?? null, cwvScope: a?.field.scope ?? null,
        failingVitals: a?.field.failingVitals ?? [], fieldLcpMs: a?.field.lcpMs ?? null, fieldInpMs: a?.field.inpMs ?? null, fieldCls: a?.field.cls ?? null,
        labLcpSeconds: a?.lab.lcpSeconds ?? null, tbtMs: a?.lab.tbtMs ?? null,
        topFix: fix ? `${fix.title}${fix.detail ? ` (${fix.detail})` : ''}` : null, failing: [],
    };
}

async function runGoogle(urls: string[], o: Options): Promise<PageRow[]> {
    const tasks = urls.flatMap((url) => o.strategies.map((s) => ({ url, s })));
    const rows: PageRow[] = new Array(tasks.length);
    let next = 0;
    let keyError: Error | null = null;
    const workers = Array.from({ length: Math.min(4, tasks.length) }, async () => {
        while (next < tasks.length && !keyError) {
            const i = next++;
            const t = tasks[i];
            try {
                const r = await runAudit(t.url, t.s, ['performance'], { fetchImpl: fetch as unknown as FetchLike, apiKey: o.googleKey as string, timeoutMs: o.timeoutMs, maxOpportunities: 1 });
                rows[i] = rowFromAudit(t.url, t.s, r);
                console.log(`  ${t.s.padEnd(7)} ${rows[i].status === 'ok' ? String(rows[i].score).padStart(3) : ' --'}  ${t.url}`);
            } catch (e) {
                if (e instanceof ApiKeyError) keyError = e; else throw e;
            }
        }
    });
    await Promise.all(workers);
    if (keyError) throw keyError;
    return rows.filter(Boolean);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;

export function rowsFromActor(items: Item[], strategies: Strategy[]): PageRow[] {
    const rows: PageRow[] = [];
    for (const it of items) {
        const url = String(it.testedUrl ?? it.url ?? '');
        if (!url) continue;
        for (const s of strategies) {
            const status = it[`${s}Status`];
            if (!status) continue;
            const fixes = typeof it[`${s}TopFixes`] === 'string' ? (it[`${s}TopFixes`] as string).split('; ')[0] : null;
            const fv = it[`${s}FailingVitals`];
            rows.push({
                url, strategy: s, status, detail: it[`${s}StatusDetail`]?.replace(/ Not charged\.$/, '') ?? null,
                score: it[`${s}PerformanceScore`] ?? null, cwv: it[`${s}CoreWebVitals`] ?? null, cwvScope: it[`${s}FieldDataScope`] ?? null,
                failingVitals: typeof fv === 'string' && fv ? fv.split('; ') : [], fieldLcpMs: it[`${s}FieldLcpMs`] ?? null,
                fieldInpMs: it[`${s}FieldInpMs`] ?? null, fieldCls: it[`${s}FieldCls`] ?? null, labLcpSeconds: it[`${s}LcpSeconds`] ?? null,
                tbtMs: it[`${s}TbtMs`] ?? null, topFix: fixes, failing: [],
            });
        }
    }
    return rows;
}

async function runApify(urls: string[], o: Options): Promise<PageRow[]> {
    const strategy = o.strategies.length === 2 ? 'both' : o.strategies[0];
    const body = { urls, strategy, categories: ['performance'], maxOpportunities: 1, concurrency: 8 };
    const res = await fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?timeout=290&clean=true`, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apifyToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new ApiKeyError(`Apify refused the token (HTTP ${res.status}). Use an API token from https://console.apify.com/settings/integrations`);
    if (!res.ok) throw new Error(`Apify returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    const items = JSON.parse(text) as Item[];
    return rowsFromActor(items, o.strategies);
}

// ----- judging and output -----
export function judge(row: PageRow, o: Pick<Options, 'failOn' | 'minScore'>): string[] {
    const out: string[] = [];
    if (row.status !== 'ok') return out;
    if (o.failOn.includes('cwv') && row.cwv === 'fail') out.push(`Core Web Vitals fail for real visitors${row.cwvScope === 'origin' ? ' (whole site)' : ''}: ${row.failingVitals.join(', ') || 'see report'}`);
    if (o.failOn.includes('score') && row.score !== null && row.score < o.minScore) out.push(`Performance score ${row.score} is under ${o.minScore}`);
    return out;
}

const icon = (c: 'pass' | 'fail' | null) => (c === 'pass' ? '✅ pass' : c === 'fail' ? '❌ fail' : '➖ no data');
const fmtMs = (ms: number | null) => (ms === null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const scoreCell = (s: number | null) => (s === null ? '' : `${s >= 90 ? '🟢' : s >= 50 ? '🟠' : '🔴'} ${s}`);

function markdown(rows: PageRow[], o: Options, failed: boolean, engine: string): string {
    const lines = ['## Core Web Vitals Check', ''];
    const fo = o.failOn.length ? o.failOn.map((r) => (r === 'score' ? `score under ${o.minScore}` : 'real-visitor Core Web Vitals fail')).join(' or ') : 'nothing (report only)';
    lines.push(`**Result: ${failed ? 'failing' : 'passing'}** · fails on: ${fo} · ${rows.length} test(s) via ${engine}`, '');
    lines.push('| Page | Device | Score | Real visitors CWV | LCP | INP | CLS | Lab LCP | TBT | Biggest fix |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
        if (r.status !== 'ok') { lines.push(`| ${r.url} | ${r.strategy} | | ⚠️ ${r.status} | | | | | | ${(r.detail ?? '').replace(/\|/g, '/').slice(0, 120)} |`); continue; }
        const scope = r.cwvScope === 'origin' ? ' (site)' : '';
        lines.push(`| ${r.url}${r.failing.length ? ' ❗' : ''} | ${r.strategy} | ${scoreCell(r.score)} | ${icon(r.cwv)}${r.cwv ? scope : ''} | ${fmtMs(r.fieldLcpMs)} | ${r.fieldInpMs === null ? '' : `${r.fieldInpMs} ms`} | ${r.fieldCls ?? ''} | ${r.labLcpSeconds === null ? '' : `${r.labLcpSeconds} s`} | ${r.tbtMs === null ? '' : `${r.tbtMs} ms`} | ${(r.topFix ?? '').replace(/\|/g, '/')} |`);
    }
    lines.push('', '<sub>Real visitors = Google\'s Chrome UX Report, 75th percentile over the last 28 days; "(site)" means the page has too little traffic so the whole site\'s numbers are shown. Pass needs good LCP (2.5 s or less), INP (200 ms or less) and CLS (0.1 or less). Score and Lab LCP and TBT are one Lighthouse test from Google\'s servers and move a few points between runs.</sub>', '');
    lines.push(`<sub>Testing hundreds or thousands of pages, from a CSV, Google Sheet or crawl, on a schedule? [Bulk PageSpeed & Lighthouse Checker on Apify](${ACTOR_URL}) runs the same test with its own Google key, filters to slow or failing pages and exports CSV or Excel.</sub>`, '');
    return lines.join('\n');
}

async function main(): Promise<void> {
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
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const r of raw) {
        const u = normaliseUrl(r);
        if (!u) { if (r.trim()) warn(`Skipped, not a web address: ${r}`); continue; }
        if (seen.has(u)) continue;
        seen.add(u);
        urls.push(u);
    }
    raw = [];
    if (urls.length === 0) { fatal('No pages to test. Set `urls` (one per line or comma separated) or `sitemap` (the URL of a sitemap.xml).'); return; }
    if (urls.length > o.maxUrls) warn(`${urls.length} pages found; testing the first ${o.maxUrls} (raise max-urls up to ${HARD_MAX}, or use ${ACTOR_URL} for whole sites).`);
    const list = urls.slice(0, o.maxUrls);
    const engine = o.googleKey ? 'Google PageSpeed Insights API' : 'Apify (nerolabs/bulk-pagespeed-checker)';
    console.log(`Core Web Vitals Check v${VERSION}: ${list.length} page(s) x ${o.strategies.join('+')} via ${engine}`);

    let rows: PageRow[];
    try {
        rows = o.googleKey ? await runGoogle(list, o) : await runApify(list, o);
    } catch (e) {
        fatal(e instanceof ApiKeyError ? `${e.message}. How to get a free key: ${KEY_HELP}` : `Test failed: ${(e as Error).message}`);
        return;
    }
    for (const r of rows) r.failing = judge(r, o);

    for (const r of rows) {
        if (r.status !== 'ok') annotate('warning', 'Page not tested', `${r.url} (${r.strategy}): ${r.detail ?? r.status}`);
        for (const f of r.failing) annotate('error', 'Core Web Vitals Check', `${r.url} (${r.strategy}): ${f}`);
    }
    const ok = rows.filter((r) => r.status === 'ok');
    const failedRows = rows.filter((r) => r.failing.length > 0);
    const failed = failedRows.length > 0;
    const scores = ok.map((r) => r.score).filter((s): s is number => s !== null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    setOutput('result', failed ? 'fail' : ok.length === 0 ? 'error' : 'pass');
    setOutput('failing-count', String(failedRows.length));
    setOutput('failing-urls', [...new Set(failedRows.map((r) => r.url))].join(','));
    setOutput('average-score', avg === null ? '' : String(avg));
    setOutput('cwv-fail-count', String(ok.filter((r) => r.cwv === 'fail').length));
    setOutput('report', JSON.stringify(rows.map((r) => ({ ...r, rating: scoreRating(r.score) }))));
    summary(markdown(rows, o, failed, engine));

    console.log('');
    for (const r of rows) {
        const vit = r.status === 'ok' ? `score ${String(r.score ?? '-').padStart(3)}  CWV ${r.cwv ?? 'no data'}${r.cwvScope === 'origin' ? ' (site)' : ''}` : `${r.status}: ${r.detail ?? ''}`;
        console.log(`${r.failing.length ? '!' : ' '} ${r.strategy.padEnd(7)} ${vit.padEnd(32)} ${r.url}`);
        for (const f of r.failing) console.log(`      ${f}`);
    }
    console.log(`\n${failed ? 'FAIL' : ok.length ? 'PASS' : 'ERROR'}: ${failedRows.length} failing of ${rows.length} test(s); average score ${avg ?? 'n/a'}.`);
    console.log(`Whole sites, CSV or Sheet input and schedules: ${ACTOR_URL}`);
    if (failed || ok.length === 0) process.exitCode = 1;
}

if (process.env.CWV_CHECK_NO_MAIN !== '1') {
    main().catch((err) => fatal(`Core Web Vitals Check crashed: ${(err as Error).message}`));
}
