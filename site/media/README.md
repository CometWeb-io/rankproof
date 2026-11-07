# Landing page media

All media here comes from a real local run on 7 November 2026 of the code released as RankProof 1.0.0, not from mockups.

- `scan-demo.mp4`: screen recording of a scan of `nasa.gov` (US market, desktop) in the local web app, captured with Playwright at 1280×800. The scanning phase (just under a minute) is sped up 15×; the remaining footage plays in real time.
- `scan-demo-poster.jpg`: a frame from that recording.
- `scan-overview.jpg` and `scan-backlinks.jpg`: screenshots from the same run, cropped. Results for a live domain change over time, so a new scan will not reproduce these numbers exactly.

- `hero-verify.json`: the raw response of `POST /v1/backlinks/verify` from a local RankProof 1.0.0 API (`node scripts/serve-api.mjs`) on 7 November 2026, for four pairs: the Wikipedia article on Hacker News against `news.ycombinator.com` (confirmed) and against `example.com` (not found), and `httpbin.org/status/403` and `/status/404` against `example.com`. The hero diagram shows these four results. Live pages change, so a new run may differ.
