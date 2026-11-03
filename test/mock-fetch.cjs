// Replaces fetch so the CLI can be tested on saved Google responses: python.org gets the mobile
// fixture, example.com the desktop one, anything with "broken" a Lighthouse error, a sitemap is served.
const fs = require('node:fs');
const path = require('node:path');
const fx = (n) => fs.readFileSync(path.join(__dirname, n), 'utf8');
const SITEMAP = '<?xml version="1.0"?><urlset><url><loc>https://www.python.org/</loc></url><url><loc>https://example.com/</loc></url><url><loc>https://broken.example.org/</loc></url></urlset>';
globalThis.fetch = async (url) => {
  const u = String(url);
  const resp = (status, body) => ({ ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body, arrayBuffer: async () => Buffer.from(body) });
  if (u.includes('sitemap')) return resp(200, SITEMAP);
  const target = new URL(u).searchParams.get('url') || '';
  if (target.includes('broken')) return resp(500, fx('failed-page.json'));
  if (target.includes('python')) return resp(200, fx('python-mobile.json'));
  return resp(200, fx('example-desktop.json'));
};
