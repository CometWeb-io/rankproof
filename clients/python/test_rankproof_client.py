"""Consumer-side contract tests: run against the committed golden fixtures.

    python3 -m unittest discover clients/python
"""

import json
import pathlib
import unittest

from rankproof_client import (
    Observation,
    RankProofClient,
    RankProofError,
    lost_links,
    parse_verify_response,
    summarize,
)

FIXTURES = pathlib.Path(__file__).resolve().parents[2] / "contract" / "fixtures"


def load(name):
    return json.loads((FIXTURES / name).read_text("utf-8"))


class ContractTest(unittest.TestCase):
    def test_golden_response_parses_with_every_verdict(self):
        results = parse_verify_response(load("verify-response.json"))
        self.assertEqual(len(results), len(load("verify-request.json")["items"]))
        self.assertEqual(summarize(results)["total"], len(results))
        self.assertTrue({"meets", "deviates", "missing", "unverified"} <= {r.verdict for r in results})

    def test_errors_are_gaps_never_losses(self):
        previous = parse_verify_response(load("verify-response-previous.json"))
        current = parse_verify_response(load("verify-response.json"))
        gaps = [r for r in current if r.is_gap]
        self.assertTrue(gaps)
        lost = lost_links(previous, current)
        self.assertTrue(all(not r.is_gap for r in lost))
        self.assertIn("https://trailnotes.example/best-of-autumn", [r.source_url for r in lost])

    def test_unknown_fields_are_kept_and_ignored(self):
        doc = load("verify-response.json")
        doc["results"][0]["field_added_in_the_future"] = {"x": 1}
        obs = parse_verify_response(doc)[0]
        self.assertIn("field_added_in_the_future", obs.raw)

    def test_legacy_server_without_contract(self):
        item = {k: v for k, v in load("verify-response.json")["results"][0].items() if k != "contract"}
        self.assertEqual(Observation.from_json(item).verdict, "meets")

    def test_schema_and_capability_checks(self):
        client = RankProofClient("http://127.0.0.1:1")
        client._health = load("health.json")
        client.require("backlinks.verify.contract.v1")
        with self.assertRaises(RankProofError):
            client.require("backlinks.verify.render.v1")
        client._health = {**load("health.json"), "schema_version": "2"}
        with self.assertRaises(RankProofError):
            client.require()
        with self.assertRaises(RankProofError):
            parse_verify_response({"schema_version": "2", "results": []})

    def test_unreachable_server_raises(self):
        with self.assertRaises(RankProofError):
            RankProofClient("http://127.0.0.1:1", timeout=2).health()


if __name__ == "__main__":
    unittest.main()
