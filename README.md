# Core Web Vitals Check: Bulk PageSpeed Insights GitHub Action

**Fail the build when real visitors fail Core Web Vitals, or your PageSpeed score drops, on a list of pages or your whole sitemap.**

Lighthouse actions run one lab test in the runner. This one asks Google PageSpeed Insights, so every page gets both:

- **Real-visitor Core Web Vitals** from Google's Chrome UX Report (the data Google ranks on): LCP, INP and CLS at the 75th percentile over 28 days, with Google's own pass or fail. When a page has too little traffic, the whole site's numbers are used and marked "(site)".
- **The Lighthouse performance score** (0 to 100), lab LCP, Total Blocking Time and the biggest fix with Google's estimated saving.

Give it `urls`, a `sitemap` (sitemap index and `.xml.gz` work), or both. No Chrome, no npm install, no dependencies: one 26 KB file.

## Quick start

1. Get a free Google API key with the PageSpeed Insights API turned on ([Google's 2 minute guide](https://developers.google.com/speed/docs/insights/v5/get-started#APIKey)). Google refuses calls without a key.
2. Add it as a repository secret named `PAGESPEED_API_KEY`.
3. Add `.github/workflows/core-web-vitals.yml`:

```yaml
name: Core Web Vitals
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 7 * * 1'   # every Monday
jobs:
  cwv:
    runs-on: ubuntu-latest
    steps:
      - uses: Nero-Engine/core-web-vitals-check@v1
        with:
          sitemap: https://www.example.com/sitemap.xml
          google-api-key: ${{ secrets.PAGESPEED_API_KEY }}
```

The job summary shows one table: page, device, score, real-visitor verdict, LCP, INP, CLS, lab LCP, TBT and the biggest fix. Failing pages also show as error annotations.

**No Google key?** Pass `apify-token: ${{ secrets.APIFY_TOKEN }}` instead. The test then runs through [Bulk PageSpeed & Lighthouse Checker](https://apify.com/nerolabs/bulk-pagespeed-checker) on your Apify account, which uses its own Google key and is billed per page tested.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `urls` | | Pages to test, one per line or comma separated. `example.com` is fine. |
| `sitemap` | | URL of a sitemap.xml or sitemap index. The first `max-urls` pages are tested. |
| `max-urls` | `25` | Most pages per run, 1 to 100. |
| `google-api-key` | | Your free Google API key, from a secret. Needed unless `apify-token` is set. |
| `apify-token` | | Alternative to a Google key: runs the test on Apify (billed per page). |
| `strategy` | `mobile` | `mobile` (what Google ranks on), `desktop` or `both`. |
| `fail-on` | `any` | `any` = Core Web Vitals fail or score under `min-score`. `cwv` = only real-visitor Core Web Vitals. `score` = only the score. `none` = report only. |
| `min-score` | `50` | Lowest performance score that passes. |
| `timeout-seconds` | `90` | Per page. Google takes 10 to 40 seconds a page. |

## Outputs

| Output | What it holds |
|---|---|
| `result` | `pass`, `fail` or `error` (nothing could be tested). |
| `failing-count` | How many page tests broke the rules. |
| `failing-urls` | Comma separated URLs that failed. |
| `average-score` | Average performance score. |
| `cwv-fail-count` | Page tests that fail Core Web Vitals for real visitors. |
| `report` | Full JSON: per page and device the score, verdict, LCP, INP, CLS, lab numbers, biggest fix and failure reasons. |

Report only, then use the outputs:

```yaml
      - id: cwv
        uses: Nero-Engine/core-web-vitals-check@v1
        with:
          urls: |
            https://www.example.com/
            https://www.example.com/pricing
          strategy: both
          fail-on: none
          google-api-key: ${{ secrets.PAGESPEED_API_KEY }}
      - run: echo "Average score ${{ steps.cwv.outputs.average-score }}, failing ${{ steps.cwv.outputs.failing-urls }}"
```

## Run it locally

```bash
GOOGLE_API_KEY=your-key node dist/index.js example.com https://www.example.com/pricing --strategy both --min-score 60
GOOGLE_API_KEY=your-key node dist/index.js --sitemap https://www.example.com/sitemap.xml --max 25 --fail-on cwv
```

## Accuracy notes

- Real-visitor data only exists for pages and sites with enough Chrome traffic. New or small sites show "no data" and are judged on the score alone.
- The score is one Lighthouse run on Google's servers and moves a few points between runs. Keep `min-score` a little under your normal score so the build does not flap.
- Pass needs good LCP (2.5 s or less), INP (200 ms or less) and CLS (0.1 or less), the same rule the PageSpeed Insights page uses. INP is skipped when Google has too few interactions to report it.
- Google's free quota is 25,000 tests a day and 400 per 100 seconds per key; the action runs 4 at a time.

## Whole sites, spreadsheets and schedules

For hundreds or thousands of pages, a CSV, Google Sheet or crawl as input, filters such as "only slow pages" or "only Core Web Vitals fails", and CSV or Excel exports, use [Bulk PageSpeed & Lighthouse Checker on Apify](https://apify.com/nerolabs/bulk-pagespeed-checker). Same Google test, its own key, pay per page.

Made by Nero Labs. MIT licence.
