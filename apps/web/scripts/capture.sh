#!/usr/bin/env bash
# Captures, with chrome-devtools-axi, from a running hub:
#   - preview thumbnails  public/previews/<component>.<scheme>.webp  (shown until someone interacts)
#   - screen screenshots  screenshots/<screen>.<scheme>.webp         (for design review)
#
#   pnpm dev            # in another terminal
#   scripts/capture.sh [base-url] [previews|screens|all]
set -euo pipefail

BASE="${1:-http://localhost:5173}"
WHAT="${2:-all}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
export CHROME_DEVTOOLS_AXI_SESSION="${CHROME_DEVTOOLS_AXI_SESSION:-youiyoux-capture}"

PREVIEW_WIDTH=880
SCREEN_VIEWPORT="1440x900x2"
SETTLE_MS=900
COMPONENTS=(badge button card input label switch tabs textarea)
SCREENS=(
  "home:/"
  "catalog:/elements"
  "element-preview:/elements/signal/component/button"
  "element-contract:/elements/signal/component/button/contract"
  "element-tokens:/elements/signal/component/button/tokens"
  "element-rules:/elements/signal/component/button/rules"
  "element-where:/elements/signal/component/button/where"
  "rule:/elements/signal/rule/color.no-raw-color"
  "tokens-palette:/tokens"
  "token-color:/tokens/color.attention"
  "token-typography:/tokens/typography.display"
  "screens:/screens"
  "changes:/changes"
  "access:/access"
)

axi() { chrome-devtools-axi "$@" >/dev/null; }

capture_previews() {
  mkdir -p "$APP/public/previews"
  for scheme in light dark; do
    for component in "${COMPONENTS[@]}"; do
      axi emulate --viewport "${PREVIEW_WIDTH}x600x2" --color-scheme "$scheme"
      axi open "$BASE/preview.html?c=$component&scheme=$scheme"
      axi wait "$SETTLE_MS"
      height=$(chrome-devtools-axi eval "Math.ceil(document.querySelector('.signal-scope').getBoundingClientRect().height)" | sed -n 's/^result: "\{0,1\}\([0-9]*\)"\{0,1\}$/\1/p')
      axi emulate --viewport "${PREVIEW_WIDTH}x${height:-320}x2" --color-scheme "$scheme"
      axi wait 200
      axi screenshot "$APP/public/previews/$component.$scheme.webp" --format webp
      echo "preview $component ($scheme, ${height}px)"
    done
  done
}

capture_screens() {
  mkdir -p "$APP/screenshots"
  for scheme in light dark; do
    axi emulate --viewport "$SCREEN_VIEWPORT" --color-scheme "$scheme"
    for entry in "${SCREENS[@]}"; do
      name="${entry%%:*}"
      path="${entry#*:}"
      axi open "$BASE$path"
      axi wait "$SETTLE_MS"
      axi screenshot "$APP/screenshots/$name.$scheme.webp" --format webp
      echo "screen $name ($scheme)"
    done
    # The command palette, mid-search.
    axi open "$BASE/elements"
    axi wait "$SETTLE_MS"
    axi press "Meta+k"
    axi wait 300
    axi type "att"
    axi wait 400
    axi screenshot "$APP/screenshots/command-palette.$scheme.webp" --format webp
    echo "screen command-palette ($scheme)"
    # Phone width: one pane at a time.
    axi emulate --viewport "390x844x3,mobile,touch" --color-scheme "$scheme"
    for entry in "phone-catalog:/elements" "phone-element:/elements/signal/component/button/where"; do
      axi open "$BASE${entry#*:}"
      axi wait "$SETTLE_MS"
      axi screenshot "$APP/screenshots/${entry%%:*}.$scheme.webp" --format webp
      echo "screen ${entry%%:*} ($scheme)"
    done
  done
}

case "$WHAT" in
  previews) capture_previews ;;
  screens) capture_screens ;;
  all) capture_previews && capture_screens ;;
  *) echo "usage: scripts/capture.sh [base-url] [previews|screens|all]" >&2 && exit 2 ;;
esac
