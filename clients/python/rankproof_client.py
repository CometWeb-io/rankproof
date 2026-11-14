"""Reference Python client for the RankProof HTTP API (schema "1").

Standard library only, so it can be vendored into any service (for example a
FastAPI backend) without new dependencies. Python 3.9+.

    from rankproof_client import RankProofClient

    client = RankProofClient("http://127.0.0.1:8787", token=None)
    client.require("backlinks.verify.contract.v1")
    results = client.verify([
        {"source_url": "https://publisher.example/post",
         "target_url": "https://you.example/guide",
         "expected_anchor": "Your Brand", "expected_rel": "sponsored"},
    ])
    for r in results:
        print(r.verdict, r.source_url, r.basis)

Contract notes for integrators:
  * Pin a RankProof version and check `revision`/`capabilities` at start-up
    (`require`), never assume features from `version` alone.
  * `status == "error"` / verdict "unverified" is a measurement gap. Never
    record it as a lost link; keep the previous observation.
  * Fields are additive within schema "1": ignore unknown keys.
  * The contract fixtures in `contract/fixtures/` are the source of truth for
    tests on the consumer side.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

SCHEMA_VERSION = "1"
MAX_BATCH = 50
VERDICTS = ("meets", "deviates", "missing", "unverified")


class RankProofError(RuntimeError):
    """Raised for transport errors, non-JSON replies and rejected requests."""

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Observation:
    """One verified pair. `raw` keeps every field, including ones added later."""

    source_url: str
    target_url: str
    status: str
    verdict: str
    basis: str
    checked_at: str
    anchor: Optional[str]
    rel: Optional[str]
    placement: Optional[str]
    response_hash: Optional[str]
    reason: Optional[str]
    notes: List[str] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def is_gap(self) -> bool:
        """True when nothing could be established. Not evidence of absence."""
        return self.verdict == "unverified"

    @classmethod
    def from_json(cls, item: Dict[str, Any]) -> "Observation":
        contract = item.get("contract") or {}
        verdict = contract.get("verdict") or _legacy_verdict(item.get("status"))
        return cls(
            source_url=item["source_url"],
            target_url=item["target_url"],
            status=item["status"],
            verdict=verdict,
            basis=contract.get("basis", "fetched_html"),
            checked_at=item.get("checked_at", ""),
            anchor=item.get("anchor"),
            rel=item.get("rel"),
            placement=item.get("placement"),
            response_hash=item.get("response_hash"),
            reason=item.get("reason"),
            notes=list(contract.get("notes") or []),
            raw=item,
        )


def _legacy_verdict(status: Optional[str]) -> str:
    # Servers without backlinks.verify.contract.v1 return no contract.
    return {"confirmed": "meets", "not_found": "missing"}.get(status or "", "unverified")


class RankProofClient:
    def __init__(self, base_url: str, token: Optional[str] = None, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._health: Optional[Dict[str, Any]] = None

    # -- transport -----------------------------------------------------------
    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Dict[str, Any]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.base_url + path, data=data, method=method)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            payload = error.read()
            status = error.code
        except urllib.error.URLError as error:
            raise RankProofError(f"RankProof unreachable: {error.reason}") from error
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except ValueError as error:
            raise RankProofError(f"RankProof returned non-JSON (HTTP {status})", status) from error
        if status >= 400 or parsed.get("ok") is False:
            raise RankProofError(parsed.get("error") or f"HTTP {status}", status)
        return parsed

    # -- API -------------------------------------------------------------------
    def health(self) -> Dict[str, Any]:
        self._health = self._request("GET", "/health")
        return self._health

    def require(self, *capabilities: str) -> Dict[str, Any]:
        """Fail fast at start-up when the server lacks a schema or capability."""
        health = self._health or self.health()
        if health.get("schema_version") != SCHEMA_VERSION:
            raise RankProofError(
                f"Unsupported RankProof schema {health.get('schema_version')!r}; expected {SCHEMA_VERSION!r}"
            )
        missing = [c for c in capabilities if c not in (health.get("capabilities") or [])]
        if missing:
            raise RankProofError(f"RankProof lacks capabilities: {', '.join(missing)}")
        return health

    def verify(
        self, items: Iterable[Dict[str, Any]], render: Optional[str] = None
    ) -> List[Observation]:
        """Verify any number of pairs (sent in batches of 50, order preserved).

        `render` is None, "fallback" or "always" and needs the server
        capability backlinks.verify.render.v1.
        """
        pairs = list(items)
        out: List[Observation] = []
        for start in range(0, len(pairs), MAX_BATCH):
            body: Dict[str, Any] = {"items": pairs[start : start + MAX_BATCH]}
            if render:
                body["render"] = render
            out.extend(parse_verify_response(self._request("POST", "/v1/backlinks/verify", body)))
        return out


def parse_verify_response(document: Dict[str, Any]) -> List[Observation]:
    if document.get("schema_version") != SCHEMA_VERSION:
        raise RankProofError(f"Unsupported schema_version {document.get('schema_version')!r}")
    return [Observation.from_json(item) for item in document.get("results") or []]


def summarize(observations: Sequence[Observation]) -> Dict[str, int]:
    counts = {verdict: 0 for verdict in VERDICTS}
    for item in observations:
        counts[item.verdict] = counts.get(item.verdict, 0) + 1
    counts["total"] = len(observations)
    return counts


def lost_links(previous: Sequence[Observation], current: Sequence[Observation]) -> List[Observation]:
    """Pairs confirmed before and missing now. Errors never count as losses."""
    before = {(o.source_url, o.target_url): o for o in previous}
    lost = []
    for item in current:
        old = before.get((item.source_url, item.target_url))
        if old and old.status == "confirmed" and item.verdict == "missing":
            lost.append(item)
    return lost
