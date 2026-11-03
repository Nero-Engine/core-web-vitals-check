// Shared types for the bulk PageSpeed Insights checker.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Item = Record<string, any>;

export type FileFormat = 'auto' | 'csv' | 'tsv' | 'json' | 'jsonl' | 'xlsx';

export type Strategy = 'mobile' | 'desktop';

export type Category = 'performance' | 'accessibility' | 'best-practices' | 'seo';

/**
 * The outcome of one page on one device. Only `ok` is ever charged: every other status means Google
 * gave the caller no Lighthouse report.
 */
export type AuditStatus =
    | 'ok'
    | 'page_failed'
    | 'invalid_url'
    | 'rate_limited'
    | 'api_error'
    | 'timeout'
    | 'skipped_budget'
    | 'skipped_time';

/** Google's own three bands for a Lighthouse score and for a real-user metric. */
export type Rating = 'good' | 'needs_improvement' | 'poor';

export interface Opportunity {
    title: string;
    /** Google's own estimate of what fixing it saves, e.g. "Est savings of 588 KiB". */
    detail: string | null;
    savingsMs: number;
}

/** Everything read from one successful PageSpeed Insights response. */
export interface PageAudit {
    finalUrl: string | null;
    redirected: boolean;
    lighthouseVersion: string | null;
    analysedAt: string | null;
    /** 0 to 100, null when the category was not requested or Google returned no score. */
    scores: Record<Category, number | null>;
    lab: {
        fcpSeconds: number | null;
        lcpSeconds: number | null;
        speedIndexSeconds: number | null;
        tbtMs: number | null;
        cls: number | null;
        serverResponseMs: number | null;
        pageWeightKb: number | null;
    };
    field: {
        /** Where the real-visitor data came from: this exact page, the whole site, or nothing. */
        scope: 'page' | 'origin' | null;
        coreWebVitals: 'pass' | 'fail' | null;
        /** The vitals real visitors see as less than good, with the value, e.g. "CLS 0.13 (needs improvement)". */
        failingVitals: string[];
        lcpMs: number | null;
        inpMs: number | null;
        cls: number | null;
        fcpMs: number | null;
        ttfbMs: number | null;
    };
    opportunities: Opportunity[];
    failedSeoAudits: string[];
    failedAccessibilityAudits: string[];
    runWarnings: string[];
}

export interface AuditResult {
    status: AuditStatus;
    statusDetail: string | null;
    audit: PageAudit | null;
    attempts: number;
}

export interface ActorInput {
    datasetId?: string;
    fileUrl?: string;
    fileFormat?: FileFormat;
    data?: Item[];
    urlField?: string;

    strategy?: 'mobile' | 'desktop' | 'both';
    categories?: Category[];
    maxOpportunities?: number;

    keep?: 'all' | 'slow' | 'fast' | 'cwv_fail' | 'problems';
    slowBelowScore?: number;

    googleApiKey?: string;
    concurrency?: number;
    requestTimeoutSecs?: number;

    maxItems?: number;
    exportFormats?: string[];
    outputDatasetName?: string;
    webhookUrl?: string;
}

export interface PageSpeedSummary {
    source: 'dataset' | 'fileUrl' | 'inline';
    sourceFormat?: string;
    urlField: string;
    strategies: Strategy[];
    categories: Category[];
    inputRecordCount: number;
    uniqueUrls: number;
    /** Successful Lighthouse reports, i.e. the number of charged events. */
    auditsCompleted: number;
    outputRecordCount: number;
    statusCounts: Record<string, number>;
    averageScores: Record<string, number | null>;
    slowCount: number;
    coreWebVitalsFailCount: number;
    slowestPages: { url: string; strategy: Strategy; performanceScore: number }[];
    commonOpportunities: { title: string; pages: number }[];
    apiKeySource: 'caller' | 'actor';
    dataNote: string;
    exportUrls: Record<string, string>;
    durationMs: number;
    warnings: string[];
    webhookDelivered?: boolean;
}
