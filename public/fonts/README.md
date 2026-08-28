# Bundled fonts

`nunito-sans-{regular,600,700}.woff2` — **Nunito Sans**, Copyright 2016
The Nunito Sans Project Authors (<https://github.com/Fonthausen/NunitoSans>),
licensed under the SIL Open Font License 1.1. The full licence text is in
[`OFL.txt`](OFL.txt).

The files are bundled rather than loaded from a CDN on purpose: RankProof
should not make a third-party request on every page view, and a self-hosted
copy keeps the app working offline. The OFL is a separate licence from the
project's MIT — it covers these font files only, and it travels with them.

Converted from the upstream TTFs to WOFF2 with `fonttools`.
