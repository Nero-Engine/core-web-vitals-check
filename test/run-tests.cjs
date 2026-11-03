// node test/run-tests.cjs: pure function checks plus a full CLI run on saved Google responses.
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
process.env.CWV_CHECK_NO_MAIN = '1';
const m = require('../dist/index.js');
assert.deepStrictEqual(m.parseFailOn('any'), ['cwv', 'score']);
assert.deepStrictEqual(m.parseFailOn('none'), []);
assert.deepStrictEqual(m.parseFailOn('score'), ['score']);
assert.deepStrictEqual(m.parseStrategies('both'), ['mobile', 'desktop']);
assert.strictEqual(m.normaliseUrl('example.com'), 'https://example.com/');
assert.strictEqual(m.normaliseUrl('localhost'), null);
const idx = m.sitemapLocs('<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>');
assert.deepStrictEqual(idx, { pages: [], children: ['https://a.com/s1.xml'] });
assert.deepStrictEqual(m.sitemapLocs('<urlset><url><loc>https://a.com/?a=1&amp;b=2</loc></url></urlset>').pages, ['https://a.com/?a=1&b=2']);
const row = { url: 'x', strategy: 'mobile', status: 'ok', score: 40, cwv: 'fail', cwvScope: 'origin', failingVitals: ['INP 300 ms (needs improvement)'] };
assert.strictEqual(m.judge(row, { failOn: ['cwv', 'score'], minScore: 50 }).length, 2);
assert.strictEqual(m.judge({ ...row, status: 'page_failed' }, { failOn: ['cwv', 'score'], minScore: 50 }).length, 0);
const actorRows = m.rowsFromActor([{ testedUrl: 'https://a.com/', mobileStatus: 'ok', mobilePerformanceScore: 77, mobileCoreWebVitals: 'pass', mobileFieldDataScope: 'page', mobileTopFixes: 'Reduce unused JavaScript (Est savings of 120 KiB); Other' }], ['mobile']);
assert.strictEqual(actorRows[0].score, 77);
assert.strictEqual(actorRows[0].topFix, 'Reduce unused JavaScript (Est savings of 120 KiB)');
console.log('pure checks passed');

const env = { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', CWV_CHECK_NO_MAIN: '', GOOGLE_API_KEY: 'test-key', APIFY_TOKEN: '' };
let out;
try {
  out = execFileSync('node', ['-r', path.join(__dirname, 'mock-fetch.cjs'), path.join(__dirname, '../dist/index.js'), '--sitemap', 'https://site.test/sitemap.xml', '--fail-on', 'none'], { env, encoding: 'utf8' });
} catch (e) { out = e.stdout; console.error(e.stderr); throw e; }
console.log(out);
assert.match(out, /PASS: 0 failing of 3/);
assert.match(out, /page_failed/);
console.log('cli run passed');
