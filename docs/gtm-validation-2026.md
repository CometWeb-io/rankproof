# RankProof GTM validation — November 2026

Status: **TEST / no broad launch yet**. Owner decision record; not evidence of customer demand.
Baseline: `main` @ `aedfc91c17b1b355e5939795b6a29b6d77e5d4cf` (2026-10-25). Research checked 2026-11-06.

## Decision in one paragraph

Test **verifying known source–target backlinks** as the first adoption wedge for technical SEO operators and agencies. Keep the broader search-visibility toolkit available but secondary. Do not position RankProof as an Ahrefs/Linkody replacement, "the only tool that verifies backlinks", a Google rank tracker out of the box, or an exhaustive backlink index. Test whether **open execution, programmatic access and inspectable, scoped observations** matter enough for repeat use. Do not run a broad naming/paid launch until the brand collision is resolved.

## Material facts and falsifiers

| Claim | Basis | Counterevidence / limit | Decision |
| --- | --- | --- | --- |
| RankProof can verify provided source–target pairs | Source `docs/api.md`, `POST /v1/backlinks/verify`, current main | Only fetched HTML; up to 50 pairs per batch; endpoint is under **Unreleased** in CHANGELOG; no measured field reliability | Show a source-checkout developer preview, not an established SaaS feature |
| Three-way result avoids treating blocked requests as absence | `docs/api.md` | `not_found` proves absence only in inspected representation; no JS rendering | Use precise scoped language |
| Unique advantage is backlink verification | **Refuted** by Linkody docs | Linkody also checks live links, wrong anchor, rel, landing page and alerts | Never claim uniqueness |
| Discovery can replace major commercial indexes | **Not demonstrated**; `docs/metrics.md` says coverage is incomplete | Unknown web population and upstream data limitations | Lead with known-pair checking, not backlink count |
| Existing open-source brand can launch unmodified | **Contradicted** by third-party RankProof websites | `rankproof.io` and `rankproof.eu` sell/offer SEO tools under same name | Conduct naming, domain and trademark counsel check before broader marketing |
| Users will pay for hosted monitoring | **Hypothesis** | Linkody offers 500 monitored links for €13.90/month; Linkcheck.io includes 200 free | Collect workflow evidence before pricing or building hosted product |

Source references (observed 2026-11-06):
- Code and limitations: `docs/api.md`, `docs/metrics.md`, `CHANGELOG.md`.
- Linkody discovery: https://www.linkody.com/helpcenter/en/articles/11070871-how-linkody-finds-backlinks
- Linkody status checks: https://www.linkody.com/helpcenter/en/articles/11013905-linkody-faq
- Linkody pricing: https://www.linkody.com/en/plans
- Linkcheck plans: https://linkcheck.io/plans/
- Other users of name: https://www.rankproof.io/ and https://rankproof.eu/
- Google disavow cautions: https://support.google.com/webmasters/answer/2648487

These are observed competing sites, not a concluded trademark infringement or a legally cleared name change.

## Independent review lenses (structured critiques; not separate model executions)

Each lens tests a different assumption; no consensus by voting.

1. **Agency buyer:** A generic SEO scanner saves no urgent time. Would trial only with a CSV of managed links, source-level evidence and exportable exceptions. Reject claims that no competitor does verification.
2. **OSS maintainer:** `git clone && npm ci` is friction. A copy-paste API example, pinned release, known limitations and small reproducible demo matter more than a polished landing page. Unreleased API is not GA.
3. **Research/methods:** Verify `confirmed`, `not_found`, `error` against a blinded manual reference. Report denominators, fetch errors, JS-only exclusions and timing; do not use score deltas as proof of ranking impact.
4. **GTM/operator:** Start with technical practitioners with known lists and repeated work. GitHub stars and visits are weak proxies; repeat workflow use and saved person-hours are better.
5. **Skeptical finance/portfolio:** Another hosted SEO suite risks duplicating CometWeb Insight and recurring infrastructure costs. Maintain separate engine/feature boundary; monetize only on observed willingness to pay.

Disagreements:
- Agency wants web CSV immediately; maintainer prefers CLI/API first. **Decision:** test manual CSV-to-JSON pilot before committing to UI, then build CSV if onboarding failure demonstrates need.
- GTM wants a larger public launch; methods demands evidence. **Decision:** limited partner test first; launch after quality and naming gates.
- Monetization suggests hosted monitoring; portfolio objects to speculative SaaS. **Decision:** defer billing until repeated workflow use and explicit paid commitment.

## Audience, problem and offer hypotheses

Primary exploratory audience: technical SEOs, link-building operators and small agencies that **already have source/target URL lists**. Secondary: developers integrating verification in a pipeline.

Problem hypothesis: teams spend time deciding whether promised links remain present and how to handle unreadable pages. They need evidence and a clean exception queue, not a generic "SEO health score".

Offer to test:
> Check backlinks you already know about. See which links were confirmed in fetched HTML, which were not found there, and which could not be checked. Inspect source evidence; keep control of the workflow.

Never promise Google indexing, SEO uplift, "live in the browser", exhaustive search or perfect link-loss detection.

## 30-day discovery experiment

**Week 1 — truthful demo + baseline.**
- Verify tool installation and the `/health` capability and schema in source checkout.
- Use `docs/backlink-verification-quickstart.md` and hand a real user a known-pairs list.
- Build a permissioned 60–120-pair reference set: obvious present links, absent links, script-inserted links, 404/410, robots/captcha, redirects, tricky HTML entities and `rel` variations. Keep source/target URLs private if proprietary.
- Blindly label the expected outcome on the fetched HTML snapshot; independent manual reviewer checks a sample. Record `checked_at`, source revision, status and error reason. Report successes/unknowns and disagreements by case.
- Gate: no marketing of high accuracy if the study cannot be replicated or material disagreement stays unexplained.

**Weeks 2–3 — 10 qualified discovery conversations, 5 tasks.**
- Recruit agencies/operators who have a recurring list-checking workflow; avoid generic "do you like SEO?" surveys.
- First ask what they currently do, frequency, last costly incident, and existing paid tool; then observe a real task with their own sanitized URLs.
- Record: time-to-first-confirmation, successful task completion, manual steps, unsupported cases, result disagreement, number of blocked items, and return use after 7 days.
- Ask a concrete purchase question only after demonstrated repeat use: "Would you replace a paid step or pay for scheduled checks? Which step and budget?"

**Week 4 — decision.**
- **GO to wider developer launch** only if 5/5 independent testers can execute the documented setup or identified friction is fixed; representative reference set has no unresolved high-severity false claims of loss; at least 3 teams run a second useful verification; naming risk assessed.
- **TEST again** if the value is real but setup/CSV evidence/coverage prevents repeat use.
- **STOP this wedge / reposition** if fewer than 2 of 5 teams complete a valuable task despite hands-on help and users report no repeat need.
- A single enthusiastic testimonial or GitHub star count does not clear a gate.

The thresholds above are proposed decision rules, not forecasts or achieved results. `0` for unmeasured metrics means **not yet measured**, not failure.

## Product and distribution backlog, dependency order

| Order | Action | Acceptance evidence | Status 2026-11-06 |
| --- | --- | --- | --- |
| 0 | Resolve external name collision for any public-facing brand/domain | Naming decision and counsel check if needed | BLOCKED / undecided |
| 1 | Document exact verification workflow with source checkout and scoped claims | Independently followable steps, read-back | DOCUMENTED; live execution not verified |
| 2 | Measure outcome validity on known-pair fixtures and field links | Case ledger + denominators + manual labels | OPEN |
| 3 | Observe five agency/developer onboarding tasks | Task observation, obstacles, return-use | OPEN |
| 4 | If CSV friction is observed, add CSV import and exception export | Contract tests + pilot re-run | CONDITIONAL |
| 5 | Publish an npm/portable installation path | Packed-install smoke in fresh environment | OPEN |
| 6 | Build versioned paired observations + history | Deterministic diff across same exact pairs; unknown stays unknown | OPEN |
| 7 | Add MCP tool surface on top of versioned API | Security review + tool schema + tested local/remote trust boundaries | CONDITIONAL |
| 8 | Only then publish external benchmark/showcase | Reproducible study, uncertainty and brand gate | NOT AUTHORIZED |

## Trust, reading, usage, purchasing rubric

| Lens | Trust now? | Read? | Use? | Buy? | What changes answer |
| --- | --- | --- | --- | --- | --- |
| Technical SEO buyer | Conditional | Yes, short proof | Only trial | No | CSV, reproducible exceptions, saved time and evidence |
| OSS maintainer | Conditional | Yes | Likely local try | N/A | Release artifact, reproducible tests, clear contract |
| Methods reviewer | Partial | Yes | In controlled test | No | Measured field confusion matrix, scope, re-checks |
| GTM practitioner | Conditional | Yes | Pilot | No | Narrow conversion path and repeat users |
| Portfolio investor | Low | Yes | Pilot only | No | Clear strategic boundary, avoided infrastructure costs, paid signal |

## What not to ship in this cycle

- No generic "all-in-one SEO" pitch, broad prospecting automation, paid ads or mass Show HN before fit.
- No automatic disavow recommendation or claims that a risk score predicts Google penalties.
- No invented conversion lifts, rankings impact, accuracy or customer proof.
- No unattended external outreach; study invitations require owner-controlled sending.
- No public product rename without clearance and an explicit owner decision.

## Next readout

Report **verified** (repository/file/run), **observed** (pilot), **hypothesized** (strategy), and **unknown** separately. Record dates, versions, source refs and acceptance failures. A commit validates only that a document was saved; CI/tests and market outcomes require separate verification.
