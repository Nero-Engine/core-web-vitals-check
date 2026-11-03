// Google PageSpeed Insights v5: one request per page per device, returning a full Lighthouse report
// plus real-visitor (Chrome UX Report) data when Google has enough traffic for the page or site.
// `parsePageSpeed` is pure so it can be tested against captured responses; `runAudit` owns the
// network, retries and the mapping of Google's errors onto statuses that decide what is charged.

import type { AuditResult, Category, Opportunity, PageAudit, Rating, Strategy } from './types.js';

export const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value: number | null, digits: number): number | null {
    if (value === null) return null;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

function cleanText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    // Lighthouse titles carry Markdown code marks (`[role]`) and non-breaking spaces, which read badly in a spreadsheet.
    const text = value.replace(/\u00a0/g, ' ').replace(/`/g, '').replace(/\s+/g, ' ').trim();
    return text === '' ? null : text;
}

/** Google's own bands for a 0 to 100 Lighthouse score: 90 and up good, 50 to 89 needs work. */
export function scoreRating(score: number | null): Rating | null {
    if (score === null) return null;
    if (score >= 90) return 'good';
    if (score >= 50) return 'needs_improvement';
    return 'poor';
}

/** The Chrome UX Report block for a page, or the whole site when the page has too little traffic. */
function pickFieldData(json: Json): { scope: 'page' | 'origin' | null; metrics: Json } {
    const page = json?.loadingExperience;
    if (page?.metrics && Object.keys(page.metrics).length > 0 && !page.origin_fallback) return { scope: 'page', metrics: page.metrics };
    const origin = json?.originLoadingExperience;
    if (origin?.metrics && Object.keys(origin.metrics).length > 0) return { scope: 'origin', metrics: origin.metrics };
    return { scope: null, metrics: null };
}

/**
 * Google's Core Web Vitals assessment from real visitors: passes when the 75th percentile of LCP and
 * CLS is "good", and INP too when Google has enough interactions to report it (the same rule the
 * PageSpeed Insights page applies). Null when there is no real-visitor data to judge.
 */
export function assessCoreWebVitals(metrics: Json): 'pass' | 'fail' | null {
    if (!metrics) return null;
    const lcp = metrics.LARGEST_CONTENTFUL_PAINT_MS?.category;
    const cls = metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category;
    const inp = metrics.INTERACTION_TO_NEXT_PAINT?.category;
    if (!lcp || !cls) return null;
    const good = (c: unknown) => c === 'FAST';
    return good(lcp) && good(cls) && (inp === undefined || good(inp)) ? 'pass' : 'fail';
}

function savingsOf(audit: Json): number {
    const overall = num(audit?.details?.overallSavingsMs) ?? 0;
    const metric = audit?.metricSavings ?? {};
    return Math.max(overall, num(metric.LCP) ?? 0, num(metric.FCP) ?? 0);
}

/**
 * What Lighthouse says would make the page faster, biggest estimated time saving first. Only audits
 * the page actually failed (score under 0.9) with a real estimated saving are included.
 */
export function topOpportunities(audits: Json, limit: number): Opportunity[] {
    if (!audits || limit <= 0) return [];
    const found: Opportunity[] = [];
    for (const audit of Object.values(audits) as Json[]) {
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

/** Titles of the pass/fail checks a category's page failed, e.g. "Document does not have a meta description". */
export function failedAudits(lighthouse: Json, category: Category): string[] {
    const refs: Json[] = lighthouse?.categories?.[category]?.auditRefs ?? [];
    const out: string[] = [];
    for (const ref of refs) {
        const audit = lighthouse.audits?.[ref.id];
        if (!audit || audit.scoreDisplayMode !== 'binary' || audit.score !== 0) continue;
        const title = cleanText(audit.title);
        if (title) out.push(title);
    }
    return out;
}

/** Same page only if scheme, host (including www) and path all match; a www or https hop is a real redirect. */
function sameUrl(a: string, b: string): boolean {
    const norm = (u: string) => {
        try {
            const x = new URL(u);
            return `${x.protocol}//${x.hostname.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`;
        } catch {
            return u.replace(/\/+$/, '').toLowerCase();
        }
    };
    return norm(a) === norm(b);
}

const VITALS: { key: string; label: string; format: (p: number) => string }[] = [
    { key: 'LARGEST_CONTENTFUL_PAINT_MS', label: 'LCP', format: (p) => `${(p / 1000).toFixed(1)} s` },
    { key: 'INTERACTION_TO_NEXT_PAINT', label: 'INP', format: (p) => `${p} ms` },
    { key: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', label: 'CLS', format: (p) => (p / 100).toFixed(2) },
];

/** Which Core Web Vitals real visitors see as less than good, e.g. "CLS 0.13 (needs improvement)". */
export function failingVitals(metrics: Json): string[] {
    if (!metrics) return [];
    const out: string[] = [];
    for (const v of VITALS) {
        const m = metrics[v.key];
        const p = num(m?.percentile);
        if (!m || p === null || m.category === 'FAST') continue;
        out.push(`${v.label} ${v.format(p)} (${m.category === 'SLOW' ? 'poor' : 'needs improvement'})`);
    }
    return out;
}

export function parsePageSpeed(json: Json, requestedUrl: string, categories: Category[], maxOpportunities: number): PageAudit {
    const lr = json?.lighthouseResult ?? {};
    const audits = lr.audits ?? {};
    const scores = {} as Record<Category, number | null>;
    for (const c of ['performance', 'accessibility', 'best-practices', 'seo'] as Category[]) {
        const raw = categories.includes(c) ? num(lr.categories?.[c]?.score) : null;
        scores[c] = raw === null ? null : Math.round(raw * 100);
    }
    const labMs = (id: string) => num(audits[id]?.numericValue);
    const seconds = (id: string) => round(labMs(id) === null ? null : (labMs(id) as number) / 1000, 2);
    const finalUrl = cleanText(lr.finalDisplayedUrl) ?? cleanText(lr.finalUrl);
    const { scope, metrics } = pickFieldData(json);
    const p75 = (key: string) => num(metrics?.[key]?.percentile);
    const fieldCls = p75('CUMULATIVE_LAYOUT_SHIFT_SCORE');
    const weight = labMs('total-byte-weight');

    return {
        finalUrl,
        redirected: finalUrl !== null && !sameUrl(finalUrl, requestedUrl),
        lighthouseVersion: cleanText(lr.lighthouseVersion),
        analysedAt: cleanText(json?.analysisUTCTimestamp) ?? cleanText(lr.fetchTime),
        scores,
        lab: {
            fcpSeconds: seconds('first-contentful-paint'),
            lcpSeconds: seconds('largest-contentful-paint'),
            speedIndexSeconds: seconds('speed-index'),
            tbtMs: round(labMs('total-blocking-time'), 0),
            cls: round(labMs('cumulative-layout-shift'), 3),
            serverResponseMs: round(labMs('server-response-time'), 0),
            pageWeightKb: weight === null ? null : Math.round(weight / 1024),
        },
        field: {
            scope,
            coreWebVitals: assessCoreWebVitals(metrics),
            failingVitals: failingVitals(metrics),
            lcpMs: p75('LARGEST_CONTENTFUL_PAINT_MS'),
            inpMs: p75('INTERACTION_TO_NEXT_PAINT'),
            // The Chrome UX Report sends CLS multiplied by 100.
            cls: fieldCls === null ? null : round(fieldCls / 100, 2),
            fcpMs: p75('FIRST_CONTENTFUL_PAINT_MS'),
            ttfbMs: p75('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
        },
        opportunities: categories.includes('performance') ? topOpportunities(audits, maxOpportunities) : [],
        failedSeoAudits: categories.includes('seo') ? failedAudits(lr, 'seo') : [],
        failedAccessibilityAudits: categories.includes('accessibility') ? failedAudits(lr, 'accessibility') : [],
        runWarnings: (Array.isArray(lr.runWarnings) ? lr.runWarnings : []).map(cleanText).filter((w: string | null): w is string => w !== null),
    };
}

export function buildRequestUrl(url: string, strategy: Strategy, categories: Category[], apiKey: string): string {
    const q = new URLSearchParams({ url, strategy });
    for (const c of categories) q.append('category', c);
    q.set('key', apiKey);
    return `${PSI_ENDPOINT}?${q.toString()}`;
}

/** Thrown when Google refuses the API key itself, so the run stops instead of failing every row. */
export class ApiKeyError extends Error {}

export interface AuditOptions {
    fetchImpl: FetchLike;
    apiKey: string;
    timeoutMs: number;
    maxOpportunities: number;
    /** Delays between attempts; tests pass zeros. */
    backoffMs?: number[];
    sleep?: (ms: number) => Promise<void>;
    /** Epoch ms: no retry is started that could not finish before this, so a run near its timeout ends cleanly. */
    stopAt?: number;
}

const DEFAULT_BACKOFF_MS = [5_000, 20_000];

/** Failures that another attempt cannot fix: the name does not resolve or nothing answers. */
const DEFINITELY_UNREACHABLE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_FAILED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|DNS_FAILURE|NOT_HTML/;

/**
 * Tests one page on one device. Retries what is worth retrying (rate limits, Google's own server
 * errors, timeouts) and reports everything else honestly. Never throws, except for a refused key.
 */
export async function runAudit(url: string, strategy: Strategy, categories: Category[], opts: AuditOptions): Promise<AuditResult> {
    const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const sleep = opts.sleep ?? (async (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    const requestUrl = buildRequestUrl(url, strategy, categories, opts.apiKey);
    let last: AuditResult = { status: 'api_error', statusDetail: 'No request was made.', audit: null, attempts: 0 };
    let pageFailedRetried = false;

    for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
        if (attempt > 0) {
            if (opts.stopAt !== undefined && Date.now() + backoff[attempt - 1] + opts.timeoutMs > opts.stopAt) return last;
            await sleep(backoff[attempt - 1]);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        let status: number;
        let body: Json;
        try {
            const res = await opts.fetchImpl(requestUrl, { signal: controller.signal });
            status = res.status;
            body = await res.json().catch(() => null);
        } catch (e) {
            const aborted = (e as Error)?.name === 'AbortError' || controller.signal.aborted;
            last = {
                status: aborted ? 'timeout' : 'api_error',
                statusDetail: aborted
                    ? `Google did not finish testing the page within ${Math.round(opts.timeoutMs / 1000)} seconds. Not charged.`
                    : `Could not reach Google PageSpeed Insights: ${(e as Error)?.message ?? String(e)}. Not charged.`,
                audit: null,
                attempts: attempt + 1,
            };
            continue;
        } finally {
            clearTimeout(timer);
        }

        const message = cleanText(body?.error?.message) ?? '';
        if (status >= 200 && status < 300 && body?.lighthouseResult) {
            return { status: 'ok', statusDetail: null, audit: parsePageSpeed(body, url, categories, opts.maxOpportunities), attempts: attempt + 1 };
        }
        if (/api key|API_KEY|keyInvalid|has not been used in project|is disabled/i.test(message) && (status === 400 || status === 403)) {
            throw new ApiKeyError(`Google refused the PageSpeed Insights API key: ${message}`);
        }
        if (/Lighthouse returned error/i.test(message)) {
            // Google reached for the URL and could not load the page. A site that does not resolve
            // or refuses the connection is a final answer; anything else (the page hung, never
            // painted, or errored once) is retried once, because Google's own test flakes.
            const code = /error: ([A-Z_]+)/.exec(message)?.[1];
            const failed: AuditResult = {
                status: 'page_failed',
                statusDetail: `Google could not load the page${code ? ` (${code})` : ''}: ${message.replace(/^Lighthouse returned error: [A-Z_]+\.?\s*/, '')} Not charged.`.slice(0, 500),
                audit: null,
                attempts: attempt + 1,
            };
            if (DEFINITELY_UNREACHABLE.test(message) || pageFailedRetried || attempt >= backoff.length) return failed;
            pageFailedRetried = true;
            last = failed;
            continue;
        }
        if (status === 400) {
            return { status: 'invalid_url', statusDetail: `Google rejected the URL: ${message || 'HTTP 400'}. Not charged.`, audit: null, attempts: attempt + 1 };
        }
        if (status === 429) {
            last = { status: 'rate_limited', statusDetail: `Google's rate limit was hit and the retries did not clear it: ${message || 'HTTP 429'}. Not charged.`, audit: null, attempts: attempt + 1 };
            continue;
        }
        last = {
            status: 'api_error',
            statusDetail: `Google PageSpeed Insights returned HTTP ${status}${message ? `: ${message}` : ''}. Not charged.`.slice(0, 500),
            audit: null,
            attempts: attempt + 1,
        };
        if (status < 500) return last;
    }
    return last;
}
