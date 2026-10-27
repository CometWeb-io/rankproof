"""RankProof Agent API v1. No implicit retries or credential-bearing redirects."""
from __future__ import annotations

import json
import math
import ipaddress
import unicodedata
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, NotRequired, TypedDict, cast
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

__all__ = ["RankProofClient", "RankProofApiError", "VerifyPair", "Observation", "SerpInput", "SerpResult", "ImportResult", "DiffResult", "IntegrityResult", "Capabilities"]
_SCHEMAS = json.loads(Path(__file__).with_name("schema.json").read_text())["$defs"]

class VerifyPair(TypedDict):
    source_url: str
    target_url: str

class Observation(VerifyPair):
    status: Literal["confirmed", "not_found", "error"]
    checked_at: str
    final_url: str | None
    http_status: int | None
    anchor: str | None
    rel: str | None
    reason: str | None
    evidence_kind: Literal["html_anchor"] | None
    observation_method: Literal["fetched_html"]
    absence_scope: Literal["fetched_html", "http_resource"] | None
    extraction_version: str
    identity_policy: str
    source_revision: str | None
    response_hash: str | None
    raw_href: str | None
    resolved_href: str | None

class StoredObservation(Observation):
    observation_id: str

class Persistence(TypedDict):
    kind: Literal["bounded_process_memory", "bounded_sqlite"]
    max_reports: int
    max_bytes: int
    ttl_seconds: int | None

class VerifyResult(TypedDict):
    report_id: str
    created_at: str
    results: list[StoredObservation]
    persistence: Persistence

class EvidenceResult(TypedDict):
    report_id: str
    observation: StoredObservation
    persistence: Persistence

class Finding(TypedDict):
    observation_id: str
    kind: Literal["link_present", "absent_in_fetched_html", "source_unavailable", "measurement_unknown"]
    scope: Literal["fetched_html", "http_resource"] | None
    reason: str | None

class FindingsResult(TypedDict):
    report_id: str
    findings: list[Finding]
    persistence: Persistence

class SerpInput(TypedDict):
    url: str
    keywords: list[str]
    engines: NotRequired[list[Literal["bing", "duckduckgo", "mojeek", "brave", "google"]]]
    market: NotRequired[Literal["pl", "us", "gb", "de", "fr", "es"]]
    device: NotRequired[Literal["desktop", "mobile"]]
    depth: NotRequired[Literal[10, 20]]

class SerpHit(TypedDict):
    position: int
    url: str
    title: str

class SerpQuery(TypedDict):
    keyword: str
    engine: Literal["bing", "duckduckgo", "mojeek", "brave", "google"]
    market: Literal["pl", "us", "gb", "de", "fr", "es"]
    device: Literal["desktop", "mobile"]
    status: Literal["ok", "no-results", "blocked", "rate-limited", "parser-failed", "empty-response", "not-configured", "error"]
    target_position: int | None
    depth: int
    results: list[SerpHit]

class SerpResult(TypedDict):
    observed_at: str
    queries: list[SerpQuery]

class Provenance(TypedDict):
    connector_id: Literal["byo-dataset"]
    dataset_id: str
    dataset_sha256: str
    format: Literal["csv", "json"]
    imported_at: str
    row_number: int
    original_record: dict[str, Any]

class ImportedCandidate(VerifyPair):
    verification_status: Literal["unverified"]
    provenance: Provenance

class ImportResult(TypedDict):
    schema_version: Literal["1"]
    connector_id: Literal["byo-dataset"]
    status: Literal["ok", "no-results"]
    records: list[ImportedCandidate]
    observed_at: str
    reason: None

class RelationshipObservation(TypedDict):
    pairId: str
    sourceUrl: str
    targetUrl: str
    observedAt: str
    status: Literal["CONFIRMED", "REPORTED", "NOT_FOUND_IN_HTML", "BLOCKED", "UNKNOWN"]
    extractionVersion: str
    identityPolicy: str
    representation: Literal["fetched_html", "rendered_dom"]
    resolvedSourceUrl: str | None
    responseHash: str | None
    completeHtml: bool
    anchor: NotRequired[str]
    rel: NotRequired[str]
    placement: NotRequired[str]

class RelationshipComparison(TypedDict):
    pairId: str | None
    status: Literal["CONFIRMED_CHANGE", "CONFIRMED", "UNKNOWN"]
    change: Literal["absent_in_representation", "attributes_changed"] | None
    scope: Literal["fetched_html", "rendered_dom"] | None
    firstObserved: str | None
    lastConfirmed: str | None
    lastAttempted: str | None
    previousEvidence: RelationshipObservation | None
    currentEvidence: RelationshipObservation | None

class DiffResult(TypedDict):
    comparison: RelationshipComparison
    evidence_origin: Literal["caller_supplied_untrusted", "rankproof_session", "rankproof_history"]
    persistence: Literal["caller"]

class IntegrityResult(TypedDict):
    valid: bool
    integrity_scope: Literal["internal_hashes_only"]
    persistence: Literal["caller"]

class OperationInfo(TypedDict):
    name: str
    supported: bool

class ProviderInfo(TypedDict):
    id: str
    kind: str
    configured: bool
    availability: Literal["not-probed"]

class Limits(TypedDict):
    verify_items: int
    dataset_rows: int
    dataset_bytes: int
    keywords: int

class Capabilities(TypedDict):
    api_version: Literal["1"]
    operations: list[OperationInfo]
    providers: list[ProviderInfo]
    persistence: Persistence
    owner_data: Literal["explicit-credentials-in-process-only"]
    limits: Limits

class RankProofApiError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)

def _validate(value: Any, schema: dict[str, Any]) -> None:
    """Closed schema vocabulary emitted by RankProof; no third-party runtime required."""
    for branch in schema.get("allOf", []):
        _validate(value, branch)
    if "not" in schema:
        raise ValueError("Unsupported output")
    if "anyOf" in schema:
        for branch in schema["anyOf"]:
            try:
                _validate(value, branch)
                return
            except ValueError:
                pass
        raise ValueError("No matching schema branch")
    if "const" in schema and (type(value) is not type(schema["const"]) or value != schema["const"]):
        raise ValueError("Unexpected constant")
    if "enum" in schema and not any(type(value) is type(item) and value == item for item in schema["enum"]):
        raise ValueError("Unexpected enum")
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict) or any(key not in value for key in schema.get("required", [])):
            raise ValueError("Invalid object")
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False and value.keys() - props.keys():
            raise ValueError("Unknown fields")
        for key in value.keys() & props.keys():
            _validate(value[key], props[key])
    elif kind == "array":
        if not isinstance(value, list) or not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", math.inf):
            raise ValueError("Invalid array")
        for item in value:
            _validate(item, schema["items"])
    elif kind == "string":
        # JSON Schema lengths are Unicode code points.
        if not isinstance(value, str) or not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", math.inf):
            raise ValueError("Invalid string")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise ValueError("Invalid string pattern")
        if schema.get("format") == "date-time":
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError("Timezone required")
            except ValueError as error:
                raise ValueError("Invalid timestamp") from error
    elif kind == "integer" and (type(value) is not int or not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf)):
        raise ValueError("Invalid integer")
    elif kind == "boolean" and type(value) is not bool:
        raise ValueError("Invalid boolean")
    elif kind == "null" and value is not None:
        raise ValueError("Expected null")

def _exact_url(value: str) -> tuple[str, str, int | None, str, str, bool]:
    """Conservative URL identity: preserve path/query escapes, www and empty query."""
    # shortcut: unusual numeric hosts and backslash spellings fail closed; adopt a WHATWG parser if these inputs are needed.
    if "\\" in value:
        raise ValueError("Use a canonical HTTP URL without backslashes")
    url = urlsplit(value)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        raise ValueError("Invalid observation URL")
    host = unquote(url.hostname)
    if ":" in host:
        host = ipaddress.IPv6Address(host).compressed
    else:
        labels = [label[4:].encode("ascii").decode("punycode") if label.lower().startswith("xn--") else label for label in host.split(".")]
        host = unicodedata.normalize("NFKC", ".".join(labels)).lower()
    port = url.port
    if (url.scheme, port) in (("http", 80), ("https", 443)):
        port = None
    parts: list[str] = []
    segments = (url.path or "/").split("/")
    for index, segment in enumerate(segments):
        dotted = segment.lower().replace("%2e", ".")
        if dotted in (".", ".."):
            if dotted == ".." and len(parts) > 1:
                parts.pop()
            if index == len(segments) - 1:
                parts.append("")
        else:
            parts.append(segment)
    path_safe = "".join(chr(i) for i in range(33, 127) if chr(i) not in '\"#<>?`{}')
    query_safe = "".join(chr(i) for i in range(33, 127) if chr(i) not in "\"#<>'")
    return url.scheme, host, port, quote("/".join(parts), safe=path_safe), quote(url.query, safe=query_safe), "?" in value.split("#", 1)[0]

class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None

class RankProofClient:
    def __init__(self, endpoint: str = "http://127.0.0.1:8788", token: str | None = None, timeout: float = 90):
        url = urlsplit(endpoint)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("Expected HTTP(S) API origin/path without credentials, query or fragment")
        self._endpoint, self._token, self._timeout = endpoint.rstrip("/"), token, timeout
        self._opener = build_opener(_NoRedirect())

    def call(self, operation: str, data: dict[str, Any]) -> Any:
        key = operation + "_input"
        if key not in _SCHEMAS:
            raise RankProofApiError("unsupported", "Unknown operation")
        _validate(data, _SCHEMAS[key])
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = "Bearer " + self._token
        request = Request(self._endpoint + "/v1/agent/" + operation, data=json.dumps(data, allow_nan=False).encode(), headers=headers, method="POST")
        try:
            response = self._opener.open(request, timeout=self._timeout)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read(8_000_001)
            if len(raw) > 8_000_000:
                raise RankProofApiError("invalid_response", "Response exceeds 8 MB")
            try:
                payload = json.loads(raw)
                _validate(payload, _SCHEMAS[operation + "_response"])
                if payload["ok"] and operation in ("verify_backlinks", "remeasure_backlinks", "get_evidence"):
                    rows = [payload["data"]["observation"]] if operation == "get_evidence" else payload["data"]["results"]
                    for row in rows:
                        if row["status"] == "confirmed" and _exact_url(row["resolved_href"]) != _exact_url(row["target_url"]):
                            raise ValueError("Confirmed destination mismatch")
            except (ValueError, TypeError) as error:
                raise RankProofApiError("invalid_response", "Expected RankProof agent schema v1") from error
            if not payload["ok"]:
                raise RankProofApiError(payload["error"]["code"], payload["error"]["message"])
            if response.status != 200:
                raise RankProofApiError("invalid_response", "HTTP status mismatch")
            return payload["data"]

    def capabilities(self) -> Capabilities:
        return cast(Capabilities, self.call("capabilities", {}))

    def verify_backlinks(self, items: list[VerifyPair]) -> VerifyResult:
        return cast(VerifyResult, self.call("verify_backlinks", {"items": items}))

    def remeasure_backlinks(self, items: list[VerifyPair]) -> VerifyResult:
        return cast(VerifyResult, self.call("remeasure_backlinks", {"items": items}))

    def serp_status(self, data: SerpInput) -> SerpResult:
        return cast(SerpResult, self.call("serp_status", dict(data)))

    def import_dataset(self, *, format: Literal["csv", "json"], data: str, dataset_id: str) -> ImportResult:
        return cast(ImportResult, self.call("import_dataset", {"format": format, "data": data, "dataset_id": dataset_id}))

    def diff(self, before_id: str, after_id: str) -> DiffResult:
        return cast(DiffResult, self.call("diff", {"before_id": before_id, "after_id": after_id}))

    def get_evidence(self, observation_id: str) -> EvidenceResult:
        return cast(EvidenceResult, self.call("get_evidence", {"observation_id": observation_id}))

    def list_findings(self, report_id: str) -> FindingsResult:
        return cast(FindingsResult, self.call("list_findings", {"report_id": report_id}))

    def verify_evidence(self, ledger: dict[str, Any]) -> IntegrityResult:
        return cast(IntegrityResult, self.call("verify_evidence", {"ledger": ledger}))
