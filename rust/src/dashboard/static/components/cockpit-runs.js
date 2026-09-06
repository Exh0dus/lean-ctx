/** Broker-run overview and focused run view. */

const RUN_NAMESPACE = /^[0-9a-f]{64}$/i;
const METRIC_KEYS = [
  ['requests_total', 'Requests'],
  ['tokens_saved_total', 'Tokens saved'],
  ['bytes_compressed', 'Bytes compressed'],
  ['tokens_processed', 'Tokens processed'],
];

function runsApi() {
  return window.LctxApi && window.LctxApi.apiFetch;
}

function escapeHtml(value) {
  const formatter = window.LctxFmt || {};
  if (formatter.esc) return formatter.esc(String(value == null ? '' : value));
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) =>
    '&#' + ch.charCodeAt(0) + ';',
  );
}

function isAvailable(value) {
  return value !== undefined && value !== null && value !== '' &&
    !(value && typeof value === 'object' && value.available === false);
}

function displayValue(value) {
  if (!isAvailable(value)) return 'Unavailable';
  if (value && typeof value === 'object' && value.value !== undefined) {
    return displayValue(value.value);
  }
  return escapeHtml(value);
}

function metric(metrics, key) {
  return metrics && Object.prototype.hasOwnProperty.call(metrics, key)
    ? metrics[key]
    : undefined;
}

function normalizedBasePath() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const selected = path.match(/^(.*)\/runs\/[0-9a-f]{64}$/i);
  if (selected) return selected[1] || '';
  if (path === '/') return '';
  return path;
}

function routePath(namespace) {
  const base = normalizedBasePath();
  return base + (base ? '/' : '/') + (namespace ? 'runs/' + namespace : '');
}

class CockpitRuns extends HTMLElement {
  constructor() {
    super();
    this._runs = [];
    this._aggregate = null;
    this._detail = null;
    this._selected = null;
    this._enabled = null;
    this._loading = true;
    this._error = null;
    this._detailError = null;
    this._openNew = false;
    this._sort = 'recent';
    this._range = 30;
    this._generation = 0;
    this._inflight = false;
    this._reloadPending = false;
    this._reloadQuiet = true;
    this._retryAttempt = 0;
    this._retryTimer = null;
    this._onPopState = this._onPopState.bind(this);
    this._onRangeChange = this._onRangeChange.bind(this);
  }

  connectedCallback() {
    if (this._ready) return;
    this._ready = true;
    this.style.display = 'block';
    if (new URLSearchParams(window.location.search).get('embed') === '1') {
      document.documentElement.classList.add('lctx-embed' );
      document.body.classList.add('lctx-embed' );
    }
    window.addEventListener('popstate', this._onPopState);
    document.addEventListener('lctx:runs-range', this._onRangeChange);
    this._syncPath();
    this.loadData();
    this._timer = setInterval(() => this.loadData(true), 15000);
  }

  disconnectedCallback() {
    window.removeEventListener('popstate', this._onPopState);
    document.removeEventListener('lctx:runs-range', this._onRangeChange);
    if (this._timer) clearInterval(this._timer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
  }

  _onPopState() {
    this._syncPath();
    this._generation++;
    this.loadData();
  }

  _onRangeChange(event) {
    const days = Number(event && event.detail && event.detail.days);
    if (![0, 7, 30, 90].includes(days) || days === this._range) return;
    this._range = days;
    this._generation++;
    this._retryAttempt = 0;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this.loadData();
  }

  _syncPath() {
    const path = window.location.pathname.replace(/\/+$/, '');
    const match = path.match(/\/runs\/([0-9a-f]{64})$/i);
    this._selected = match ? match[1].toLowerCase() : null;
  }

  _navigate(namespace) {
    const selected = String(namespace || '').toLowerCase();
    if (selected && !RUN_NAMESPACE.test(selected)) return;
    const url = routePath(selected);
    const query = window.location.search;
    const hash = window.location.hash;
    if (this._openNew && selected) {
      window.open(url + query + hash, '_blank', 'noopener,noreferrer');
      return;
    }
    history.pushState({ run: selected || null }, '', url + query + hash);
    this._syncPath();
    this._generation++;
    this.loadData();
  }

  async loadData(quiet) {
    const fetchJson = runsApi();
    if (!fetchJson) return;
    if (this._inflight) {
      this._reloadPending = true;
      this._reloadQuiet = this._reloadQuiet && !!quiet;
      return;
    }
    this._inflight = true;
    const generation = ++this._generation;
    if (!quiet) {
      this._loading = true;
      this._error = null;
      this._detailError = null;
      this.render();
    }
    this._detail = null;
    this._detailError = null;
    try {
      const index = await fetchJson(this._apiPath(''), { timeoutMs: 15000 });
      if (generation !== this._generation) { this._finishLoad(); return; }
      if (!index || typeof index !== 'object' || typeof index.enabled !== 'boolean') {
        this._enabled = null;
        this._runs = [];
        this._aggregate = null;
        this._error = 'Run history response is unavailable or malformed';
        this._loading = false;
        this._scheduleRetry();
        this.render();
        this._finishLoad();
        return;
      }
      this._enabled = index.enabled;
      this._runs = Array.isArray(index.runs) ? index.runs : [];
      this._aggregate = index.aggregate && typeof index.aggregate === 'object'
        ? index.aggregate : null;
      if (index.enabled === false) {
        this._selected = null;
        this._loading = false;
        this.render();
        this._finishLoad();
        return;
      }
      if (this._selected) {
        try {
          const detail = await fetchJson(this._apiPath(this._selected));
          if (generation !== this._generation) { this._finishLoad(); return; }
          this._detail = detail && typeof detail === 'object' ? detail : null;
        } catch (error) {
          if (generation !== this._generation) { this._finishLoad(); return; }
          this._detailError = error && error.error
            ? String(error.error) : 'Unable to load the selected run';
        }
      }
      if (generation !== this._generation) { this._finishLoad(); return; }
      this._loading = false;
      this._error = null;
      this._retryAttempt = 0;
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    } catch (error) {
      if (generation !== this._generation) { this._finishLoad(); return; }
      this._loading = false;
      this._error = error && error.error
        ? String(error.error) : 'Run history is unavailable';
      this._scheduleRetry();
    }
    this._finishLoad();
    this.render();
  }

  _finishLoad() {
    this._inflight = false;
    if (!this._reloadPending) return;
    const quiet = this._reloadQuiet;
    this._reloadPending = false;
    this._reloadQuiet = true;
    Promise.resolve().then(() => this.loadData(quiet));
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    const delays = [2000, 5000, 10000, 15000];
    const delay = delays[Math.min(this._retryAttempt++, delays.length - 1)];
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.loadData(true);
    }, delay);
  }

  _retryNow() {
    this._retryAttempt = 0;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this.loadData();
  }

  _apiPath(namespace) {
    const base = normalizedBasePath();
    return base + '/api/runs' + (namespace ? '/' + encodeURIComponent(namespace) : '') +
      '?days=' + encodeURIComponent(String(this._range));
  }

  _ordered() {
    return this._runs.slice().sort((a, b) => {
      if (this._sort === 'saved') {
        return Number(metric(b.metrics, 'tokens_saved_total') || -1) -
          Number(metric(a.metrics, 'tokens_saved_total') || -1);
      }
      const ad = Date.parse(a.last_seen_at || a.created_at || '') || 0;
      const bd = Date.parse(b.last_seen_at || b.created_at || '') || 0;
      return bd - ad;
    });
  }

  _label(run) {
    return (run.task_id || 'task unavailable') + ' - ' +
      (run.assignment_id || 'assignment unavailable') + ' - ' +
      (run.member_id || 'member unavailable');
  }

  _selector() {
    let html = '<div class="runs-toolbar"><label for="runsSelector">Run</label>' +
      '<select id="runsSelector" aria-label="Select a LeanCtx run">' +
      '<option value=""' + (!this._selected ? ' selected' : '') + '>All runs</option>';
    this._runs.forEach((run) => {
      const namespace = run && typeof run.namespace === 'string'
        ? run.namespace.toLowerCase() : '';
      if (RUN_NAMESPACE.test(namespace)) {
        html += '<option value="' + escapeHtml(namespace) + '"' +
          (namespace === this._selected ? ' selected' : '') + '>' +
          escapeHtml(this._label(run)) + '</option>';
      }
    });
    html += '</select><label for="runsSort">Sort</label>' +
      '<select id="runsSort" aria-label="Sort LeanCtx runs">' +
      '<option value="recent"' + (this._sort === 'recent' ? ' selected' : '') +
      '>Most recent</option><option value="saved"' +
      (this._sort === 'saved' ? ' selected' : '') + '>Tokens saved</option>' +
      '</select><label class="runs-new-tab"><input type="checkbox" id="runsNewTab"' +
      (this._openNew ? ' checked' : '') +
      '> Open selected run in new tab</label></div>';
    return html;
  }

  _stateCard(title, text, className) {
    return '<div class="card runs-state ' + (className || '') + '" role="status">' +
      '<p class="eyebrow">' + escapeHtml(title) + '</p><p class="hs">' +
      escapeHtml(text) + '</p></div>';
  }

  _aggregateView() {
    const aggregate = this._aggregate || {};
    const runCount = metric(aggregate, 'total_runs');
    const rangeLabel = this._range === 0 ? 'All time' : this._range + ' days';
    let html = '<div class="runs-overview-head"><div><p class="eyebrow">BROKER RUNS</p>' +
      '<h2>' + escapeHtml(rangeLabel) + '</h2><p class="hs">Historical and active LeanCtx assignment runs.</p>' +
      '</div><div class="runs-totals"><div><strong>' +
      displayValue(runCount) + '</strong><span>Runs</span></div><div><strong>' +
      displayValue(metric(aggregate, 'tokens_saved_total')) +
      '</strong><span>Tokens saved</span></div></div></div>';
    if (!this._runs.length) {
      return html + this._stateCard('NO RUNS', 'No broker runs are available yet.', 'runs-empty');
    }
    return html + '<div class="runs-list" role="list">' +
      this._ordered().map((run) => this._row(run)).join('') + '</div>';
  }

  _row(run) {
    const namespace = run && typeof run.namespace === 'string'
      ? run.namespace.toLowerCase() : '';
    if (!RUN_NAMESPACE.test(namespace)) return '';
    return '<button type="button" class="runs-row" role="listitem" data-run="' +
      escapeHtml(namespace) + '"><span class="runs-row-main"><strong>' +
      escapeHtml(this._label(run)) + '</strong><small>' +
      escapeHtml(run.status || 'Unavailable') + ' - ' +
      escapeHtml(metric(run.metrics, 'source') || 'Unavailable') +
      '</small></span><span class="runs-row-metric">' +
      displayValue(metric(run.metrics, 'tokens_saved_total')) +
      '</span><span class="runs-row-arrow" aria-hidden="true">&rarr;</span></button>';
  }

  _detailView() {
    if (this._detailError) {
      return this._stateCard('RUN UNAVAILABLE', this._detailError, 'runs-unavailable') +
        '<button type="button" class="runs-back" id="runsBack">&larr; All runs</button>';
    }
    const run = this._detail;
    if (!run) return this._stateCard('RUN UNAVAILABLE',
      'The selected run was not found.', 'runs-unavailable');
    const metrics = run.metrics || {};
    let html = '<div class="runs-detail-head"><div><p class="eyebrow">SELECTED RUN</p>' +
      '<h2>' + escapeHtml(this._label(run)) + '</h2><p class="hs">Namespace <code>' +
      escapeHtml(this._selected) + '</code></p></div><button type="button" class="runs-back" ' +
      'id="runsBack">&larr; All runs</button></div><div class="runs-detail-grid">' +
      this._card('Status', run.status) + this._card('Source', metrics.source);
    METRIC_KEYS.forEach(([key, label]) => {
      if (Object.prototype.hasOwnProperty.call(metrics, key)) {
        html += this._card(label, metric(metrics, key));
      }
    });
    return html + '</div>';
  }

  _card(label, value) {
    return '<div class="card runs-detail-card"><span class="eyebrow">' +
      escapeHtml(label) + '</span><strong>' + displayValue(value) + '</strong></div>';
  }

  render() {
    if (this._enabled === false) {
      this.innerHTML = this._stateCard('UNAVAILABLE',
        'Broker run history is disabled.', 'runs-disabled');
      document.body.classList.remove('lctx-run-selected');
      return;
    }
    if (this._loading && !this._runs.length) {
      this.innerHTML = this._stateCard('LOADING', 'Loading run history...');
      return;
    }
    if (this._error) {
      this.innerHTML = this._stateCard('UNAVAILABLE', this._error, 'runs-unavailable') +
        '<button type="button" class="runs-back" id="runsRetry">Retry now</button>';
      const retry = this.querySelector('#runsRetry');
      if (retry) retry.addEventListener('click', () => this._retryNow());
      return;
    }
    this.innerHTML = this._selector() +
      (this._selected ? this._detailView() : this._aggregateView());
    this._bind();
    const overview = document.getElementById('overviewView');
    if (overview) overview.hidden = !!this._selected;
    document.body.classList.toggle('lctx-run-selected', !!this._selected);
  }

  _bind() {
    const selector = this.querySelector('#runsSelector');
    if (selector) selector.addEventListener('change', (event) => {
      this._navigate(event.target.value);
    });
    const sort = this.querySelector('#runsSort');
    if (sort) sort.addEventListener('change', (event) => {
      this._sort = event.target.value;
      this.render();
    });
    const checkbox = this.querySelector('#runsNewTab');
    if (checkbox) checkbox.addEventListener('change', (event) => {
      this._openNew = !!event.target.checked;
    });
    this.querySelectorAll('[data-run]').forEach((row) => {
      row.addEventListener('click', () => this._navigate(row.dataset.run));
    });
    const back = this.querySelector('#runsBack');
    if (back) back.addEventListener('click', () => this._navigate(''));
  }
}

customElements.define('cockpit-runs', CockpitRuns);

export { CockpitRuns, normalizedBasePath, routePath };
