import io
import json
import unittest
from rankproof_client import RankProofApiError, RankProofClient
from rankproof_client import _exact_url


class Response(io.BytesIO):
    status = 200


class Opener:
    def __init__(self, payload):
        self.payload = payload

    def open(self, _request, timeout):
        return Response(json.dumps(self.payload).encode())


class ClientContractTest(unittest.TestCase):
    def test_exact_destination_keeps_query_path_www_and_international_identity(self):
        self.assertEqual(_exact_url("https://bücher.example:443/zażółć?q=łódź%2f#sekcja"), _exact_url("https://xn--bcher-kva.example/za%C5%BC%C3%B3%C5%82%C4%87?q=%C5%82%C3%B3d%C5%BA%2f"))
        self.assertEqual(_exact_url("https://faß.example/a/../b#one"), _exact_url("https://xn--fa-hia.example/b#two"))
        for target in ["https://www.target.example/path?q=1", "https://target.example/other?q=1", "https://target.example/path?q=2"]:
            self.assertNotEqual(_exact_url("https://target.example/path?q=1"), _exact_url(target))
        self.assertNotEqual(_exact_url("https://faß.example/"), _exact_url("https://fass.example/"))
        self.assertNotEqual(_exact_url("https://target.example/a%2fb"), _exact_url("https://target.example/a/b"))
        self.assertNotEqual(_exact_url("https://target.example/a%2fb"), _exact_url("https://target.example/a%2Fb"))
        self.assertNotEqual(_exact_url("https://target.example/path?"), _exact_url("https://target.example/path"))
        self.assertNotEqual(_exact_url("https://target.example/a//b"), _exact_url("https://target.example/a/b"))

    def test_complete_but_inconsistent_confirmed_response_is_rejected(self):
        client = RankProofClient()
        observation = {"source_url": "https://source.example/article", "target_url": "https://target.example/page", "status": "confirmed", "checked_at": "2026-10-27T00:00:00.000Z", "final_url": "https://source.example/article", "http_status": 200, "anchor": "Reference", "rel": "", "reason": None, "evidence_kind": "html_anchor", "observation_method": "fetched_html", "absence_scope": None, "extraction_version": "fixture", "identity_policy": "fixture", "source_revision": None, "response_hash": "a" * 64, "raw_href": "https://foreign.example/", "resolved_href": "https://foreign.example/", "observation_id": "row"}
        retention = {"kind": "bounded_process_memory", "max_reports": 50, "max_bytes": 8000000, "ttl_seconds": 3600}
        for overrides in [{}, {"resolved_href": "https://target.example/page", "response_hash": None}, {"resolved_href": "https://target.example/page", "http_status": 403}]:
            client._opener = Opener({"ok": True, "schema_version": "1", "operation": "verify_backlinks", "data": {"report_id": "run", "created_at": "2026-10-27T00:00:00.000Z", "results": [{**observation, **overrides}], "persistence": retention}})
            with self.assertRaises(RankProofApiError) as caught:
                client.verify_backlinks([{"source_url": observation["source_url"], "target_url": observation["target_url"]}])
            self.assertEqual(caught.exception.code, "invalid_response")

    def test_malformed_success_error_foreign_operation_and_unknown_version(self):
        client = RankProofClient()
        for payload in [
            {"ok": False, "schema_version": "1", "error": None},
            {"ok": True, "schema_version": "1", "operation": "verify_backlinks", "data": {"results": [{"status": "confirmed"}]}},
            {"ok": True, "schema_version": "1", "operation": "capabilities", "data": {}},
            {"ok": True, "schema_version": "2", "operation": "verify_backlinks", "data": {}},
        ]:
            with self.subTest(payload=payload):
                client._opener = Opener(payload)
                with self.assertRaises(RankProofApiError) as caught:
                    client.verify_backlinks([{"source_url": "https://source.example/", "target_url": "https://target.example/"}])
                self.assertEqual(caught.exception.code, "invalid_response")

    def test_typed_operation_error(self):
        client = RankProofClient()
        client._opener = Opener({"ok": False, "schema_version": "1", "error": {"code": "invalid_input", "message": "Bad URL"}})
        with self.assertRaises(RankProofApiError) as caught:
            client.capabilities()
        self.assertEqual(caught.exception.code, "invalid_input")


if __name__ == "__main__":
    unittest.main()
