<!-- youiyoux's own design system: the hub (apps/web) and the report (packages/cli/src/report). Token values live beside this file in youiyoux.tokens.json and youiyoux.dark.tokens.json; this is the narrative, and rules/ holds the rules. -->

# Design System: YouIyouX

## Overview

youiyoux looks like the developer tools its readers already trust: a quiet dashboard, not a
poster. A neutral grey frame, white (or near-black) panels with hairline borders, dense rows,
and numbers that line up. Colour is spent on meaning, never on decoration. Every screen answers
three questions in order: how bad is it, what first, and where exactly.

References (Mobbin), and what each one gave:

| Reference | Pattern |
| --- | --- |
| [Semrush, Site Audit issues](https://mobbin.com/screens/2b10b36e-e9ce-424a-b603-e85f59bfbd07) | Findings as one-line rows: the count, what is wrong, "How to fix" |
| [Vanta, Findings by asset](https://mobbin.com/screens/631da5b7-7729-472a-8169-5a80dce56bd1) | A left rail of sections, summary panels above the table |
| [Zillow, Housing market](https://mobbin.com/screens/6a133906-a7e9-4623-ad43-520a04a4da69) and [Adaline, Evaluation results](https://mobbin.com/screens/bc283f1b-d003-4ec8-950c-942a1aff9ac7) | The headline is a sentence with its numbers in it |
| [Plain, Priorities](https://mobbin.com/screens/4b396c6e-917b-4dcf-bea8-0587c3dd4b1e) and [Higgsfield, Spend overview](https://mobbin.com/screens/2884b14e-7f1f-4287-99e7-64862a439bcc) | One split bar with a counted legend |
| [Perplexity, Heatmap](https://mobbin.com/screens/6334e233-7651-4be1-a9e9-eb7b29563b98) | A grid of squares whose shape is the message |
| [HubSpot, SEO recommendations](https://mobbin.com/screens/f8b03286-064d-4a8a-9ce8-c7aa0a3565de) | Impact chips and an affected-count on each recommendation |
| [Figma, Compare changes](https://mobbin.com/screens/ebb90bf9-735a-4f5f-968a-8152ff58dde8) | Two versions side by side, with the properties that matter beside them |
| [Google AI Studio, Viewing differences](https://mobbin.com/screens/3430ca7f-87b3-4475-ba40-fe8258cf2687) | Per-file rows with a count, folded until opened |

**Key characteristics:**
- Dashboard frame: a section rail, a header with the scan's facts, a headline sentence with a split bar,
  the shape map, then rows. Never a row of four equal boxes.
- Show, don't describe: a near-duplicate puts its builds side by side with the shared measurements.
- One accent over neutrals, the way [Linear](https://linear.app/now/how-we-redesigned-the-linear-ui) does it:
  the palette comes from a cool neutral base, one desaturated indigo and a contrast level. Kinds of finding
  are steps of that one indigo, not new hues. Sage and clay mark clean and could-not-read, as text only.
  No pure primaries, no traffic lights, no yellow.
- Mono for machine facts (paths, values, token names, commands); sans for sentences.
- Bounded: no list runs on forever; long ones fold.

## Colors

- **Canvas** (canvas): the frame behind the panels.
- **Surface** (surface): panels and rows.
- **Raised / Sunken** (raised, sunken): headers of tables and inset wells (code, images).
- **Line / Line strong** (line, line-strong): hairlines between rows; the panel's edge.
- **Ink / Ink 2 / Muted / Faint** (ink, ink-2, muted, faint): titles, body, meta, disabled.
- **Accent** (accent #5e6ad2 light, #7170ff dark; accent-soft): links, focus, the one command to run, the
  extra shapes in the shape map. Never a heading colour.
- **Kind steps** (k-dup, k-hard, k-off): the accent at 100%, 55% and 25% toward the surface. Only the kind's dot, its split-bar
  segment and the shape map's extra squares. Never text, never a fill behind a count.
- **Success** (sage #4f7a69 / #8fb5a4): the word Clean and None found. Text only.
- **Danger** (clay #ad5a43 / #d99a85): files that could not be read. Text and a dot only.

## Typography

- **Display** (22px, 600): the page title (the repo's name). One per page.
- **Title** (15px, 600): panel and section titles.
- **Body** (13px) and **Reading** (14px): rows and the occasional paragraph.
- **Small / Caption** (12px, 11.5px): labels, meta lines, chip text.
- **Mono** (12px) and **Mono small** (11px): paths, file:line, values, token names, commands.
- Numbers in the headline, legends and tables use tabular figures so columns line up.

## Components

- **Rail**: sticky section navigation with each section's count; on a phone it becomes a
  horizontal strip under the header.
- **Headline**: one sentence that carries the numbers (ink with a hairline underline; sage for clean), a
  caveat line when anything could not be read, one split bar of the places to fix, and its legend.
- **Shape map**: one row per kind of element, one square per distinct shape. The first square is
  solid neutral, every extra square outlined in the accent; an element whose shape could not be measured says so.
- **Panel**: a surface with a hairline edge and a header row (title left, count or action right).
- **Issue row**: count, what is wrong, a kind chip, then the next step. Rows sit in a panel,
  separated by hairlines, not floating cards.
- **Compare**: two builds of one look, side by side ("Keep" and "Copy"), with the shared
  measurements as mono chips.
- **Chip**: 20px high, 6px radius, soft fill, 11.5px text. Kind chips are neutral with the kind's
  dot; status chips use success or danger. Count chips are neutral with ink numbers.
- **Split bar**: one total split into parts, 10px high, one segment per kind, in steps of the accent.
- **Alert**: a small outlined chip with a clay "!" and a count ("9 not read"). The detail is a
  tooltip on hover or focus, and the chip links to the folded list. Never a coloured banner in the main column.
- **Share card**: the report's headline as a 1200×630 PNG: the total, the same split bar and legend, in the
  hub's dark tokens. Never a row of stat boxes.

One palette everywhere: the hub's tokens (youiyoux.tokens.json, youiyoux.dark.tokens.json) are the
source; the report and the share card copy them, and a test fails if they drift.

## Do's and Don'ts

- Do lead with the numbers, then the top fixes, then the detail.
- Do say the next step on every finding, in a sentence.
- Do fold lists after five items, and say how many are folded.
- Don't colour a heading, an eyebrow or a border to make it pretty.
- Don't set a path, value or command in the sans face.
- Don't nest panels in panels.
