/** LeanCtx execution ledger: projects -> runs -> roles -> instances. */
const RUN_NAMESPACE = /^[0-9a-f]{64}$/i;
const METRIC_KEYS = [
  ["requests_total", "Requests"],
  ["tokens_saved_total", "Tokens saved"],
  ["bytes_compressed", "Bytes compressed"],
  ["tokens_processed", "Tokens processed"],
];
function runsApi() {
  return window.LctxApi && window.LctxApi.apiFetch;
}
function escapeHtml(v) {
  const f = window.LctxFmt || {};
  if (f.esc) return f.esc(String(v == null ? "" : v));
  return String(v == null ? "" : v).replace(
    /[&<>"']/g,
    (c) => "&#" + c.charCodeAt(0) + ";",
  );
}
function isAvailable(v) {
  return (
    v !== undefined &&
    v !== null &&
    v !== "" &&
    !(v && typeof v === "object" && v.available === false)
  );
}
function displayValue(v) {
  if (!isAvailable(v)) return "Unavailable";
  if (v && typeof v === "object" && v.value !== undefined)
    return displayValue(v.value);
  return escapeHtml(v);
}
function metric(m, k) {
  return m && Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
}
function normalizedBasePath() {
  const p = window.location.pathname.replace(/\/+$/, "") || "/";
  const m = p.match(/^(.*)\/runs\/[0-9a-f]{64}$/i);
  if (m) return m[1] || "";
  return p === "/" ? "" : p;
}
function routePath(ns) {
  const b = normalizedBasePath();
  return b + (b ? "/" : "/") + (ns ? "runs/" + ns : "");
}
function scopeUrl(namespace, scope, search) {
  const params = new URLSearchParams(search || window.location.search || "");
  ["project", "task", "role", "order"].forEach((key) => params.delete(key));
  if (scope && scope.project) params.set("project", scope.project);
  if (scope && scope.task) params.set("task", scope.task);
  if (scope && scope.role) params.set("role", scope.role);
  if (scope && scope.mode === "timeline") params.set("order", "timeline");
  const query = params.toString();
  return routePath(namespace) + (query ? "?" + query : "");
}
function hierarchy(r) {
  return r && r.hierarchy && typeof r.hierarchy === "object" ? r.hierarchy : {};
}
function humanize(v, f) {
  const t = String(v || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return t || f || "Unclassified";
}
function roleName(r) {
  return hierarchy(r).role_label || r.member_id || "Unassigned";
}
function projectId(r) {
  return hierarchy(r).project_id || "";
}
function projectLabel(r) {
  if (!projectId(r)) return "Unclassified";
  return (
    hierarchy(r).project_label ||
    hierarchy(r).workflow_label ||
    (projectId(r) ? humanize(projectId(r)) : "Unclassified")
  );
}
function timeOf(r) {
  return hierarchy(r).timeline_time || r.created_at || r.last_seen_at || "";
}
function runCreated(r) {
  return hierarchy(r).run_created_at || r.created_at || r.last_seen_at || "";
}
function runStatus(r) {
  return hierarchy(r).run_status || r.status || "Unavailable";
}
function localTime(v, date) {
  if (!v) return "Time unavailable";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString(
    undefined,
    date ? { dateStyle: "medium", timeStyle: "short" } : { timeStyle: "short" },
  );
}
function shortId(v) {
  const t = String(v || "");
  return t.length > 14 ? t.slice(0, 7) + "…" + t.slice(-5) : t;
}

class CockpitRuns extends HTMLElement {
  constructor() {
    super();
    this._runs = [];
    this._aggregate = null;
    this._detail = null;
    this._selected = null;
    this._selectedRun = null;
    this._selectedRole = null;
    this._selectedInstance = null;
    this._expandedRoles = new Set();
    this._project = "";
    this._mode = "role";
    this._enabled = null;
    this._loading = true;
    this._error = null;
    this._detailError = null;
    this._range = 30;
    this._generation = 0;
    this._inflight = false;
    this._reloadPending = false;
    this._reloadQuiet = true;
    this._retryAttempt = 0;
    this._retryTimer = null;
    this._runLimit = 25;
    this._onPopState = this._onPopState.bind(this);
    this._onRangeChange = this._onRangeChange.bind(this);
  }
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;
    this.style.display = "block";
    this._overview =
      this.querySelector("cockpit-overview") ||
      document.getElementById("overviewView");
    this._toolbarHost = document.createElement("div");
    this._toolbarHost.className = "runs-toolbar-host";
    this._overviewHost = this._overview;
    this._overviewHost.classList.add("runs-overview-slot");
    this._listHost = document.createElement("div");
    this._listHost.className = "runs-list-host";
    this.insertBefore(this._toolbarHost, this._overview);
    this.appendChild(this._listHost);
    window.addEventListener("popstate", this._onPopState);
    document.addEventListener("lctx:runs-range", this._onRangeChange);
    this._syncPath();
    this.loadData();
    this._timer = setInterval(() => this.loadData(true), 15000);
  }
  disconnectedCallback() {
    window.removeEventListener("popstate", this._onPopState);
    document.removeEventListener("lctx:runs-range", this._onRangeChange);
    if (this._timer) clearInterval(this._timer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
  }
  _onPopState() {
    this._syncPath();
    this._generation++;
    this.loadData();
  }
  _onRangeChange(e) {
    const d = Number(e && e.detail && e.detail.days);
    if (![0, 7, 30, 90].includes(d) || d === this._range) return;
    this._range = d;
    this._runLimit = 25;
    this._generation++;
    this._retryAttempt = 0;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this.loadData();
  }
  _syncPath() {
    const m = window.location.pathname
      .replace(/\/+$/, "")
      .match(/\/runs\/([0-9a-f]{64})$/i);
    this._selected = m ? m[1].toLowerCase() : null;
    const params = new URLSearchParams(window.location.search || "");
    this._project = params.get("project") || "";
    this._selectedRun = params.get("task") || null;
    this._selectedRole = params.get("role") || null;
    this._mode = params.get("order") === "timeline" ? "timeline" : "role";
  }
  _navigate(ns, reload = true) {
    const s = String(ns || "").toLowerCase();
    if (s && !RUN_NAMESPACE.test(s)) return;
    history.pushState(
      { run: s || null },
      "",
      scopeUrl(s, {
        project: this._project,
        task: this._selectedRun,
        role: this._selectedRole,
        mode: this._mode,
      }) + window.location.hash,
    );
    this._syncPath();
    if (reload) {
      this._generation++;
      this.loadData();
    } else this.render();
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
    const g = ++this._generation;
    if (!quiet) {
      this._loading = true;
      this._error = null;
      this._detailError = null;
      this.render();
    }
    try {
      const index = await fetchJson(this._apiPath(""), { timeoutMs: 15000 });
      if (g !== this._generation) return this._finishLoad();
      if (
        !index ||
        typeof index !== "object" ||
        typeof index.enabled !== "boolean"
      )
        throw new Error("Run history response is unavailable or malformed");
      this._enabled = index.enabled;
      this._runs = Array.isArray(index.runs) ? index.runs : [];
      this._aggregate = index.aggregate || null;
      if (this._selected) {
        try {
          const detail = await fetchJson(this._apiPath(this._selected));
          if (g !== this._generation) return this._finishLoad();
          this._detail = detail && typeof detail === "object" ? detail : null;
        } catch (e) {
          if (g !== this._generation) return this._finishLoad();
          this._detailError =
            e && e.error ? String(e.error) : "Unable to load the selected run";
        }
      }
      this._resolveSelection();
      this._loading = false;
      this._error = null;
      this._retryAttempt = 0;
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
    } catch (e) {
      if (g === this._generation) {
        this._loading = false;
        this._error =
          e && e.error
            ? String(e.error)
            : String(e.message || "Run history is unavailable");
        this._scheduleRetry();
      }
    }
    this._finishLoad();
    this.render();
  }
  _finishLoad() {
    this._inflight = false;
    if (!this._reloadPending) return;
    const q = this._reloadQuiet;
    this._reloadPending = false;
    this._reloadQuiet = true;
    Promise.resolve().then(() => this.loadData(q));
  }
  _scheduleRetry() {
    if (this._retryTimer) return;
    const ds = [2000, 5000, 10000, 15000];
    this._retryTimer = setTimeout(
      () => {
        this._retryTimer = null;
        this.loadData(true);
      },
      ds[Math.min(this._retryAttempt++, ds.length - 1)],
    );
  }
  _retryNow() {
    this._retryAttempt = 0;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this.loadData();
  }
  _apiPath(ns) {
    const b = normalizedBasePath();
    return (
      b +
      "/api/runs" +
      (ns ? "/" + encodeURIComponent(ns) : "") +
      "?days=" +
      encodeURIComponent(String(this._range))
    );
  }
  _resolveSelection() {
    const freshInstance = this._runs.find(
      (r) => String(r.namespace || "").toLowerCase() === this._selected,
    );
    if (this._selected && !freshInstance) this._selected = null;
    this._selectedInstance = freshInstance || null;
    if (freshInstance) {
      this._selectedRun = freshInstance.task_id || "";
      this._project = projectId(freshInstance) || "__unclassified";
      this._selectedRole = roleName(freshInstance);
      this._expandedRoles.add(this._selectedRole);
    }
    const projectExists =
      !this._project || this._projects().some((p) => p.id === this._project);
    if (!projectExists) {
      this._project = "";
      this._selectedRun = null;
      this._selectedRole = null;
      this._selectedInstance = null;
      this._selected = null;
      return;
    }
    const runExists =
      !this._selectedRun ||
      this._logicalRuns().some((run) => run.id === this._selectedRun);
    if (!runExists) {
      this._selectedRun = null;
      this._selectedRole = null;
      this._selectedInstance = null;
      this._selected = null;
      return;
    }
    const selectedRows = this._selectedRows();
    if (
      this._selectedRole &&
      selectedRows &&
      !selectedRows.rows.some((run) => roleName(run) === this._selectedRole)
    ) {
      this._selectedRole = null;
      this._selectedInstance = null;
      this._selected = null;
    }
  }
  _projects() {
    const m = new Map();
    this._runs.forEach((r) => {
      const id = projectId(r) || "__unclassified";
      if (!m.has(id))
        m.set(id, {
          id,
          label: id === "__unclassified" ? "Unclassified" : projectLabel(r),
          runs: [],
        });
      m.get(id).runs.push(r);
    });
    const out = [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
    const counts = new Map();
    out.forEach((p) => counts.set(p.label, (counts.get(p.label) || 0) + 1));
    out.forEach((p) => {
      if (counts.get(p.label) > 1) p.label += " · " + shortId(p.id);
      p.logicalCount = new Set(
        p.runs.map((run) => run.task_id || run.namespace),
      ).size;
    });
    return out;
  }
  _scopedRuns() {
    return this._project
      ? this._runs.filter((r) =>
          this._project === "__unclassified"
            ? projectId(r) === ""
            : projectId(r) === this._project,
        )
      : this._runs;
  }
  _logicalRuns() {
    const m = new Map();
    this._scopedRuns().forEach((r) => {
      const id = r.task_id || String(r.namespace || "");
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(r);
    });
    return [...m.entries()]
      .map(([id, rows]) => ({
        id,
        rows,
        first: rows
          .slice()
          .sort(
            (a, b) =>
              (Date.parse(timeOf(a)) || 0) - (Date.parse(timeOf(b)) || 0),
          )[0],
      }))
      .sort(
        (a, b) =>
          (Date.parse(timeOf(b.first)) || 0) -
          (Date.parse(timeOf(a.first)) || 0),
      );
  }
  _selectedRows() {
    return this._logicalRuns().find((r) => r.id === this._selectedRun) || null;
  }
  _metrics(rows) {
    const t = {};
    (rows || []).forEach((r) =>
      METRIC_KEYS.forEach(([k]) => {
        const v = metric(r.metrics, k);
        if (isAvailable(v)) t[k] = (Number(t[k]) || 0) + (Number(v) || 0);
      }),
    );
    return t;
  }
  _scopeOverview(label, rows) {
    if (this._overview && typeof this._overview.setRunScope === "function")
      this._overview.setRunScope({
        label,
        interval:
          this._range === 0 ? "All time" : "Last " + this._range + " days",
        rows: rows || [],
        metrics: this._metrics(rows || []),
      });
  }
  _friendlyScopeLabel(rows, suffix) {
    const first = rows && rows[0];
    const project = first
      ? projectLabel(first)
      : this._project === "__unclassified"
        ? "Unclassified"
        : "All projects";
    const run = first
      ? humanize(
          hierarchy(first).run_label || hierarchy(first).workflow_label,
          "Run " + shortId(first.task_id),
        )
      : "All runs";
    return [project, this._selectedRun ? run : null, suffix || null]
      .filter(Boolean)
      .join(" › ");
  }
  _selector() {
    let h =
      '<div class="runs-toolbar"><label for="runsSelector">Project</label><select id="runsSelector" aria-label="Select a LeanCtx project"><option value=""' +
      (!this._project ? " selected" : "") +
      ">All projects</option>";
    this._projects().forEach((p) => {
      h +=
        '<option value="' +
        escapeHtml(p.id) +
        '"' +
        (p.id === this._project ? " selected" : "") +
        ">" +
        escapeHtml(p.label) +
        " · " +
        p.logicalCount +
        " runs · " +
        p.runs.length +
        " assignments" +
        "</option>";
    });
    return (
      h +
      '</select><div class="runs-range-controls" role="group" aria-label="Run interval">' +
      [7, 30, 90, 0]
        .map(
          (days) =>
            '<button type="button" data-range="' +
            days +
            '" aria-pressed="' +
            (this._range === days) +
            '" class="' +
            (this._range === days ? "is-active" : "") +
            '">' +
            (days === 0 ? "All" : days + "d") +
            "</button>",
        )
        .join("") +
      '</div><span class="runs-range-note">' +
      escapeHtml(
        this._range === 0 ? "All time" : "Last " + this._range + " days",
      ) +
      "</span></div>"
    );
  }
  _stateCard(t, x, c) {
    return (
      '<div class="card runs-state ' +
      (c || "") +
      '" role="status"><p class="eyebrow">' +
      escapeHtml(t) +
      '</p><p class="hs">' +
      escapeHtml(x) +
      "</p></div>"
    );
  }
  _crumbs() {
    const p = [{ label: "All projects", key: "projects" }];
    if (this._project)
      p.push({
        label:
          this._project === "__unclassified"
            ? "Unclassified"
            : projectLabel(this._scopedRuns()[0]),
        key: "project",
      });
    if (this._selectedRun)
      p.push({ label: "Run " + shortId(this._selectedRun), key: "run" });
    if (this._selectedRole)
      p.push({ label: humanize(this._selectedRole), key: "role" });
    if (this._selectedInstance)
      p.push({
        label: humanize(this._selectedRole) + " instance",
        key: "instance",
      });
    return (
      '<nav class="runs-breadcrumb" aria-label="Run path">' +
      p
        .map(
          (x, i) =>
            (i ? ' <span aria-hidden="true">›</span> ' : "") +
            '<button type="button" data-crumb="' +
            x.key +
            '">' +
            escapeHtml(x.label) +
            "</button>",
        )
        .join("") +
      "</nav>"
    );
  }
  _projectView() {
    const ps = this._projects();
    this._scopeOverview(
      this._project
        ? this._scopedRuns()[0] && projectLabel(this._scopedRuns()[0])
        : "All projects",
      this._scopedRuns(),
    );
    if (!ps.length)
      return this._stateCard(
        "NO RUNS",
        "No broker runs are available yet.",
        "runs-empty",
      );
    if (!this._project)
      return (
        '<section class="runs-ledger"><div class="runs-section-head"><div><p class="eyebrow">PROJECTS</p><h2>Choose a project</h2></div><span class="runs-count">' +
        ps.length +
        '</span></div><div class="runs-list" role="list">' +
        ps
          .map(
            (p) =>
              '<button type="button" class="runs-row runs-project-row" data-project="' +
              escapeHtml(p.id) +
              '" role="listitem"><span class="runs-row-main"><strong>' +
              escapeHtml(p.label) +
              "</strong><small>" +
              p.logicalCount +
              " runs · " +
              p.runs.length +
              ' assignments</small></span><span class="runs-row-arrow" aria-hidden="true">→</span></button>',
          )
          .join("") +
        "</div></section>"
      );
    const ls = this._logicalRuns();
    return (
      '<section class="runs-ledger"><div class="runs-section-head"><div><p class="eyebrow">LOGICAL RUNS</p><h2>' +
      escapeHtml(projectLabel(this._scopedRuns()[0])) +
      '</h2></div><span class="runs-count">' +
      ls.length +
      '</span></div><div class="runs-list" role="list">' +
      ls
        .slice(0, this._runLimit)
        .map((x) => this._runRow(x))
        .join("") +
      "</div>" +
      (ls.length > this._runLimit
        ? '<button type="button" class="btn runs-load-more" id="runsLoadMore">Load more runs</button>'
        : "") +
      "</section>"
    );
  }
  _runRow(x) {
    const f = x.first;
    const label =
      hierarchy(f).run_label || hierarchy(f).workflow_label || "Run";
    return (
      '<div class="runs-row runs-row-container"><button type="button" class="runs-row-main-button" data-run-id="' +
      escapeHtml(x.id) +
      '" role="listitem"><span class="runs-row-main"><strong>' +
      escapeHtml(humanize(label, "Run")) +
      " · " +
      escapeHtml(localTime(runCreated(f), true)) +
      "</strong><small>" +
      escapeHtml(shortId(x.id)) +
      " · " +
      escapeHtml(runStatus(f)) +
      " · " +
      x.rows.length +
      ' agents</small></span><span class="runs-row-metric">' +
      displayValue(this._metrics(x.rows).tokens_saved_total) +
      '</span><span class="runs-row-arrow" aria-hidden="true">→</span></button><a class="runs-open-link" href="' +
      escapeHtml(
        scopeUrl("", { project: this._project, task: x.id, mode: this._mode }),
      ) +
      '" target="_blank" rel="noopener" aria-label="Open run in new tab">↗</a></div>'
    );
  }
  _roleGroups(rows) {
    const m = new Map();
    rows.forEach((r) => {
      const k = roleName(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    m.forEach((group) => group.sort((a, b) => this._timelineCompare(a, b)));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  _timelineCompare(a, b) {
    return (
      (Number(hierarchy(a).timeline_rank) || Infinity) -
        (Number(hierarchy(b).timeline_rank) || Infinity) ||
      (Date.parse(timeOf(a)) || 0) - (Date.parse(timeOf(b)) || 0) ||
      String(a.namespace || "").localeCompare(String(b.namespace || ""))
    );
  }
  _roleView() {
    const s = this._selectedRows();
    if (!s)
      return this._stateCard(
        "RUN NOT FOUND",
        "Choose a run to inspect its execution ledger.",
        "runs-empty",
      );
    const rows = s.rows;
    const scopedRows = this._selectedInstance
      ? [this._selectedInstance]
      : this._selectedRole
        ? rows.filter((r) => roleName(r) === this._selectedRole)
        : rows;
    this._scopeOverview(
      this._friendlyScopeLabel(
        scopedRows,
        this._selectedInstance
          ? humanize(this._selectedRole) + " instance"
          : this._selectedRole
            ? humanize(this._selectedRole)
            : null,
      ),
      scopedRows,
    );
    let h =
      '<section class="runs-ledger"><div class="runs-detail-head">' +
      this._crumbs() +
      '<div><p class="eyebrow">AGENT LEDGER</p><h2>Run details</h2></div><div class="runs-mode-toggle" role="group" aria-label="Run ordering"><button type="button" data-mode="role" aria-pressed="true" class="is-active">By role</button><button type="button" data-mode="timeline" aria-pressed="false">Timeline</button></div></div><div class="runs-role-list" role="list">';
    this._roleGroups(rows).forEach(([role, rr]) => {
      const open = this._expandedRoles.has(role);
      h +=
        '<div class="runs-role-group" role="listitem"><div class="runs-role-line"><button type="button" class="runs-disclosure" data-role-toggle="' +
        escapeHtml(role) +
        '" aria-expanded="' +
        open +
        '" aria-label="' +
        (open ? "Collapse " : "Expand ") +
        escapeHtml(role) +
        '">' +
        (open ? "⌄" : "›") +
        '</button><button type="button" class="runs-role-select" data-role="' +
        escapeHtml(role) +
        '"><strong>' +
        escapeHtml(humanize(role)) +
        '</strong><span class="runs-count">' +
        rr.length +
        "</span><small>" +
        escapeHtml(displayValue(this._metrics(rr).tokens_saved_total)) +
        " tokens saved</small></button></div>" +
        (open
          ? '<div class="runs-instance-list">' +
            rr.map((r, i) => this._instanceRow(r, i)).join("") +
            "</div>"
          : "") +
        "</div>";
    });
    return h + "</div></section>";
  }
  _instanceRow(r, i) {
    const ns = String(r.namespace || "").toLowerCase();
    const sel = ns === this._selected;
    const n = String(i + 1).padStart(2, "0");
    return (
      '<div class="runs-instance-line' +
      (sel ? " is-selected" : "") +
      '"><button type="button" class="runs-instance-select" data-instance="' +
      escapeHtml(ns) +
      '" title="' +
      escapeHtml(ns) +
      '"><strong>' +
      escapeHtml(humanize(roleName(r))) +
      " " +
      n +
      "</strong><small>" +
      escapeHtml(localTime(timeOf(r))) +
      " · " +
      escapeHtml(r.status || "Unavailable") +
      " · " +
      escapeHtml(String(hierarchy(r).attempt_count || 1)) +
      " attempt" +
      (Number(hierarchy(r).attempt_count || 1) === 1 ? "" : "s") +
      '</small></button><a class="runs-open-link" href="' +
      escapeHtml(
        scopeUrl(ns, {
          project: this._project,
          task: this._selectedRun,
          role: this._selectedRole,
          mode: this._mode,
        }),
      ) +
      '" target="_blank" rel="noopener" aria-label="Open instance in new tab">↗</a></div>'
    );
  }
  _timelineView() {
    const s = this._selectedRows();
    if (!s)
      return this._stateCard(
        "RUN NOT FOUND",
        "Choose a run to inspect its execution ledger.",
        "runs-empty",
      );
    const scopedRows = this._selectedInstance
      ? [this._selectedInstance]
      : s.rows;
    this._scopeOverview(
      this._friendlyScopeLabel(
        scopedRows,
        this._selectedInstance
          ? humanize(this._selectedRole) + " instance"
          : "Timeline",
      ),
      scopedRows,
    );
    const rows = s.rows.slice().sort((a, b) => this._timelineCompare(a, b));
    let h =
      '<section class="runs-ledger"><div class="runs-detail-head">' +
      this._crumbs() +
      '<div><p class="eyebrow">EXECUTION TIMELINE</p><h2>Dispatch order</h2><p class="hs">Linked dispatch first; creation time is the fallback.</p></div><div class="runs-mode-toggle" role="group" aria-label="Run ordering"><button type="button" data-mode="role" aria-pressed="false">By role</button><button type="button" data-mode="timeline" aria-pressed="true" class="is-active">Timeline</button></div></div><div class="runs-timeline" role="list">';
    rows.forEach((r, i) => {
      const basis =
        hierarchy(r).timeline_source === "dispatch"
          ? "dispatch order"
          : "creation fallback";
      h +=
        '<div class="runs-timeline-line" role="listitem"><span class="runs-timeline-index">' +
        String(i + 1).padStart(2, "0") +
        '</span><button type="button" class="runs-instance-select" data-instance="' +
        escapeHtml(String(r.namespace || "").toLowerCase()) +
        '"><strong>' +
        escapeHtml(humanize(roleName(r))) +
        "</strong><small>" +
        escapeHtml(localTime(timeOf(r))) +
        " · " +
        escapeHtml(r.status || "Unavailable") +
        '</small></button><span class="runs-basis">' +
        basis +
        '</span><a class="runs-open-link" href="' +
        escapeHtml(
          scopeUrl(r.namespace, {
            project: this._project,
            task: this._selectedRun,
            role: roleName(r),
            mode: this._mode,
          }),
        ) +
        '" target="_blank" rel="noopener" aria-label="Open instance in new tab">↗</a></div>';
    });
    return h + "</div></section>";
  }
  render() {
    if (this._toolbarHost && this._overviewHost && this._listHost) {
      this._toolbarHost.innerHTML = "";
      if (this._enabled === false) {
        this._listHost.innerHTML = this._stateCard(
          "UNAVAILABLE",
          "Broker run history is disabled.",
          "runs-disabled",
        );
        return;
      }
      if (this._loading && !this._runs.length) {
        this._listHost.innerHTML = this._stateCard(
          "LOADING",
          "Loading run history…",
        );
        return;
      }
      if (this._error) {
        this._listHost.innerHTML =
          this._stateCard("UNAVAILABLE", this._error, "runs-unavailable") +
          '<button type="button" class="runs-back" id="runsRetry">Retry now</button>';
        const retry = this._listHost.querySelector("#runsRetry");
        if (retry) retry.addEventListener("click", () => this._retryNow());
        return;
      }
      this._toolbarHost.innerHTML = this._selector();
      this._listHost.innerHTML = this._selectedRun
        ? this._mode === "timeline"
          ? this._timelineView()
          : this._roleView()
        : this._projectView();
      this._bindHosts();
      return;
    }
    if (this._enabled === false) {
      this.innerHTML = this._stateCard(
        "UNAVAILABLE",
        "Broker run history is disabled.",
        "runs-disabled",
      );
      return;
    }
    if (this._loading && !this._runs.length) {
      this.innerHTML = this._stateCard("LOADING", "Loading run history…");
      return;
    }
    if (this._error) {
      this.innerHTML =
        this._stateCard("UNAVAILABLE", this._error, "runs-unavailable") +
        '<button type="button" class="runs-back" id="runsRetry">Retry now</button>';
      const r = this.querySelector("#runsRetry");
      if (r) r.addEventListener("click", () => this._retryNow());
      return;
    }
    this.innerHTML =
      this._selector() +
      '<div class="runs-overview-slot" id="runsOverviewSlot"></div>' +
      (this._selectedRun
        ? this._mode === "timeline"
          ? this._timelineView()
          : this._roleView()
        : this._projectView());
    if (this._overview) {
      const slot = this.querySelector("#runsOverviewSlot");
      if (slot) slot.appendChild(this._overview);
    }
    this._bind();
    document.body.classList.toggle("lctx-run-selected", !!this._selectedRun);
  }

  _bindHosts() {
    this._bind(this._toolbarHost);
    this._bind(this._listHost);
  }
  _bind(root = this) {
    const s = root.querySelector("#runsSelector");
    if (s)
      s.addEventListener("change", (e) => {
        this._project = e.target.value;
        this._runLimit = 25;
        this._selectedRun = null;
        this._selectedRole = null;
        this._selectedInstance = null;
        this._selected = null;
        this._navigate("", false);
        this.render();
      });
    root.querySelectorAll("[data-range]").forEach((button) =>
      button.addEventListener("click", () => {
        document.dispatchEvent(
          new CustomEvent("lctx:runs-range", {
            detail: { days: Number(button.dataset.range) },
          }),
        );
      }),
    );
    root.querySelectorAll("[data-project]").forEach((e) =>
      e.addEventListener("click", () => {
        this._project = e.dataset.project;
        this._runLimit = 25;
        this._navigate("", false);
        this.render();
      }),
    );
    root.querySelectorAll("[data-run-id]").forEach((e) =>
      e.addEventListener("click", () => {
        this._selectedRun = e.dataset.runId;
        this._selectedRole = null;
        this._selectedInstance = null;
        this._mode = "role";
        this._navigate("", false);
        this.render();
      }),
    );
    root.querySelectorAll("[data-role-toggle]").forEach((e) =>
      e.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const r = e.dataset.roleToggle;
        if (this._expandedRoles.has(r)) this._expandedRoles.delete(r);
        else this._expandedRoles.add(r);
        this.render();
      }),
    );
    root.querySelectorAll("[data-role]").forEach((e) =>
      e.addEventListener("click", () => {
        this._selectedRole = e.dataset.role;
        this._selectedInstance = null;
        this._selected = null;
        this._expandedRoles.add(e.dataset.role);
        this._navigate("", false);
        this.render();
      }),
    );
    root.querySelectorAll("[data-instance]").forEach((e) =>
      e.addEventListener("click", () => {
        this._selected = e.dataset.instance;
        this._selectedInstance =
          this._runs.find(
            (r) => String(r.namespace || "").toLowerCase() === this._selected,
          ) || null;
        this._selectedRole = this._selectedInstance
          ? roleName(this._selectedInstance)
          : this._selectedRole;
        this._expandedRoles.add(this._selectedRole);
        this._navigate(this._selected);
      }),
    );
    root.querySelectorAll("[data-mode]").forEach((e) =>
      e.addEventListener("click", () => {
        this._mode = e.dataset.mode;
        this._navigate(this._selected || "", false);
        this.render();
      }),
    );
    root.querySelectorAll("[data-crumb]").forEach((e) =>
      e.addEventListener("click", () => {
        const key = e.dataset.crumb;
        if (key === "projects") {
          this._project = "";
          this._selectedRun = null;
          this._selectedRole = null;
          this._selectedInstance = null;
          this._selected = null;
        } else if (key === "project") {
          this._selectedRun = null;
          this._selectedRole = null;
          this._selectedInstance = null;
          this._selected = null;
        } else if (key === "run") {
          this._selectedRole = null;
          this._selectedInstance = null;
          this._selected = null;
        } else if (key === "role") {
          this._selectedInstance = null;
          this._selected = null;
        }
        this._navigate("", false);
        this.render();
      }),
    );
    const loadMore = root.querySelector("#runsLoadMore");
    if (loadMore)
      loadMore.addEventListener("click", () => {
        this._runLimit += 25;
        this.render();
      });
  }
}
customElements.define("cockpit-runs", CockpitRuns);
export { CockpitRuns, normalizedBasePath, routePath, scopeUrl };
