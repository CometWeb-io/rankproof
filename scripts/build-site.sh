#!/usr/bin/env bash
# Assemble the GitHub Pages landing page into a single directory.
# The page lives in site/; fonts, screenshots and the OG image are reused
# from the repository instead of being duplicated.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/_site}"

rm -rf "$out"
mkdir -p "$out/fonts" "$out/media"
cp -R "$root/site/." "$out/"
cp "$root/public/favicon.svg" "$root/public/og.jpg" "$out/"
cp "$root"/public/fonts/*.woff2 "$root/public/fonts/OFL.txt" "$out/fonts/"
cp "$root/docs/media/app.png" "$out/media/"
touch "$out/.nojekyll"
echo "Site assembled in $out"
