# Landing page media

None of this is a mockup.

- `verify-demo.mp4`: screen recording of the web app at 1280×800, made with Playwright on 14 November 2026 from a local production build (`npm run build && npm run preview`). It plays in real time with no cuts. The run uses the app's built-in example ("Show an example"): six links on bundled HTML pages, read by the real extractor, with no network requests, compared with the example's bundled earlier run.
- `verify-demo-poster.jpg`: a frame from that recording.
- `verify-results.jpg` and `verify-receipt.jpg`: screenshots of the same example at 1440×900 (device scale 2, resized to 1920 px wide): the results summary and list, and one open receipt.
- `hero-verify.json`: the raw response of `POST /v1/backlinks/verify` from a local RankProof 1.0.0 API (`node scripts/serve-api.mjs`) on 7 November 2026, for four pairs: the Wikipedia article on Hacker News against `news.ycombinator.com` (confirmed) and against `example.com` (not found), and `httpbin.org/status/403` and `/status/404` against `example.com`. The hero diagram shows these four results. Live pages change, so a new run may differ.
