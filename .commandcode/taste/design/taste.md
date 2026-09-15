# Design Preferences

- Prefers dark interfaces but prioritizes panel readability — avoids heavily translucent backgrounds that obscure content. Uses corporate brand color (`#2596be`) as the primary UI accent and active state color, replacing neon cyan/magenta tones. Confidence: 0.9
- Status indicators should use pill-style components with colored leading dots, not uppercase text badges. Confidence: 0.9
- All icons must come from real SVG icon libraries (Lucide, Heroicons, Phosphor) — never emojis in the UI. Confidence: 0.9
- Data tables and financial metrics require `font-variant-numeric: tabular-nums` for proper vertical alignment. Confidence: 0.85
- Navigation tabs should use segmented pill controls with soft neon glow on active states, rather than underlined or border-bottom tabs. Confidence: 0.85
- Status-colored surfaces (e.g., device cards) must be vividly and clearly color-coded by state — green for online, yellow/amber for warning, red for offline. Avoid near-invisible tints (very low alpha) that make the status color hard to perceive. Confidence: 0.85

- Full-screen overlay/detail views (e.g., deep-link panels, device intelligence centers) must use solid, opaque backgrounds instead of glassmorphism/transparency, preventing underlying dashboard content from bleeding through and creating visual clutter. Glass effects are avoided across the whole app, including main dashboard widgets. Confidence: 0.8
ep-link panels, device intelligence centers) must use solid, opaque backgrounds instead of glassmorphism/transparency, preventing underlying dashboard content from bleeding through and creating visual clutter. Glass effects are reserved for main dashboard widgets, not layered overlays. Confidence: 0.8

- Wants design values (e.g. border radius) standardized into shared tokens applied uniformly across every component, not ad-hoc per-component values: when reducing rounding, the whole UI must be swept to the same scale ("kurangin rounded sedikit dan seragamkan ke element lain"). Confidence: 0.8
- Prefers a responsive layout where the left sidebar collapses to icon-only on narrow screens (labels hidden, tooltips provided) instead of shrinking, overlapping, or hiding the nav entirely. Confidence: 0.7
- Prefers each device type rendered with its own recognizable category icon — on device cards and as the network-topology node glyph (status-colored icon in place of plain circles/dots). Confidence: 0.75
- Prefers a comprehensive, granular device-type taxonomy rather than a few generic categories — the UI should enumerate the full breadth of infra types (router, switch, access_point, firewall, server, vm, hypervisor, nas, cctv, ups, pdu, cooling, iot_gateway, laptop, printer, ip_phone, …) with explicit `unknown` and `unmanaged` categories. Confidence: 0.7
- Prefers Lucide as the icon library when picking icons, for consistency with the existing inline SVGs. Confidence: 0.7
- Prefers the app to remember the last active menu/view across a page reload (e.g. staying on Readiness instead of snapping back to Dashboard) — the active view should be persisted and restored on init. Confidence: 0.8
- Every UI change must preserve responsive compatibility across desktop, tablet, and mobile. Confidence: 0.6
- Dislikes wide cards that waste horizontal space: prefers consolidating related panels into a single card split into semantic columns (e.g. merging "Incidents & Activity" and "Threat Timeline" into one two-column card) instead of leaving separate cards under utilizing the grid width. Confidence: 0.6
- List/table rows (e.g. Device Log) must have visible separator lines between entries — relying only on hover highlight or gap spacing is confusing ("gaada garisnya jadi agak bingung"). Confidence: 0.7
- When multiple sections live inside one container, each section must be visually distinct with clear, perceivable boundaries — distinct surfaces (background/border/radius/padding per panel), column dividers, and section-heading markers — rather than blending into the shared card background. Subtle separation that is barely perceptible is not acceptable. Confidence: 0.75

- Wants a shared ecosystem-wide design system: every app in the same product family must follow one visual language — identical tokens, radius scale, typography, color meanings, motion, and component signatures — with per-app variation limited to product name, logo, nav items, and KPI meanings. Confidence: 0.8
- UI/navigation labels stay in English (Dashboard, Devices, Alerts, Online, Offline), while explanatory copy — empty states, technical reasons, tooltips, error messages — is written in Bahasa Indonesia. Confidence: 0.6
