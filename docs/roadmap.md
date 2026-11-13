# Status of fixes

RankProof checks links between specific pages, keeps reproducible evidence and tracks meaningful changes. This page lists problems found in review and how each one was fixed. "Done" means merged with tests; it does not mean proven in the field.

## Fixed problems

| Finding                                                  | Status | Where                                                                                      |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| P0 Visibility `11 − position` went negative for #11–#20  | Done   | `keywords.ts` `positionPoints`, brand SERP; regression test                                |
| P0 Search Console data reachable by any web/API caller   | Done   | `RANKPROOF_OWNER_SITES` allowlist; CLI keeps operator access; request body cannot escalate |
| P0 Host queue ignored timeout/abort; robots.txt deadlock | Done   | `acquireHost` bounded wait, robots bypasses limiter (same fix as upstream PR #5)           |
| P1 Documented loopback Google provider always refused    | Done   | `RANKPROOF_GOOGLE_PROVIDER_ALLOW_LOOPBACK=1`; metadata/LAN stay blocked; redirects refused |
| P1 Orphan pages from an incomplete crawl                 | Done   | Orphans only after a complete crawl; otherwise a low-severity gap                          |
| P1 Hand-written suffix list merged independent sites     | Done   | Full Public Suffix List (`tldts`, private section)                                         |
| Scores looked complete when data was missing             | Done   | Scorecard `basis` and `coverage`; unknown parts excluded; UI splits measured vs model      |
| Disavow generator too prominent                          | Done   | Moved behind an explicit review step with Google's guidance                                |
| "Proof" over-claims                                      | Done   | [evidence.md](evidence.md) states what each artifact proves and does not                   |
