use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

const ROOT_ENV: &str = "LEANCTX_ASSIGNMENTD_ROOT";
const MAX_BROKER_JSON: u64 = 2 * 1024 * 1024;
const MAX_STATUS_JSON: u64 = 64 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS: usize = 4096;
const NAMESPACE_LEN: usize = 64;

type RouteResponse = (&'static str, &'static str, String);

#[derive(Debug, Deserialize)]
struct BrokerDocument {
    assignments: HashMap<String, Assignment>,
    #[serde(default)]
    archives: Vec<ArchiveInventory>,
}

#[derive(Debug, Deserialize)]
struct Assignment {
    namespace: String,
    task_id: String,
    assignment_id: String,
    member_id: String,
    status: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    last_seen_at: Option<String>,
    #[serde(default)]
    archive_state: Option<String>,
    #[serde(default)]
    archive_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ArchiveInventory {
    archive_id: String,
    task_id: String,
    assignment_id: String,
    member_id: String,
    namespace: String,
    path: PathBuf,
    sha256: String,
    archive_state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataError {
    Disabled,
    Unavailable,
    Malformed,
    NotFound,
}

impl DataError {
    fn status(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Unavailable => "unavailable",
            Self::Malformed => "malformed",
            Self::NotFound => "not_found",
        }
    }

    fn http_status(self) -> &'static str {
        match self {
            Self::Disabled | Self::Unavailable => "503 Service Unavailable",
            Self::Malformed => "500 Internal Server Error",
            Self::NotFound => "404 Not Found",
        }
    }

    fn response(self, namespace: Option<&str>) -> RouteResponse {
        let mut body = json!({ "enabled": self != Self::Disabled, "status": self.status() });
        if let Some(namespace) = namespace {
            body["namespace"] = json!(namespace);
        }
        (self.http_status(), "application/json", body.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum MetricsStatus {
    Available,
    Unavailable,
    Malformed,
}

#[derive(Debug, Serialize)]
struct MetricsProjection {
    status: MetricsStatus,
    source: &'static str,
    requests_total: Option<u64>,
    tokens_saved_total: Option<u64>,
    bytes_compressed: Option<u64>,
    tokens_processed: Option<u64>,
    proxy_active: Option<bool>,
    model: Option<String>,
    provider: Option<String>,
    introspection_status: MetricsStatus,
}

impl MetricsProjection {
    fn failed(status: MetricsStatus, source: &'static str) -> Self {
        Self {
            status,
            source,
            requests_total: None,
            tokens_saved_total: None,
            bytes_compressed: None,
            tokens_processed: None,
            proxy_active: None,
            model: None,
            provider: None,
            introspection_status: MetricsStatus::Unavailable,
        }
    }
}

#[derive(Debug, Serialize)]
struct RunProjection<'a> {
    namespace: &'a str,
    task_id: &'a str,
    assignment_id: &'a str,
    member_id: &'a str,
    status: &'a str,
    created_at: Option<&'a str>,
    last_seen_at: Option<&'a str>,
    archive_state: &'a str,
    archive_id: Option<&'a str>,
    metrics: MetricsProjection,
}

#[derive(Default, Serialize)]
struct Aggregate {
    status: &'static str,
    total_runs: u64,
    metrics_available: u64,
    metrics_unavailable: u64,
    metrics_malformed: u64,
    requests_total: Option<u64>,
    requests_total_runs: u64,
    tokens_saved_total: Option<u64>,
    tokens_saved_total_runs: u64,
    bytes_compressed: Option<u64>,
    bytes_compressed_runs: u64,
    tokens_processed: Option<u64>,
    tokens_processed_runs: u64,
}

impl Aggregate {
    fn new() -> Self {
        Self {
            status: "available",
            ..Self::default()
        }
    }

    fn add(run: &RunProjection<'_>, aggregate: &mut Self) {
        aggregate.total_runs = aggregate.total_runs.saturating_add(1);
        match run.metrics.status {
            MetricsStatus::Available => {
                aggregate.metrics_available = aggregate.metrics_available.saturating_add(1)
            }
            MetricsStatus::Unavailable => {
                aggregate.metrics_unavailable = aggregate.metrics_unavailable.saturating_add(1)
            }
            MetricsStatus::Malformed => {
                aggregate.metrics_malformed = aggregate.metrics_malformed.saturating_add(1)
            }
        }
        add_measured(
            &mut aggregate.requests_total,
            &mut aggregate.requests_total_runs,
            run.metrics.requests_total,
        );
        add_measured(
            &mut aggregate.tokens_saved_total,
            &mut aggregate.tokens_saved_total_runs,
            run.metrics.tokens_saved_total,
        );
        add_measured(
            &mut aggregate.bytes_compressed,
            &mut aggregate.bytes_compressed_runs,
            run.metrics.bytes_compressed,
        );
        add_measured(
            &mut aggregate.tokens_processed,
            &mut aggregate.tokens_processed_runs,
            run.metrics.tokens_processed,
        );
    }
}

fn add_measured(total: &mut Option<u64>, measured_runs: &mut u64, value: Option<u64>) {
    if let Some(value) = value {
        *total = Some(total.unwrap_or(0).saturating_add(value));
        *measured_runs = measured_runs.saturating_add(1);
    }
}

pub(super) fn handle(path: &str) -> Option<RouteResponse> {
    if path == "/api/runs" || path == "/api/runs/" {
        return Some(match list_runs() {
            Ok(value) => ok(value),
            Err(error) => error.response(None),
        });
    }

    let namespace = path.strip_prefix("/api/runs/")?;
    let namespace = namespace.strip_suffix('/').unwrap_or(namespace);
    if !valid_namespace(namespace) {
        return Some((
            "400 Bad Request",
            "application/json",
            json!({ "status": "invalid_namespace", "error": "invalid namespace" }).to_string(),
        ));
    }
    Some(match run_detail(namespace) {
        Ok(value) => ok(value),
        Err(error) => error.response(Some(namespace)),
    })
}

pub(in crate::dashboard) fn is_run_page(path: &str) -> bool {
    let Some(namespace) = path.strip_prefix("/runs/") else {
        return false;
    };
    valid_namespace(namespace.strip_suffix('/').unwrap_or(namespace))
}

fn valid_namespace(value: &str) -> bool {
    value.len() == NAMESPACE_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn ok(value: Value) -> RouteResponse {
    ("200 OK", "application/json", value.to_string())
}

fn configured_root() -> Result<PathBuf, DataError> {
    let value = std::env::var(ROOT_ENV).map_err(|_| DataError::Disabled)?;
    let value = value.trim();
    if value.is_empty() {
        return Err(DataError::Disabled);
    }
    Ok(PathBuf::from(value))
}

fn load_broker(root: &Path) -> Result<BrokerDocument, DataError> {
    let bytes = read_bounded_json(&root.join("broker.json"), MAX_BROKER_JSON)?;
    serde_json::from_slice(&bytes).map_err(|_| DataError::Malformed)
}

fn read_bounded_json(path: &Path, limit: u64) -> Result<Vec<u8>, DataError> {
    let metadata = std::fs::symlink_metadata(path).map_err(map_io_error)?;
    if !metadata.file_type().is_file() || metadata.len() > limit {
        return Err(DataError::Malformed);
    }
    let file = File::open(path).map_err(map_io_error)?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DataError::Unavailable)?;
    if bytes.len() as u64 > limit {
        return Err(DataError::Malformed);
    }
    Ok(bytes)
}

fn map_io_error(error: io::Error) -> DataError {
    if error.kind() == io::ErrorKind::NotFound {
        DataError::Unavailable
    } else {
        DataError::Unavailable
    }
}

fn list_runs() -> Result<Value, DataError> {
    let root = configured_root()?;
    let broker = load_broker(&root)?;
    let mut assignments: Vec<(&String, &Assignment)> = broker.assignments.iter().collect();
    assignments.sort_by(|left, right| left.0.cmp(right.0));

    let mut aggregate = Aggregate::new();
    let mut runs = Vec::with_capacity(assignments.len());
    for (key, assignment) in assignments {
        if key != &assignment.namespace {
            return Err(DataError::Malformed);
        }
        let run = project_run(&root, &broker, assignment)?;
        Aggregate::add(&run, &mut aggregate);
        runs.push(run);
    }
    Ok(json!({ "enabled": true, "status": "available", "aggregate": aggregate, "runs": runs }))
}

fn run_detail(namespace: &str) -> Result<Value, DataError> {
    let root = configured_root()?;
    let broker = load_broker(&root)?;
    let assignment = broker
        .assignments
        .get(namespace)
        .ok_or(DataError::NotFound)?;
    if assignment.namespace != namespace {
        return Err(DataError::Malformed);
    }
    let run = project_run(&root, &broker, assignment)?;
    serde_json::to_value(run).map_err(|_| DataError::Malformed)
}

fn project_run<'a>(
    root: &Path,
    broker: &'a BrokerDocument,
    assignment: &'a Assignment,
) -> Result<RunProjection<'a>, DataError> {
    if !valid_namespace(&assignment.namespace) {
        return Err(DataError::Malformed);
    }
    let metrics = if assignment.status == "archived" {
        read_archived_metrics(root, broker, assignment)
    } else {
        read_live_metrics(root, &assignment.namespace)
    };
    Ok(RunProjection {
        namespace: &assignment.namespace,
        task_id: &assignment.task_id,
        assignment_id: &assignment.assignment_id,
        member_id: &assignment.member_id,
        status: &assignment.status,
        created_at: assignment.created_at.as_deref(),
        last_seen_at: assignment.last_seen_at.as_deref(),
        archive_state: assignment.archive_state.as_deref().unwrap_or("none"),
        archive_id: assignment.archive_id.as_deref(),
        metrics,
    })
}

fn read_live_metrics(root: &Path, namespace: &str) -> MetricsProjection {
    let data = root.join("assignments").join(namespace).join("data");
    let metrics = match read_status(&data.join("proxy_metrics.json")) {
        Ok(value) => value,
        Err(DataError::Malformed) => {
            return MetricsProjection::failed(MetricsStatus::Malformed, "live");
        }
        Err(_) => return MetricsProjection::failed(MetricsStatus::Unavailable, "live"),
    };
    let introspect = read_optional_introspection(&data.join("proxy-introspect.json"));
    metrics_projection(&metrics, introspect.as_ref(), "live")
}

fn read_status(path: &Path) -> Result<Value, DataError> {
    let bytes = read_bounded_json(path, MAX_STATUS_JSON)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| DataError::Malformed)?;
    if !value.is_object() {
        return Err(DataError::Malformed);
    }
    Ok(value)
}

fn read_optional_introspection(path: &Path) -> OptionalIntrospection {
    match read_status(path) {
        Ok(value) => OptionalIntrospection::Available(value),
        Err(DataError::Malformed) => OptionalIntrospection::Malformed,
        Err(_) => OptionalIntrospection::Unavailable,
    }
}

#[derive(Debug)]
enum OptionalIntrospection {
    Available(Value),
    Unavailable,
    Malformed,
}

impl OptionalIntrospection {
    fn as_ref(&self) -> OptionalIntrospectionRef<'_> {
        match self {
            Self::Available(value) => OptionalIntrospectionRef::Available(value),
            Self::Unavailable => OptionalIntrospectionRef::Unavailable,
            Self::Malformed => OptionalIntrospectionRef::Malformed,
        }
    }
}

#[derive(Clone, Copy)]
enum OptionalIntrospectionRef<'a> {
    Available(&'a Value),
    Unavailable,
    Malformed,
}

fn metrics_projection(
    metrics: &Value,
    introspection: OptionalIntrospectionRef<'_>,
    source: &'static str,
) -> MetricsProjection {
    let (introspection, introspection_status) = match introspection {
        OptionalIntrospectionRef::Available(value) => (Some(value), MetricsStatus::Available),
        OptionalIntrospectionRef::Unavailable => (None, MetricsStatus::Unavailable),
        OptionalIntrospectionRef::Malformed => (None, MetricsStatus::Malformed),
    };
    MetricsProjection {
        status: MetricsStatus::Available,
        source,
        requests_total: counter(metrics, &["requests_total"]),
        tokens_saved_total: counter(metrics, &["tokens_saved_total"]),
        bytes_compressed: counter(metrics, &["bytes_compressed"]),
        tokens_processed: introspection.and_then(|value| {
            counter(
                value,
                &["total_input_tokens", "tokens_processed", "input_tokens"],
            )
        }),
        proxy_active: introspection.and_then(|value| value.get("proxy_active")?.as_bool()),
        model: introspection.and_then(|value| safe_label(value.pointer("/last_breakdown/model"))),
        provider: introspection
            .and_then(|value| safe_label(value.pointer("/last_breakdown/provider"))),
        introspection_status,
    }
}

fn counter(document: &Value, names: &[&str]) -> Option<u64> {
    let object = document.as_object()?;
    for section in std::iter::once(object).chain(
        [
            "cumulative",
            "totals",
            "provider",
            "provider_reported",
            "usage",
        ]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_object)),
    ) {
        for name in names {
            if let Some(value) = section.get(*name).and_then(Value::as_u64) {
                return Some(value);
            }
        }
    }
    None
}

fn safe_label(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    if value.is_empty()
        || value.len() > 128
        || value.chars().any(|character| character.is_control())
    {
        return None;
    }
    Some(value.to_string())
}

fn read_archived_metrics(
    root: &Path,
    broker: &BrokerDocument,
    assignment: &Assignment,
) -> MetricsProjection {
    if assignment.archive_state.as_deref() != Some("available") {
        return MetricsProjection::failed(MetricsStatus::Unavailable, "archive");
    }
    let Some(archive_id) = assignment.archive_id.as_deref() else {
        return MetricsProjection::failed(MetricsStatus::Malformed, "archive");
    };
    let matches: Vec<&ArchiveInventory> = broker
        .archives
        .iter()
        .filter(|archive| {
            archive.archive_id == archive_id
                && archive.task_id == assignment.task_id
                && archive.assignment_id == assignment.assignment_id
                && archive.member_id == assignment.member_id
                && archive.namespace == assignment.namespace
        })
        .collect();
    if matches.len() != 1 || matches[0].archive_state != "available" {
        return MetricsProjection::failed(MetricsStatus::Malformed, "archive");
    }
    match archive_metrics(root, matches[0], ArchiveLimits::production()) {
        Ok((metrics, introspection)) => {
            metrics_projection(&metrics, introspection.as_ref(), "archive")
        }
        Err(DataError::Unavailable) => {
            MetricsProjection::failed(MetricsStatus::Unavailable, "archive")
        }
        Err(_) => MetricsProjection::failed(MetricsStatus::Malformed, "archive"),
    }
}

#[derive(Clone, Copy)]
struct ArchiveLimits {
    compressed: u64,
    expanded: u64,
    members: usize,
    status_json: u64,
}

impl ArchiveLimits {
    const fn production() -> Self {
        Self {
            compressed: MAX_ARCHIVE_BYTES,
            expanded: MAX_ARCHIVE_BYTES,
            members: MAX_ARCHIVE_MEMBERS,
            status_json: MAX_STATUS_JSON,
        }
    }
}

fn archive_metrics(
    root: &Path,
    inventory: &ArchiveInventory,
    limits: ArchiveLimits,
) -> Result<(Value, OptionalIntrospection), DataError> {
    let archives_root = root.join("archives");
    let canonical_root = archives_root
        .canonicalize()
        .map_err(|_| DataError::Unavailable)?;
    let metadata = std::fs::symlink_metadata(&inventory.path).map_err(map_io_error)?;
    if !metadata.file_type().is_file() || metadata.len() > limits.compressed {
        return Err(DataError::Malformed);
    }
    let canonical_path = inventory.path.canonicalize().map_err(map_io_error)?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(DataError::Malformed);
    }
    if !valid_digest(&inventory.sha256)
        || sha256_file(&canonical_path, limits.compressed)? != inventory.sha256
    {
        return Err(DataError::Malformed);
    }

    let file = File::open(&canonical_path).map_err(map_io_error)?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let metrics_path = PathBuf::from(format!("{}/data/proxy_metrics.json", inventory.namespace));
    let introspect_path = PathBuf::from(format!(
        "{}/data/proxy-introspect.json",
        inventory.namespace
    ));
    let mut seen = HashSet::new();
    let mut metrics = None;
    let mut introspection = OptionalIntrospection::Unavailable;
    let mut expanded = 0_u64;
    let mut members = 0_usize;

    let entries = archive.entries().map_err(|_| DataError::Malformed)?;
    for entry in entries {
        let mut entry = entry.map_err(|_| DataError::Malformed)?;
        members = members.saturating_add(1);
        if members > limits.members {
            return Err(DataError::Malformed);
        }
        let path = entry.path().map_err(|_| DataError::Malformed)?.into_owned();
        if !safe_archive_member(&path, &inventory.namespace) || !seen.insert(path.clone()) {
            return Err(DataError::Malformed);
        }
        let entry_type = entry.header().entry_type();
        if !(entry_type.is_file() || entry_type.is_dir()) {
            return Err(DataError::Malformed);
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or(DataError::Malformed)?;
        if expanded > limits.expanded {
            return Err(DataError::Malformed);
        }
        if path == metrics_path || path == introspect_path {
            if !entry_type.is_file() || entry.size() > limits.status_json {
                return Err(DataError::Malformed);
            }
            let value = read_archive_json(&mut entry, limits.status_json)?;
            if path == metrics_path {
                if metrics.replace(value).is_some() {
                    return Err(DataError::Malformed);
                }
            } else if matches!(introspection, OptionalIntrospection::Available(_)) {
                return Err(DataError::Malformed);
            } else {
                introspection = OptionalIntrospection::Available(value);
            }
        }
    }
    let metrics = metrics.ok_or(DataError::Malformed)?;
    Ok((metrics, introspection))
}

fn safe_archive_member(path: &Path, namespace: &str) -> bool {
    if path.is_absolute() {
        return false;
    }
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(first)) if first == namespace => {}
        _ => return false,
    }
    components.all(|component| matches!(component, Component::Normal(_)))
}

fn read_archive_json<R: Read>(reader: &mut R, limit: u64) -> Result<Value, DataError> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DataError::Malformed)?;
    if bytes.len() as u64 > limit {
        return Err(DataError::Malformed);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| DataError::Malformed)?;
    if !value.is_object() {
        return Err(DataError::Malformed);
    }
    Ok(value)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_file(path: &Path, limit: u64) -> Result<String, DataError> {
    let mut file = File::open(path).map_err(map_io_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|_| DataError::Unavailable)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > limit {
            return Err(DataError::Malformed);
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use tar::{Builder, EntryType, Header};
    use tempfile::TempDir;

    const NS: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn assignment(status: &str) -> Assignment {
        Assignment {
            namespace: NS.to_string(),
            task_id: "task-safe".to_string(),
            assignment_id: "assignment-safe".to_string(),
            member_id: "member-safe".to_string(),
            status: status.to_string(),
            created_at: None,
            last_seen_at: None,
            archive_state: Some("available".to_string()),
            archive_id: Some(format!("{NS}-0123456789abcdef")),
        }
    }

    fn append(builder: &mut Builder<GzEncoder<File>>, path: &str, body: &[u8]) {
        let mut header = Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        builder
            .append_data(&mut header, path, body)
            .expect("append");
    }

    fn archive_fixture(entries: &[(&str, &[u8])]) -> (TempDir, ArchiveInventory) {
        let td = tempfile::tempdir().expect("tempdir");
        let archives = td.path().join("archives");
        std::fs::create_dir(&archives).expect("archives");
        let path = archives.join(format!("{NS}-0123456789abcdef.tar.gz"));
        let file = File::create(&path).expect("archive");
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);
        for (name, body) in entries {
            append(&mut builder, name, body);
        }
        builder
            .into_inner()
            .expect("tar finish")
            .finish()
            .expect("gzip finish");
        let digest = sha256_file(&path, MAX_ARCHIVE_BYTES).expect("digest");
        (
            td,
            ArchiveInventory {
                archive_id: format!("{NS}-0123456789abcdef"),
                task_id: "task-safe".to_string(),
                assignment_id: "assignment-safe".to_string(),
                member_id: "member-safe".to_string(),
                namespace: NS.to_string(),
                path,
                sha256: digest,
                archive_state: "available".to_string(),
            },
        )
    }

    #[test]
    fn namespace_is_exact_lowercase_hex() {
        assert!(valid_namespace(NS));
        assert!(!valid_namespace(&NS.to_uppercase()));
        assert!(!valid_namespace(&NS[..63]));
        assert!(!valid_namespace(&format!("{NS}0")));
        assert!(!valid_namespace(&format!("{}g", &NS[..63])));
    }

    #[test]
    fn run_paths_accept_one_optional_trailing_slash() {
        assert!(is_run_page(&format!("/runs/{NS}")));
        assert!(is_run_page(&format!("/runs/{NS}/")));
        assert!(!is_run_page(&format!("/runs/{NS}//")));
        assert!(!is_run_page("/runs/missing"));
    }

    #[test]
    fn measured_zero_is_not_unavailable() {
        let metrics = json!({
            "requests_total": 0,
            "tokens_saved_total": 0,
            "bytes_compressed": 0,
            "token": "must-not-leak",
            "prompt": "must-not-leak"
        });
        let introspect = json!({
            "proxy_active": false,
            "cumulative": { "total_input_tokens": 0 },
            "last_breakdown": { "model": "safe-model", "provider": "safe-provider", "raw": "secret" }
        });
        let projected = metrics_projection(
            &metrics,
            OptionalIntrospectionRef::Available(&introspect),
            "live",
        );
        let output = serde_json::to_string(&projected).expect("serialize");
        assert_eq!(projected.requests_total, Some(0));
        assert_eq!(projected.tokens_saved_total, Some(0));
        assert_eq!(projected.bytes_compressed, Some(0));
        assert_eq!(projected.tokens_processed, Some(0));
        assert!(!output.contains("must-not-leak"));
        assert!(!output.contains("prompt"));
        assert!(!output.contains("raw"));
    }

    #[test]
    fn aggregate_distinguishes_unavailable_from_zero() {
        let mut aggregate = Aggregate::new();
        let mut run = RunProjection {
            namespace: NS,
            task_id: "task",
            assignment_id: "assignment",
            member_id: "member",
            status: "active",
            created_at: None,
            last_seen_at: None,
            archive_state: "none",
            archive_id: None,
            metrics: MetricsProjection::failed(MetricsStatus::Unavailable, "live"),
        };
        Aggregate::add(&run, &mut aggregate);
        assert_eq!(aggregate.requests_total, None);
        run.metrics.requests_total = Some(0);
        run.metrics.status = MetricsStatus::Available;
        Aggregate::add(&run, &mut aggregate);
        assert_eq!(aggregate.requests_total, Some(0));
        assert_eq!(aggregate.requests_total_runs, 1);
    }

    #[test]
    fn exact_archive_metrics_and_introspection_are_allowlisted() {
        let metrics_path = format!("{NS}/data/proxy_metrics.json");
        let introspect_path = format!("{NS}/data/proxy-introspect.json");
        let (td, inventory) = archive_fixture(&[
            (
                &metrics_path,
                br#"{"requests_total":7,"tokens_saved_total":11,"bytes_compressed":13,"token":"hidden"}"#,
            ),
            (
                &introspect_path,
                br#"{"proxy_active":false,"cumulative":{"total_input_tokens":17},"last_breakdown":{"model":"m","provider":"p","prompt":"hidden"}}"#,
            ),
        ]);
        let (metrics, introspection) =
            archive_metrics(td.path(), &inventory, ArchiveLimits::production()).expect("valid");
        let projected = metrics_projection(&metrics, introspection.as_ref(), "archive");
        assert_eq!(projected.requests_total, Some(7));
        assert_eq!(projected.tokens_saved_total, Some(11));
        assert_eq!(projected.bytes_compressed, Some(13));
        assert_eq!(projected.tokens_processed, Some(17));
        let output = serde_json::to_string(&projected).expect("serialize");
        assert!(!output.contains("hidden"));
    }

    #[test]
    fn archive_checksum_mismatch_is_rejected() {
        let path = format!("{NS}/data/proxy_metrics.json");
        let (td, mut inventory) = archive_fixture(&[(&path, br#"{"requests_total":1}"#)]);
        inventory.sha256 = "0".repeat(64);
        assert_eq!(
            archive_metrics(td.path(), &inventory, ArchiveLimits::production()).unwrap_err(),
            DataError::Malformed
        );
    }

    #[test]
    fn archive_duplicate_target_is_rejected() {
        let path = format!("{NS}/data/proxy_metrics.json");
        let (td, inventory) = archive_fixture(&[
            (&path, br#"{"requests_total":1}"#),
            (&path, br#"{"requests_total":2}"#),
        ]);
        assert_eq!(
            archive_metrics(td.path(), &inventory, ArchiveLimits::production()).unwrap_err(),
            DataError::Malformed
        );
    }

    #[test]
    fn archive_member_path_validation_rejects_escape_and_wrong_root() {
        assert!(safe_archive_member(
            Path::new(&format!("{NS}/data/proxy_metrics.json")),
            NS
        ));
        assert!(!safe_archive_member(Path::new("/etc/passwd"), NS));
        assert!(!safe_archive_member(
            Path::new(&format!("{NS}/../escape")),
            NS
        ));
        assert!(!safe_archive_member(Path::new("wrong/data/file"), NS));
    }

    #[test]
    fn archive_link_entry_is_rejected() {
        let td = tempfile::tempdir().expect("tempdir");
        let archives = td.path().join("archives");
        std::fs::create_dir(&archives).expect("archives");
        let path = archives.join("link.tar.gz");
        let encoder = GzEncoder::new(File::create(&path).expect("file"), Compression::default());
        let mut builder = Builder::new(encoder);
        let metrics_path = format!("{NS}/data/proxy_metrics.json");
        append(&mut builder, &metrics_path, br#"{"requests_total":1}"#);
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_link_name("target").expect("link name");
        header.set_cksum();
        builder
            .append_data(&mut header, format!("{NS}/link"), io::empty())
            .expect("append link");
        builder
            .into_inner()
            .expect("tar finish")
            .finish()
            .expect("gzip finish");
        let inventory = ArchiveInventory {
            archive_id: "id".to_string(),
            task_id: "t".to_string(),
            assignment_id: "a".to_string(),
            member_id: "m".to_string(),
            namespace: NS.to_string(),
            sha256: sha256_file(&path, MAX_ARCHIVE_BYTES).expect("digest"),
            path,
            archive_state: "available".to_string(),
        };
        assert_eq!(
            archive_metrics(td.path(), &inventory, ArchiveLimits::production()).unwrap_err(),
            DataError::Malformed
        );
    }

    #[test]
    fn archive_member_and_expanded_limits_are_enforced() {
        let metrics_path = format!("{NS}/data/proxy_metrics.json");
        let extra_path = format!("{NS}/data/extra");
        let (td, inventory) = archive_fixture(&[
            (&metrics_path, br#"{"requests_total":1}"#),
            (&extra_path, b"12345678"),
        ]);
        let limits = ArchiveLimits {
            compressed: MAX_ARCHIVE_BYTES,
            expanded: 7,
            members: MAX_ARCHIVE_MEMBERS,
            status_json: MAX_STATUS_JSON,
        };
        assert_eq!(
            archive_metrics(td.path(), &inventory, limits).unwrap_err(),
            DataError::Malformed
        );
        let limits = ArchiveLimits {
            expanded: MAX_ARCHIVE_BYTES,
            members: 1,
            ..limits
        };
        assert_eq!(
            archive_metrics(td.path(), &inventory, limits).unwrap_err(),
            DataError::Malformed
        );
    }

    #[test]
    fn archived_lookup_requires_exact_unique_inventory_tuple() {
        let assignment = assignment("archived");
        let wrong = ArchiveInventory {
            archive_id: assignment.archive_id.clone().expect("id"),
            task_id: "wrong-task".to_string(),
            assignment_id: assignment.assignment_id.clone(),
            member_id: assignment.member_id.clone(),
            namespace: assignment.namespace.clone(),
            path: PathBuf::from("unused"),
            sha256: "0".repeat(64),
            archive_state: "available".to_string(),
        };
        let broker = BrokerDocument {
            assignments: HashMap::new(),
            archives: vec![wrong],
        };
        let projected = read_archived_metrics(Path::new("unused"), &broker, &assignment);
        assert_eq!(projected.status, MetricsStatus::Malformed);
    }

    #[test]
    fn live_failure_never_falls_back_to_archive() {
        let assignment = assignment("active");
        let broker = BrokerDocument {
            assignments: HashMap::new(),
            archives: Vec::new(),
        };
        let td = tempfile::tempdir().expect("tempdir");
        let run = project_run(td.path(), &broker, &assignment).expect("projection");
        assert_eq!(run.metrics.source, "live");
        assert_eq!(run.metrics.status, MetricsStatus::Unavailable);
    }

    fn write_broker(root: &Path, assignments: Value) {
        std::fs::write(
            root.join("broker.json"),
            json!({ "assignments": assignments, "archives": [] }).to_string(),
        )
        .expect("broker");
    }

    #[test]
    fn api_reports_disabled_unavailable_malformed_and_not_found_distinctly() {
        let _env_lock = crate::core::data_dir::test_env_lock();
        crate::test_env::remove_var(ROOT_ENV);
        let (status, _, body) = handle("/api/runs").expect("route");
        assert_eq!(status, "503 Service Unavailable");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["status"],
            "disabled"
        );

        let td = tempfile::tempdir().expect("tempdir");
        crate::test_env::set_var(ROOT_ENV, td.path());
        let (status, _, body) = handle("/api/runs").expect("route");
        assert_eq!(status, "503 Service Unavailable");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["status"],
            "unavailable"
        );

        std::fs::write(td.path().join("broker.json"), "not-json").expect("broker");
        let (status, _, body) = handle("/api/runs").expect("route");
        assert_eq!(status, "500 Internal Server Error");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["status"],
            "malformed"
        );

        write_broker(td.path(), json!({}));
        let (status, _, body) = handle(&format!("/api/runs/{NS}")).expect("route");
        assert_eq!(status, "404 Not Found");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["status"],
            "not_found"
        );
        crate::test_env::remove_var(ROOT_ENV);
    }

    #[test]
    fn live_api_uses_real_schema_and_discloses_no_raw_secrets() {
        let _env_lock = crate::core::data_dir::test_env_lock();
        let td = tempfile::tempdir().expect("tempdir");
        let data = td.path().join("assignments").join(NS).join("data");
        std::fs::create_dir_all(&data).expect("data");
        std::fs::write(
            data.join("proxy_metrics.json"),
            r#"{"requests_total":3,"tokens_saved_total":5,"bytes_compressed":7,"token":"raw-secret"}"#,
        )
        .expect("metrics");
        std::fs::write(
            data.join("proxy-introspect.json"),
            r#"{"proxy_active":true,"cumulative":{"total_input_tokens":9},"last_breakdown":{"model":"model","provider":"provider","prompt":"raw-secret"}}"#,
        )
        .expect("introspect");
        write_broker(
            td.path(),
            json!({
                NS: {
                    "namespace": NS,
                    "task_id": "task",
                    "assignment_id": "assignment",
                    "member_id": "member",
                    "status": "active",
                    "archive_state": "none",
                    "token": "raw-secret"
                }
            }),
        );
        crate::test_env::set_var(ROOT_ENV, td.path());
        for path in [format!("/api/runs/{NS}"), format!("/api/runs/{NS}/")] {
            let (status, _, body) = handle(&path).expect("route");
            assert_eq!(status, "200 OK");
            let payload: Value = serde_json::from_str(&body).expect("json");
            assert_eq!(payload["metrics"]["requests_total"], 3);
            assert_eq!(payload["metrics"]["tokens_saved_total"], 5);
            assert_eq!(payload["metrics"]["bytes_compressed"], 7);
            assert_eq!(payload["metrics"]["tokens_processed"], 9);
            assert!(!body.contains("raw-secret"));
            assert!(!body.contains("prompt"));
            assert!(!body.contains("token\""));
        }
        let (status, _, _) = handle("/api/runs/INVALID").expect("route");
        assert_eq!(status, "400 Bad Request");
        crate::test_env::remove_var(ROOT_ENV);
    }
}
