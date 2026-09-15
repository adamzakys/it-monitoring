# Design Guidelines — Fintech Glassmorphism Dashboard

## Visual Style
- **Aesthetic**: Premium dark glassmorphism — frosted translucent panels floating on a deep near-black canvas, organized into a dense bento dashboard grid
- **Mood**: Expensive, calm, high-trust, futuristic — money that feels engineered, not corporate
- **Inspiration**: High-end banking / crypto wallet apps — Revolut, Arc, Linear-dark, holographic card marketing sites
- **Signature element**: An iridescent holographic payment card anchoring the top of the screen

## Color Palette
- **Background**: `#080B14` — deepest page background, blue-black undertone (never pure `#000000`, never warm)
- **Background Alt**: `#0C1019` — secondary background zones
- **Surface / Card**: `rgba(255,255,255,0.04)` — glass fill. Raised/nested: `0.06`. Hover/active: `0.08`. Never solid.
- **Border**: `rgba(255,255,255,0.08)` — 1px on every glass surface. Hover: `rgba(255,255,255,0.14)`
- **Text Primary**: `rgba(255,255,255,0.95)` — numbers, headings
- **Text Secondary**: `rgba(255,255,255,0.62)` — labels
- **Text Muted**: `rgba(255,255,255,0.40)` — captions, timestamps, table headers
- **Accent (iridescent, default)**: `#22D3EE` cyan → `#818CF8` indigo → `#E879F9` magenta, as `linear-gradient(135deg, ...)`
- **Accent Glow**: `rgba(129,140,248,0.45)` — the shadow color under lit elements
- **Success**: `#34D399` on `rgba(52,211,153,0.14)` — settled, completed, active
- **Warning**: `#FBBF24` on `rgba(251,191,36,0.14)` — pending, processing
- **Error**: `#FB7185` on `rgba(251,113,133,0.14)` — failed, declined, fraud
- **Info**: `#818CF8` on `rgba(129,140,248,0.14)` — in review, initiated

**Alternate accent gradients**: Emerald `#34D399→#10B981→#06B6D4` · Cyan/blue `#22D3EE→#3B82F6→#6366F1` · Violet `#A78BFA→#8B5CF6→#D946EF` · Gold `#FCD34D→#F59E0B→#FB923C`

## Typography
- **Primary Font**: Inter, or similar clean geometric sans — Geist, General Sans, SF Pro all work. One family only.
- **Hero metric**: 28–36px, weight 600, text-primary — the big balance number
- **Card label**: 12–13px, weight 500, text-secondary — sits above the metric
- **Section title**: 15–16px, weight 600, text-primary
- **Card number**: 22–26px, weight 500, letter-spaced — `**** 8821` on the payment card
- **Table cell**: 13px, weight 400 · **Table header**: 11–12px, weight 500, text-muted, letter-spacing 0.04em
- **Chip / meta**: 11–12px, weight 500 (chip) or 400 (timestamps)
- **Numbers**: `font-variant-numeric: tabular-nums` everywhere. Always show currency symbol and correct decimals (`$5,312.45`). Deltas always signed and colored (`+9.3%` success, `−2.4%` error).

## Spacing & Layout
- **Overall feel**: Dense but calm — tight grid, generous breathing room *inside* each card
- **Grid**: 3-column bento. Hero card spans 2, KPI tiles fill the rest. Chart spans 2, actions panel 1. Transactions span 2, activity feed 1.
- **Gap**: 16px between cards
- **Page padding**: 16–24px
- **Card padding**: 20–22px
- **Card internals**: label at top → big number → chart/meta at bottom
- **Mobile**: Desktop dashboard is the default target; stack to single column when requested

## Borders & Radius
- **Border radius**: 20px cards, 18px payment card, 12–14px nested elements, 999px pills and chips. Never sharp corners.
- **Borders**: 1px `rgba(255,255,255,0.08)` on every glass surface — mandatory, cards disappear into the background without it
- **Optional polish**: `box-shadow: inset 0 1px 0 rgba(255,255,255,0.06)` for a top-edge highlight that sells the glass

## Shadows & Elevation
- No hard drop shadows anywhere. Elevation comes from `backdrop-filter: blur(20px)` + low-opacity fill + 1px border.
- The only real shadow is the accent glow under lit elements: `0 8px 40px var(--accent-glow)` on the payment card, `drop-shadow(0 0 6px)` on chart lines.

## Buttons
- **Primary**: Glass fill at `0.08`, 1px border, pill or 12px radius, text-primary. Accent gradient reserved for the one promo tile and active toggles.
- **Secondary / Ghost**: Transparent, text-secondary, border brightens on hover
- **Hover states**: fill steps `0.04 → 0.06`, border `0.08 → 0.14`, 200ms ease
- **Segmented control**: pill group (`5d · 15d · 60d`) — inactive text-muted, active gets `0.08` fill and text-primary
- **Toggle switch**: off = glass track; on = accent gradient track with glow, white knob

## Icons
- Real SVG icon library only — Lucide (default), Heroicons, or Phosphor
- Thin line icons, 1.5px stroke, 20–24px, text-secondary default → text-primary on hover
- **Never emojis** — not in nav, buttons, status rows, feed items, or chips

## Components Spotted
- **Payment card (hero)**: Iridescent holographic fill — cyan/indigo/magenta/emerald gradient layered over glass, 18px radius, 200px min-height, white 18% border, accent glow beneath. Slow diagonal sheen sweep on a 6s loop. Contents: brand mark + overlapping network circles → chip glyph → masked number → status chip + action ("Tap to lock").
- **Glass card**: `rgba(255,255,255,0.04)` + `backdrop-filter: blur(20px)` + 1px border + 20px radius + 20px padding. The base for every panel.
- **KPI tile**: Label → big number → tiny sparkline or progress bar
- **Status chip**: Pill, 4px/10px padding, 11px text, colored text on 14%-opacity matching background, small leading dot in `currentColor`
- **Transactions table**: checkbox · merchant/ID · amount (tabular, right-aligned) · status chip · date · expand chevron. Muted header row, 1px glass dividers, row hover lifts fill. Toolbar above: Sort, Filter, Copy ID, Export.
- **Actions panel**: Vertical rows — leading line icon, label, trailing chevron or toggle. One row may be disabled at reduced opacity.
- **Activity feed**: Status icon → title + subtitle → right-aligned timestamp
- **Promo tile**: The one element allowed to use the accent gradient as a fill — gradient wash + sparkle icon, slow shifting background position

## Data Visualization
- **Area/line chart**: 2px accent-gradient stroke with a soft glow filter, vertical fill fading from 18% accent to transparent, dashed muted reference line, glass tooltip chip with a glowing data dot
- **Ring/donut**: Glass track, accent-family segment hues, big number + label centered, legend rows with colored dot + tabular percentage
- **Bars/sparklines**: Accent gradient vertical fill, rounded tops, 6–10px wide; comparison bars in flat glass
- **Chart globals**: grid lines `rgba(255,255,255,0.05)`, axis text muted at 11px, no chart borders — the glass card is the container

## Motion
- Card hover 200ms ease · payment card sheen 6s loop · KPI count-up ~600ms ease-out on load · chart line draw-in ~800ms · toggle knob 200ms with glow fade · tooltip fade + 6px slide 150ms · promo tile slow gradient shimmer
- Respect `prefers-reduced-motion` — kill sheen, count-up, and shimmer; keep static states

## Overall Replication Notes
- Every surface is a glass card. Every number is formatted. Every status is a chip. The iridescent card anchors the screen.
- Backdrop blur is non-negotiable — it's the entire reason the style reads as glass
- The neon gradient is a **glow, not a fill** — hero card, primary chart line, one promo tile, active toggles, focus rings. Nowhere else.
- Never solid opaque cards. Never bright solid-color blocks. Never pure black. Never sharp corners. Never hard shadows.
- Status colors are semantic only — green = done, amber = pending, rose = failed. Never decorative.
- Guard contrast: hero metrics stay at 95% white, muted text never sits on the lightest glass, chip text keeps full saturation, and the payment card gets a dark scrim behind text if the iridescence runs bright.
- Use realistic financial data — real merchant names, plausible amounts, varied statuses.
