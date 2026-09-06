#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'components', 'cockpit-runs.js');
const source = fs.readFileSync(file, 'utf8').replace(
  'export { CockpitRuns, normalizedBasePath, routePath };',
  'globalThis.CockpitRuns = CockpitRuns; globalThis.normalizedBasePath = normalizedBasePath; globalThis.routePath = routePath;'
);
class HTMLElement {
  constructor() { this.innerHTML = ''; this.style = {}; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
const context = {
  console, HTMLElement, customElements: { define() {} },
  document: { body: { classList: { add() {}, remove() {}, toggle() {} } }, getElementById() { return null; } },
  window: { location: { pathname: '/cockpit/', search: '?embed=1', hash: '' }, addEventListener() {}, removeEventListener() {}, LctxApi: {} },
  setInterval() { return 1; }, clearInterval() {}, history: { pushState() {} },
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: file });

const namespace = 'a'.repeat(64);
if (context.normalizedBasePath() !== '/cockpit') throw new Error('base path was not normalized');
if (context.routePath(namespace) !== '/cockpit/runs/' + namespace) throw new Error('base path escaped');

const runs = new context.CockpitRuns();
runs._runs = [{ namespace, task_id: 'task-1', assignment_id: 'assignment-1', member_id: 'member-1',
  status: 'active', source: 'broker', metrics: { requests_total: 4, tokens_saved_total: 9 } }];
runs._aggregate = { runs: 1, tokens_saved_total: 9 };
runs._enabled = true;
runs._loading = false;
runs.render();
if (!runs.innerHTML.includes('All runs') || !runs.innerHTML.includes(namespace)) throw new Error('selector did not populate');
runs._detail = runs._runs[0];
runs._selected = namespace;
const detail = runs._detailView();
if (!detail.includes('Requests') || !detail.includes('Tokens saved')) throw new Error('canonical metrics missing');
if (detail.includes('saved_tokens')) throw new Error('legacy metric alias leaked');

runs._enabled = false;
runs.render();
if (!runs.innerHTML.includes('disabled') || runs.innerHTML.includes('All runs')) throw new Error('disabled state not distinct');

runs._enabled = true;
runs._selected = null;
runs._runs = [];
runs._aggregate = { runs: 0 };
runs.render();
if (!runs.innerHTML.includes('NO RUNS') || !runs.innerHTML.includes('Unavailable')) throw new Error('zero state not explicit');

console.log('PASS: broker-run states, base paths, and canonical metrics');
