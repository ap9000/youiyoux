#!/bin/sh
# Rebuilds the hub's first-route fonts (src/styles/fonts/*-latin-core.woff2) from the
# @fontsource-variable Latin files: the wght axis cut to the 400–600 the hub's tokens use,
# and glyphs cut to ASCII, Latin-1 and the punctuation and arrows the hub prints.
# Rarer Latin glyphs still render: fontsource's full faces stay declared and load on demand.
#
#   sh scripts/subset-fonts.sh        (needs uv: fonttools runs through uvx)
set -eu
cd "$(dirname "$0")/.."
UNICODES="U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201D,U+2022,U+2026,U+2190-2193,U+00B7,U+00D7,U+2212,U+2264-2265"
FEATURES="kern,liga,calt,tnum,zero,ss01"
OUT=src/styles/fonts
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for family in geist geist-mono; do
  src=node_modules/@fontsource-variable/$family/files/$family-latin-wght-normal.woff2
  uvx --quiet --from 'fonttools[woff]' fonttools varLib.instancer "$src" wght=400:600 -o "$TMP/$family.woff2" --quiet
  uvx --quiet --from 'fonttools[woff]' pyftsubset "$TMP/$family.woff2" --unicodes="$UNICODES" --layout-features="$FEATURES" --flavor=woff2 --output-file="$OUT/$family-latin-core.woff2"
done
cp node_modules/@fontsource-variable/geist/LICENSE "$OUT/LICENSE"
echo "wrote $OUT/geist-latin-core.woff2 $OUT/geist-mono-latin-core.woff2"
