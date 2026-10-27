# RankProof Python client

Typed, standard-library client for the self-hosted RankProof Agent API v1. Requires Python 3.11+.

Install from the RankProof source checkout:

```sh
uv pip install ./sdk/python
```

```python
from rankproof_client import RankProofClient

client = RankProofClient("http://127.0.0.1:8788", token="your-service-token")
capabilities = client.capabilities()
report = client.verify_backlinks([{
    "source_url": "https://source.example/article",
    "target_url": "https://target.example/page",
}])
evidence = client.get_evidence(report["results"][0]["observation_id"])
findings = client.list_findings(report["report_id"])
```

The examples use reserved domains; use public URLs you are authorized to measure. Observe `status` and `absence_scope`: failed requests do not establish absence or loss. Imports stay unverified.

Verification receipts live in bounded process memory, expiring after one hour or earlier eviction, and disappear on restart. The client validates response schemas, rejects redirects, caps responses at 8 MB, uses a 90-second default timeout and never retries automatically. The bundled schema matches the source repository's versioned contract.

See the RankProof repository's `docs/agent-api.md` for the complete operation and retention contract. Source installation does not imply this SDK has been published to PyPI.
