# SERP fixtures

Frozen HTML samples used by the golden parser tests.

Search engines change their markup without warning. When that happens the
parser silently returns nothing and every scan reports "no visibility" — data
that looks real and is not. These fixtures make that failure loud: the test
breaks in CI instead of the numbers breaking in production.

## Refreshing a fixture

```bash
npm run cli -- doctor --format json     # confirm which engine changed
```

Then capture a fresh page and trim it to the smallest fragment that still
contains several organic results:

```bash
curl -s -A "Mozilla/5.0" 'https://www.bing.com/search?q=open+source+seo' > bing.html
```

Keep fixtures small (a few kB), strip tracking parameters and personal data,
and never commit a page captured while logged in.
