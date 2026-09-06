#!/usr/bin/env python3
"""Export bounded, dashboard-safe OMS hierarchy metadata without exposing paths or prompts."""
from __future__ import annotations
import argparse, hashlib, json, os, re, sqlite3, tempfile
from pathlib import Path
MAX_PROJECTS, MAX_TASKS, MAX_ASSIGNMENTS, MAX_BYTES = 2048, 10000, 50000, 8 * 1024 * 1024
SAFE = re.compile(r"[^A-Za-z0-9 _.-]+")

def text(v, limit=160):
    if v is None: return None
    v = str(v).strip()
    if not v or len(v) > limit or any(ord(c) < 32 for c in v): return None
    return v

def human(v):
    v = text(v, 128)
    if not v: return None
    return SAFE.sub("", v.replace("_", " ").replace("-", " ")).strip() or None

def identifier(v, limit=256):
    v = text(v, limit)
    if not v or "/" in v or "\\" in v:
        return None
    return v

def rows(db, sql, params=()):
    return db.execute(sql, params).fetchall()

def export(db_path: Path, out: Path) -> None:
    uri = f"file:{db_path}?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    db.row_factory = sqlite3.Row
    tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
    required = {"tasks", "workspace_bindings", "assignments"}
    if not required.issubset(tables):
        raise RuntimeError("OMS schema is missing required tables")
    projects, roots = {}, {}
    for r in rows(db, "select task_id, normalized_root_path from workspace_bindings order by task_id limit ?", (MAX_TASKS,)):
        root = text(r["normalized_root_path"], 4096)
        if not root: continue
        normalized = os.path.normcase(os.path.normpath(root))
        pid = hashlib.sha256(normalized.encode()).hexdigest()
        roots[r["task_id"]] = pid
        projects.setdefault(pid, {"label": Path(normalized).name[:96] or "Workspace"})
    tasks = {}
    for r in rows(db, "select task_id, workflow_key, status, created_at, updated_at from tasks order by task_id limit ?", (MAX_TASKS,)):
        tid = text(r["task_id"], 256)
        if not tid: continue
        pid = roots.get(tid)
        workflow = identifier(r["workflow_key"])
        tasks[tid] = {"project_id": pid, "project_label": projects.get(pid, {}).get("label") if pid else None,
                      "workflow_key": workflow, "workflow_label": human(workflow), "status": text(r["status"], 96),
                      "created_at": text(r["created_at"], 64), "updated_at": text(r["updated_at"], 64)}
    attempts = {}
    if "attempts" in tables:
        for r in rows(db, "select assignment_id, status, opened_at, attempt_id from attempts order by assignment_id, opened_at, attempt_id"):
            aid = r["assignment_id"]
            item = attempts.setdefault(aid, {"attempt_count": 0, "attempt_status": None})
            item["attempt_count"] += 1
            item["attempt_status"] = text(r["status"], 96)
    timeline = {}
    if "dispatch_turns" in tables:
        q = "select assignment_id, min(coalesce(adapter_started_at, created_at)) t from dispatch_turns where assignment_id is not null group by assignment_id order by t, assignment_id limit ?"
        for i, r in enumerate(rows(db, q, (MAX_ASSIGNMENTS,)), 1):
            timeline[r["assignment_id"]] = (i, text(r["t"], 64), "dispatch")
    next_rank = max((v[0] for v in timeline.values()), default=0)
    assignments = {}
    q = "select assignment_id, task_id, member_id, parent_assignment_id, created_at, closed_at from assignments order by created_at, assignment_id limit ?"
    for r in rows(db, q, (MAX_ASSIGNMENTS,)):
        aid = text(r["assignment_id"], 256)
        tid = text(r["task_id"], 256)
        if not aid or not tid: continue
        if aid in timeline:
            rank, when, source = timeline[aid]
        else:
            next_rank += 1
            rank, when, source = next_rank, text(r["created_at"], 64), "assignment"
        a = {"task_id": tid, "parent_assignment_id": text(r["parent_assignment_id"], 256),
             "role_label": human(r["member_id"]), "created_at": text(r["created_at"], 64),
             "closed_at": text(r["closed_at"], 64), "timeline_rank": rank,
             "timeline_time": when, "timeline_source": source}
        a.update(attempts.get(aid, {}))
        assignments[aid] = a
    payload = {"schema": 1, "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
               "projects": dict(list(projects.items())[:MAX_PROJECTS]), "tasks": tasks, "assignments": assignments}
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode()
    if len(encoded) > MAX_BYTES: raise RuntimeError("metadata snapshot exceeds bound")
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=out.name + ".", dir=out.parent)
    try:
        with os.fdopen(fd, "wb") as f: f.write(encoded); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    db.close()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/home/serveradmin/.local/share/oh-my-subagents/oms.persistence", type=Path)
    ap.add_argument("--output", required=True, type=Path)
    a = ap.parse_args(); export(a.db, a.output)

if __name__ == "__main__": main()
