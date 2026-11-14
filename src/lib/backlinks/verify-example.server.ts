/**
 * Example data for the web UI. Every result is produced by the real extractor
 * (`observeRepresentation`) from bundled HTML — nothing is hand-written JSON —
 * but no network request is made, so the example works offline.
 */
import { evaluateContract, parsePairTable } from "./observe.ts";
import { observeRepresentation, type BacklinkObservation } from "./verify-api.server.ts";

const TARGET = "https://northline.example/field-guide";

export const EXAMPLE_TABLE = [
  "source_url,target_url,expected_anchor,expected_rel,expected_placement",
  `https://harbour-review.example/2026/coastal-kits,${TARGET},Northline field guide,follow,content`,
  `https://outdoor-weekly.example/partners,${TARGET},Northline,sponsored,sidebar`,
  `https://trailnotes.example/best-of-autumn,${TARGET},,`,
  `https://kayak-forum.example/t/route-planning,${TARGET},,ugc`,
  `https://camp-directory.example/listing/northline,${TARGET},Northline,follow`,
  `https://slow-host.example/roundup,${TARGET},,`,
].join("\n");

const page = (body: string) =>
  `<!doctype html><html><head><title>Example</title></head><body><main>${body}</main></body></html>`;

type Snapshot = { status: number; body: string } | { error: string };

const OCT: Record<string, Snapshot> = {
  "https://harbour-review.example/2026/coastal-kits": {
    status: 200,
    body: page(
      `<article><p>For tide tables we keep the <a href="${TARGET}">Northline field guide</a> in every kit.</p></article>`,
    ),
  },
  "https://outdoor-weekly.example/partners": {
    status: 200,
    body: page(`<aside><a rel="sponsored noopener" href="${TARGET}">Northline</a></aside>`),
  },
  "https://trailnotes.example/best-of-autumn": {
    status: 200,
    body: page(`<p>See <a href="${TARGET}">this guide</a> before you go.</p>`),
  },
  "https://kayak-forum.example/t/route-planning": {
    status: 200,
    body: page(`<p>Nobody has posted a link yet.</p>`),
  },
  "https://camp-directory.example/listing/northline": {
    status: 200,
    body: page(`<a href="${TARGET}">Northline</a>`),
  },
  "https://slow-host.example/roundup": { error: "Timed out after 10 s." },
};

const NOV: Record<string, Snapshot> = {
  ...OCT,
  // The paid placement lost its rel qualifier.
  "https://outdoor-weekly.example/partners": {
    status: 200,
    body: page(`<aside><a rel="noopener" href="${TARGET}">Northline</a></aside>`),
  },
  // The article was edited and the link removed; the brand is only mentioned.
  "https://trailnotes.example/best-of-autumn": {
    status: 200,
    body: page(`<p>Northline publishes a good guide (northline.example) — worth a look.</p>`),
  },
  "https://kayak-forum.example/t/route-planning": {
    status: 200,
    body: page(`<p>Try <a rel="ugc nofollow" href="${TARGET}">the Northline route notes</a>.</p>`),
  },
  // Linked, but with tracking parameters and http — not the agreed URL.
  "https://camp-directory.example/listing/northline": {
    status: 200,
    body: page(`<a href="http://northline.example/field-guide?ref=dir">Northline</a>`),
  },
};

function run(snapshots: Record<string, Snapshot>, checkedAt: string): BacklinkObservation[] {
  return parsePairTable(EXAMPLE_TABLE).rows.map((row) => {
    const pair = {
      source_url: row.source_url,
      target_url: row.target_url,
      expected_anchor: row.expected_anchor,
      expected_rel: row.expected_rel,
      expected_placement: row.expected_placement,
    };
    const snapshot = snapshots[row.source_url]!;
    const observation =
      "error" in snapshot
        ? {
            ...observeRepresentation(pair, {
              text: "",
              finalUrl: row.source_url,
              status: 0,
              contentType: "",
              checkedAt,
            }),
            reason: snapshot.error,
            final_url: null,
            http_status: null,
            response_hash: null,
          }
        : observeRepresentation(pair, {
            text: snapshot.body,
            finalUrl: row.source_url,
            status: snapshot.status,
            contentType: "text/html; charset=utf-8",
            checkedAt,
          });
    return { ...observation, contract: evaluateContract(observation, pair) };
  });
}

export function exampleRuns() {
  return {
    table: EXAMPLE_TABLE,
    previous: run(OCT, "2026-10-12T09:00:00.000Z"),
    results: run(NOV, "2026-11-12T09:00:00.000Z"),
  };
}
