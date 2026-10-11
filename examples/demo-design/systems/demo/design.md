<!-- Demo is made up: it exists so the youi docs, tests and the hub have a system to show. Token values live in tokens/demo; this is the narrative. -->

# Design System: Demo

## Overview

Demo is a quiet, neutral interface with one hue to spend. The ground is white in light mode and near-black in dark mode, cards sit on it with a hairline border and one soft shadow, and text is set in Geist. Indigo is the accent, and it is spent only on action: the main button of a view, focus rings and links. Red is kept for danger and nothing else.

**Key Characteristics:**
- One accent, spent on action. A view has at most one filled button.
- Hairlines before shadows: borders separate, a single soft shadow lifts a card.
- 8px corners on controls, 12px on cards.
- Light and dark are equal schemes; every colour role has a value in each.

## Colors

- **Background** (background): the page behind every view.
- **Foreground** (foreground): body text and icons.
- **Muted** (muted): secondary text, placeholders and meta lines. It passes 4.5:1 on background and card.
- **Card** (card): containers that sit on the background.
- **Line** (line): hairline borders and dividers.
- **Accent** (accent, an alias of brand): the main action of a view, focus rings and links. **On accent** (on-accent) is the text on it.
- **Danger** (danger) and **Danger soft** (danger-soft): destructive actions and errors, as text on a soft wash.

## Typography

- **Label** (13px, 500): buttons, field labels and card titles.
- **Body** (14px, 400, 1.5 line height): running text and field values.

## Components

- **Button**: default for the main action, outline for secondary actions, ghost for toolbars, danger for a confirmed destructive act, link for navigation.
- **Input**: a single-line field with a label beside it. An invalid value turns the border to danger and says what is wrong in text.
- **Card**: one subject per card. Cards are never nested.

## Do's and Don'ts

- Do give each view one main action.
- Do pair every field with a label.
- Don't hard-code a colour; use a token utility.
- Don't use danger for anything that is not destructive.
