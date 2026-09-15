---
name: fintech-design
description: Design and build finance dashboards and web apps in a premium dark glassmorphism style — frosted translucent cards, iridescent holographic payment cards, neon gradient glows, glowing data charts, and refined status chips on a deep near-black background. Use this skill whenever the user asks to design, build, or style anything described as "fintech style", "finance dashboard", "banking dashboard", "fintech app", "crypto wallet dashboard", "trading dashboard", "payments dashboard", or any interface that displays financial data and accounts. Also trigger when the user uploads fintech dashboard screenshots and wants to match that aesthetic, or says things like "build me a finance dashboard", "make it look like a premium fintech app", or "design a banking overview." Always use this skill — do NOT attempt fintech design from memory alone.
---

# Fintech Design Skill

Build premium fintech dashboards in the style of high-end banking and wallet apps. The defining trait of this style is **dark glassmorphism** — frosted translucent panels floating on a deep near-black background, anchored by an iridescent holographic payment card, lit with soft neon gradient glows, and organized into a dense, calm dashboard grid. Not flat enterprise gray. Not bright solid-color cards. Deep, glowing, layered, and premium.

This is a dashboard-first skill: the primary output is a finance overview screen with a hero card, KPI tiles, charts, an actions panel, a transactions table, and an activity feed.

---

## Step 1 — Ask Clarifying Questions

Before writing code, ask these. Offer defaults so the user can say "use defaults" and you proceed immediately.

```
1. Accent gradient — the neon glow color theme?
   Default: Iridescent (cyan → violet → magenta)
   Alternatives: Emerald glow · Cyan/blue · Violet/purple · Gold/amber

2. App type?
   e.g. personal banking, crypto wallet, card management, payments,
   trading overview, business finance

3. Currency?
   Default: USD ($). Options: EUR (€), GBP (£), ETH/crypto, etc.

4. Layout target?
   Default: Desktop dashboard. Options: Mobile app · Responsive both
```

If the user skips: proceed with **iridescent accent + personal banking + USD + desktop dashboard**.

---

## Step 2 — Color System

The foundation is a deep near-black background with translucent surfaces layered on top. Surfaces are never solid — they're frosted glass with low-opacity fills and subtle borders.

```css
:root {
  /* ── Base background ── */
  --bg-page:      #080B14;   /* deepest page background, slight blue-black */
  --bg-page-2:    #0C1019;   /* secondary background zones */

  /* ── Glass surfaces (translucent — always over the dark bg) ── */
  --glass-1:      rgba(255, 255, 255, 0.04);  /* primary card fill */
  --glass-2:      rgba(255, 255, 255, 0.06);  /* raised / nested card fill */
  --glass-3:      rgba(255, 255, 255, 0.08);  /* hover / active surface */
  --glass-border: rgba(255, 255, 255, 0.08);  /* card border */
  --glass-border-strong: rgba(255, 255, 255, 0.14); /* hover border */

  /* ── Text ── */
  --text-1:    rgba(255, 255, 255, 0.95);  /* primary numbers & headings */
  --text-2:    rgba(255, 255, 255, 0.62);  /* labels, secondary text */
  --text-3:    rgba(255, 255, 255, 0.40);  /* captions, muted meta */

  /* ── Neon accent gradient (iridescent default) ── */
  --accent-1:    #22D3EE;   /* cyan */
  --accent-2:    #818CF8;   /* indigo */
  --accent-3:    #E879F9;   /* magenta */
  --accent-grad: linear-gradient(135deg, #22D3EE 0%, #818CF8 50%, #E879F9 100%);
  --accent-glow: rgba(129, 140, 248, 0.45);  /* shadow/glow color */

  /* ── Status colors (for chips & deltas) ── */
  --pos:      #34D399;   /* positive / settled / success — emerald */
  --pos-bg:   rgba(52, 211, 153, 0.14);
  --warn:     #FBBF24;   /* pending / caution — amber */
  --warn-bg:  rgba(251, 191, 36, 0.14);
  --neg:      #FB7185;   /* failed / negative / alert — rose */
  --neg-bg:   rgba(251, 113, 133, 0.14);
  --info:     #818CF8;   /* in-progress / neutral status — indigo */
  --info-bg:  rgba(129, 140, 248, 0.14);
}
```

**Alternate accent gradients** (swap `--accent-*` and `--accent-grad`):
- **Emerald glow:** `#34D399 → #10B981 → #06B6D4`, glow `rgba(16,185,129,0.45)`
- **Cyan/blue:** `#22D3EE → #3B82F6 → #6366F1`, glow `rgba(59,130,246,0.45)`
- **Violet/purple:** `#A78BFA → #8B5CF6 → #D946EF`, glow `rgba(139,92,246,0.45)`
- **Gold/amber:** `#FCD34D → #F59E0B → #FB923C`, glow `rgba(245,158,11,0.40)`

**Color rules:**
- Background is always deep near-black with a slight cool (blue) undertone — never pure `#000000`, never warm.
- Surfaces are translucent white fills (4–8% opacity), never solid colors.
- The neon gradient appears on: the hero card glow, the primary chart line, the upgrade/promo tile, active toggles, and focus rings. Used sparingly — it's a glow, not a fill for everything.
- Status colors only ever appear on chips, delta badges, and alert icons.

---

## Step 3 — Typography

One clean geometric sans-serif throughout. The hierarchy comes from size and weight, not from multiple fonts.

```css
/* Font: Inter, or similar — Geist, General Sans, SF Pro all work */
font-family: 'Inter', -apple-system, system-ui, sans-serif;
```

| Role | Size | Weight | Color | Notes |
|------|------|--------|-------|-------|
| Hero metric (balance) | 28–36px | 600 | `--text-1` | The big number on KPI tiles |
| Card label | 12–13px | 500 | `--text-2` | "Balance", "Utilization" — above the metric |
| Section title | 15–16px | 600 | `--text-1` | "Transactions", "Actions" |
| Card number (****8821) | 22–26px | 500 | `--text-1` | On the payment card, letter-spaced |
| Table cell | 13px | 400 | `--text-1` | Transaction rows |
| Table header | 11–12px | 500 | `--text-3` | Uppercase optional, letter-spacing 0.04em |
| Chip text | 11–12px | 500 | status color | Inside status chips |
| Meta / timestamp | 11px | 400 | `--text-3` | Activity feed times |

**Number formatting (critical for fintech):**
- Always show currency symbol and correct decimals: `$5,312.45`, `€15,320.75`, `2.84 ETH`.
- Use tabular figures so numbers align in tables: `font-variant-numeric: tabular-nums;`
- Deltas always carry a sign and color: `+9.3%` in `--pos`, `−2.4%` in `--neg`.

---

## Step 4 — Glass Surfaces & Layout

### The Glass Card (core of the style)

Every panel is a frosted glass surface. This is the single most important component.

```css
.glass-card {
  background: var(--glass-1);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--glass-border);
  border-radius: 20px;
  padding: 20px;
  position: relative;
}
.glass-card:hover {
  background: var(--glass-2);
  border-color: var(--glass-border-strong);
}
```

- **Border radius:** generous and consistent — 20px for cards, 12–14px for nested elements, 999px for pills/chips.
- **Backdrop blur** is mandatory — it's what makes the glass read as glass. Always pair it with a low-opacity fill and a subtle 1px border.
- **Subtle top highlight (optional polish):** a faint white inner border on the top edge sells the glass effect:
  `box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);`

### Dashboard Grid

The layout is a calm, dense bento-style grid — typically a wide main column and a narrower right rail.

```css
.dashboard {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 16px;
  padding: 16px;
  background: var(--bg-page);
}
/* Hero payment card spans 2 cols; KPI tiles fill the rest.
   Charts span 2 cols, actions panel 1. Transactions span 2, feed 1. */
```

- Gap between cards: 16px. Page padding: 16–24px.
- KPI tiles (balance, utilization, rewards, alerts) are small glass cards in a row.
- Keep generous breathing room inside each card — labels at top, big number below, chart/meta at bottom.

---

## Step 5 — The Iridescent Payment Card (signature element)

The hero of the dashboard is a credit/debit card with a holographic, iridescent finish. This is what makes the style unmistakably premium-fintech.

```css
.payment-card {
  position: relative;
  border-radius: 18px;
  padding: 22px;
  min-height: 200px;
  overflow: hidden;
  /* iridescent holographic base */
  background:
    linear-gradient(135deg,
      rgba(34,211,238,0.25) 0%,
      rgba(129,140,248,0.30) 40%,
      rgba(232,121,249,0.28) 70%,
      rgba(52,211,153,0.22) 100%),
    var(--glass-2);
  backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.18);
  /* the glow that lifts it off the page */
  box-shadow:
    0 0 0 1px rgba(255,255,255,0.06) inset,
    0 8px 40px var(--accent-glow);
}
/* animated sheen sweep (optional but recommended) */
.payment-card::after {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(115deg,
    transparent 30%, rgba(255,255,255,0.12) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: sheen 6s ease-in-out infinite;
}
@keyframes sheen { 0%,60% { transform: translateX(-100%);} 100% { transform: translateX(100%);} }
```

Card contents, top to bottom: brand mark (top-left) + two overlapping circles (top-right, like a payment network logo) → chip glyph → masked number `**** 8821` (letter-spaced, 22–26px) → a status chip ("Virtual card active" / "Card active") and an action like "Add to Google Pay" or "Tap to lock".

A neon gradient **rim light** around the card (a 1–2px gradient border using `--accent-grad`) is a strong optional accent — see screenshots 1 and 3.

---

## Step 6 — Components

### Status Chip
Small pill chips that label transaction and account states. Consistent verbs, consistent colors.

```css
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 999px;
  font-size: 11px; font-weight: 500;
  /* color + bg set per status */
}
.chip-pos  { color: var(--pos);  background: var(--pos-bg); }
.chip-warn { color: var(--warn); background: var(--warn-bg); }
.chip-neg  { color: var(--neg);  background: var(--neg-bg); }
.chip-info { color: var(--info); background: var(--info-bg); }
/* small leading dot */
.chip::before { content:""; width:6px; height:6px; border-radius:999px; background: currentColor; }
```

**Status vocabulary (use consistent verbs + outcomes):**
- Positive/done → `Settled`, `Completed`, `Approved`, `Card active` → `chip-pos`
- Pending/waiting → `Pending`, `Processing`, `KYC pending` → `chip-warn`
- Failed/alert → `Failed`, `Declined`, `Fraud flagged` → `chip-neg`
- Neutral/in-progress → `In review`, `Initiated` → `chip-info`

### Delta Badge
```css
.delta-pos { color: var(--pos); } /* prefix +, e.g. +9.3% MoM */
.delta-neg { color: var(--neg); } /* prefix −  */
```

### KPI Tile
Label (`--text-2`, 12px) at top → big number (`--text-1`, 28–32px, 600) → optional tiny sparkline or progress bar at the bottom. Glass-card base.

### Period Toggle / Segmented Control
Pill group like `5d · 15d · 60d`. Inactive segments are `--text-3`; the active segment gets a `--glass-3` fill and `--text-1`.

### Toggle Switch
Off: `--glass-3` track. On: track filled with `--accent-grad`, with a soft `--accent-glow` shadow. White knob.

### Actions Panel
A vertical list of row items (Freeze, Set limits, Reveal details, Replace card) each with a leading line icon, label, and a trailing chevron or toggle. One row may be disabled (`--text-3`, reduced opacity) like "Request increase".

### Upgrade / Promo Tile
A small glass card lit with the full `--accent-grad` glow — a gradient background wash plus a sparkle icon. Copy like "Upgrade to Platinum". This is the one tile allowed to use the gradient as a fill.

### Transactions Table
Columns: checkbox · ID/merchant · amount (tabular nums, right-aligned) · status chip · date · expand chevron. Header row in `--text-3`. Row dividers are 1px `--glass-border`. Row hover lifts to `--glass-2`. Toolbar above: Sort, Filter, Colors/Chips, Copy ID, Export CSV/PDF.

### Activity Feed
A vertical list — each item is a leading status icon, a title (`--text-1`, 13px), a subtitle (`--text-3`), and a right-aligned timestamp. Items like "Freeze toggled on", "PIN changed", "Chargeback initiated".

### Icons
Use a real icon library only — Lucide, Heroicons, Phosphor, or similar SVG icon sets. Thin line icons (1.5px stroke), `--text-2` default, `--text-1` on hover. Never use emojis as icons anywhere in the UI (no emoji in nav, buttons, status rows, feed items, or chips) — every icon must be a proper SVG from an icon library. Status chips use a small colored dot or a library icon, never an emoji.

---

## Step 7 — Data Visualization

Charts glow. They sit inside glass cards on the dark background.

### Area / Line Chart (primary)
- Line: 2px, stroked with `--accent-grad` (use a gradient stroke or `--accent-2`).
- Glow: apply a soft drop-shadow filter to the line so it appears lit: `filter: drop-shadow(0 0 6px var(--accent-glow))`.
- Fill: a vertical gradient from `rgba(accent, 0.18)` at the line down to transparent.
- A horizontal dashed reference line (e.g. "Budget limit", "Risk limit", "Safe zone") in `--text-3`.
- Tooltip: a small glass chip with the value and label, glowing dot on the data point.

### Ring / Donut (portfolio allocation)
- Track: `--glass-2`. Segments: distinct accent-family hues. Center holds a big number + label.
- Legend rows with a colored dot, label, and percentage (tabular nums).

### Bar / Sparkline
- Bars: `--accent-grad` vertical fill, rounded tops, 6–10px wide. Inactive/comparison bars in `--glass-3`.

### Chart.js / library globals
- Grid lines: `rgba(255,255,255,0.05)`. Axis text: `--text-3`, 11px.
- No chart borders or boxes — the glass card is the container.
- Always show tabular-num values; format currency in tooltips.

---

## Step 8 — Micro-Animations

Keep motion subtle and premium. Nothing bouncy.

- **Card hover:** background `--glass-1 → --glass-2`, border brightens, 200ms ease.
- **Payment card sheen:** the slow diagonal light sweep (Step 5), 6s loop.
- **Number count-up:** KPI numbers count from 0 to value on first load, ~600ms ease-out.
- **Chart line draw-in:** stroke-dashoffset animation, ~800ms ease, on mount.
- **Toggle:** knob slides 200ms; the gradient glow fades in when switched on.
- **Chart tooltip:** fades + slides 6px into place, 150ms.
- **Promo tile:** very slow gradient shift (background-position) for a living shimmer.
- Respect `prefers-reduced-motion` — disable sheen, count-up, and shimmer; keep static states.

---

## Step 9 — Dark Mode Contrast Rules

Glass on dark can fail readability fast. Enforce these:
- Primary numbers use `--text-1` (95% white) — never dim the hero metric.
- Never put `--text-3` (40%) text on the lightest glass; reserve it for the darker base background.
- Status chips must keep their colored text at full saturation — don't lower chip text opacity.
- The payment card's masked number and labels need a real contrast floor; if the iridescent fill is bright behind them, add a subtle dark gradient scrim behind the text.
- Maintain at least a visible 1px border on every glass surface — without it, cards disappear into the background.

---

## Step 10 — Anti-Patterns (Never Do These)

- Never: Solid opaque cards. Surfaces must be translucent glass with backdrop blur.
- Never: Pure black `#000000` background. Use the deep blue-black `--bg-page`.
- Never: Bright solid-color card fills (lime, purple blocks). The color lives in glows and the iridescent card, not in flat fills.
- Never: The neon gradient everywhere. It's an accent glow — hero card, primary chart, one promo tile, active toggles. Not on every element.
- Never: Hard drop shadows. Elevation comes from blur, border, and soft accent glow.
- Never: Sharp corners. Everything is rounded (20px cards, 999px pills).
- Never: Inconsistent status colors. Green = done, amber = pending, rose = failed. Never reuse them decoratively.
- Never: Non-tabular numbers in tables. Always `tabular-nums`.
- Never: Emojis as icons. Use real SVG icons from a library (Lucide, Heroicons, Phosphor) everywhere.

---

## Step 11 — Output Rules

- Build the full dashboard, not fragments: top bar (search + range toggle) → hero payment card + KPI tiles → chart + actions panel → transactions table + activity feed → footer/promo row.
- Use realistic financial data — real merchant names, plausible amounts, varied statuses.
- Single self-contained file when possible; inline the CSS variables from Step 2 at the top.
- Default to desktop dashboard layout unless the user asked for mobile.
- Every surface is a glass card. Every number is formatted. Every status is a chip. The iridescent card anchors the screen.
