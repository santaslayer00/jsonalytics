const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.cjs'), 'utf8');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

test('all four CRUD routes exist for the lead register', () => {
  assert.match(server, /app\.get\('\/api\/leads'/);
  assert.match(server, /app\.post\('\/api\/leads'/);
  assert.match(server, /app\.patch\('\/api\/leads\/:id'/);
  assert.match(server, /app\.delete\('\/api\/leads\/:id'/);
});

test('lead status is restricted to exactly the four required states', () => {
  const match = server.match(/const LEAD_STATUSES = \[([^\]]+)\]/);
  assert.ok(match, 'expected a LEAD_STATUSES constant');
  const statuses = match[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(statuses.sort(), ['in_progress', 'in_queue', 'interested', 'not_interested'].sort());
});

test('POST and PATCH both validate status against LEAD_STATUSES rather than trusting the request body', () => {
  const postRoute = server.slice(server.indexOf("app.post('/api/leads'"), server.indexOf("app.patch('/api/leads/:id'"));
  const patchRoute = server.slice(server.indexOf("app.patch('/api/leads/:id'"), server.indexOf("app.delete('/api/leads/:id'"));
  assert.match(postRoute, /LEAD_STATUSES\.includes\(status\)/);
  assert.match(patchRoute, /LEAD_STATUSES\.includes\(status\)/);
});

test('leads persist to their own local file, same pattern as tokens.json, and are gitignored', () => {
  assert.match(server, /LEADS_FILE = path\.join\(__dirname, 'leads\.json'\)/);
  assert.match(gitignore, /^leads\.json$/m);
});

test('storeUrl is required to create a lead — no silent empty leads', () => {
  const postRoute = server.slice(server.indexOf("app.post('/api/leads'"), server.indexOf("app.patch('/api/leads/:id'"));
  assert.match(postRoute, /storeUrl\.trim\(\)/);
  assert.match(postRoute, /status\(400\)/);
});

test('a new lead starts with lastScan: null — nothing cached until explicitly scanned', () => {
  const postRoute = server.slice(server.indexOf("app.post('/api/leads'"), server.indexOf("app.patch('/api/leads/:id'"));
  assert.match(postRoute, /lastScan:\s*null/);
});

test('PATCH accepts a lastScan cache blob so re-visiting a lead does not force a re-scan', () => {
  const patchRoute = server.slice(server.indexOf("app.patch('/api/leads/:id'"), server.indexOf("app.delete('/api/leads/:id'"));
  assert.match(patchRoute, /lastScan/);
});
