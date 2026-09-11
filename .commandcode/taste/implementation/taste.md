# Taste

## Tooling & codebase navigation
- Expects a repository to be indexed into the codebase-memory knowledge graph (MCP tool) before/for code work — a bare "Index this repository using codebase-memory." should result in locating and invoking that MCP tool. Confidence: 0.5

## Approach to fixes
- Audit before patching: when fixing a bug in redesigned code, find the previously-working implementation and restore the broken binding rather than rebuilding or redesigning the UI. Confidence: 0.7
- When the user asks "is this a protocol/tooling limitation or a bug in our code?" (e.g. why can't LLDP give neighbor IPs), investigate first — read the code path and probe the live device/protocol — and explicitly answer the limitation-vs-code question before proposing a fix. A placeholder like "unknown" should be treated as an app gap until the protocol is proven unable to supply the data. Confidence: 0.6
- Prefer not to change the backend unless a needed endpoint genuinely does not exist; reuse existing endpoints and data sources (no new endpoints "if not needed", no backend change "bila frontend saja cukup"). Confidence: 0.8
- Requires runtime evidence before claiming success — "Jangan tulis PASS tanpa bukti" — verify against the running system (live API/browser probes), not just static reasoning. Confidence: 0.9
- When a panel shows no data, audit whether the data actually exists upstream (old dashboard, API, DB) before concluding the data is genuinely empty — treat it as a broken frontend binding first. Confidence: 0.7
- When a panel shows no data, first determine whether the data source itself is dead (e.g. Telegraf stopped writing) vs. when the UI was wrong. Confidence: 0.8
- When the user reports entries present on the device (pasted vendor CLI output) but missing in the web UI, answer first with an evidence-backed verdict on which side is at fault — device not forwarding vs. app dropping/not showing — proven from runtime (stored rows, raw syslog line, injected test packet). If the pipeline is clean, deliver device-side configuration steps and say explicitly it is not an app bug rather than "fixing" code. Confidence: 0.5
- Fix generated artifacts at the source that creates them (config template/generator), not just the currently-broken files: the user expects newly added resources (e.g. a device added via UI later) to also come out valid, so regenerate existing files from the corrected generator and confirm the real binary/command parses them. Confidence: 0.7
- For large multi-part tasks expects a written plan first ("pahami dan buatkan plan dulu agar kamu paham") and iterates on it: plan revisions/approval questions until agreed, then implements phase-by-phase with per-phase verification and a final regression check. Confidence: 0.7


# Taste

## Data & runtime binding
- No dummy/fake data and no hardcoded numbers in fixes; panels must bind to real existing runtime data, with neutral placeholders (e.g. "—") for fields that genuinely don't exist. Confidence: 0.9
- Never substitute fabricated fallback series (e.g. a sine/cos "trendline") for missing real history just to keep a chart populated or visually consistent — the user flags such data as "dummy". When the real history table is empty, prefer an honest empty trendline plus truthful copy explaining when real data will appear (e.g. "menunggu minimal 1 hari data riil") and expose how many real data days an aggregate covers (e.g. sla_data_days). Confidence: 0.8
- Health/readiness status must reflect the current state, not stale history: a checkmark must not stay green just because old records exist. Use a short freshness window (env-overridable) so a reset or removed configuration promptly turns the indicator off, and treat "configured but idle/stale" as a distinct, honest state. Confidence: 0.6
- For push/event-driven signals that have no natural heartbeat (syslog, traps) prefer an active verification flow — trigger a test event on the device (e.g. RouterOS `/log warning "BMS-TEST"`) and wait for it to actually arrive — over passive "does any record exist" queries, which cannot distinguish "configured but idle" from "configuration removed". Confidence: 0.5
- For push-based ingestion (device sends logs to the app), verify health from the data that actually arrived (query the stored records / recent log count) — do NOT probe the client-side port. Confirm the data-flow direction (who is server vs. client) before writing a readiness check, because a port test in the wrong direction is meaningless and always reports failure even when data flows fine. Confidence: 0.7
- Never leave a panel blank or stuck loading: use explicit states — loading skeleton, "Failed to load runtime data" on API failure, "No telemetry available" when there is no data. Confidence: 0.7

## UI/chart choices
- Prefers chart types matched to the metric semantics: area chart for throughput RX/TX, line chart for latency (min/avg/max) and packet-loss time-series; resource utilization (CPU/memory/disk/temp) as progress bars. Dislikes donut gauges. Confidence: 0.6
- Prefers tables/lists of chronological data (e.g. the daily Reports table) ordered newest-first — "ordernya terbaru terlebih dahulu" — so the most recent row is at the top rather than at the bottom of a scroll. Confidence: 0.9
- Realtime panels must keep charts live and clean up timers/WebSocket listeners on close to avoid memory leaks. Confidence: 0.6
- Perceived responsiveness of detail/realtime panels matters: a multi-second wait before info/chart lines appear ("telat muncul ... garisnya") is treated as a bug, not acceptable behavior. Charts should initialize the moment a panel opens and be seeded from available history so they start painting immediately — not wait for a slow backend fetch — and serial backend fallbacks that block first paint should run in parallel under a time budget. Confidence: 0.6
- UIs that show ingested device data (logs, syslog) need a full-fidelity "Raw" view of the original line as received, not only normalized fields — the user validates the app by pasting the device's own output (e.g. MikroTik `/log print`) next to the web rows, and treats hidden/reformatted info as a mismatch ("bisa infonya raw log aja dan semua sehingga paham"). Raw-as-sent must stay viewable even when a normalized rendering exists. Confidence: 0.8
- Display the source device's own timestamp ("jam perangkat") as the primary time for logs when the parser can extract it, because the user compares rows against device-local time; server receive-time is only a fallback and should be clearly labeled when used. Confidence: 0.8
- Log views must show everything that actually arrived, including entries that look like tests/diagnostics — the user asks for rows to be displayed "walaupun test", so don't silently filter or hide entries based on message content. Confidence: 0.5
- Log severity shown in the UI must reflect the real event semantics, not merely the syslog PRI: vendor topic tokens (e.g. MikroTik `system,error,critical`, `system,clock,critical,info`) are the stronger signal and must raise the stored severity, and rows stored before topic parsing existed must still render corrected severity derived from the raw line at display time. Confidence: 0.6

## Data architecture & realtime sync
- Single source of truth per information category: a metric or incident must appear in exactly one panel; when two widgets show the same data (e.g. Live Traffic + Analytics Throughput) they must share one state/dataset instead of separate fetches or duplicated displays. Confidence: 0.8
- Realtime charts must use persistent datasets with a fixed-cap sliding window (append new point, shift oldest); never recreate the chart or wholesale-replace chart arrays on each poll — that is what caused the "chart resets to start" bug. Confidence: 0.8
- Never pre-pad chart buffers to a fixed length with empty labels, zeros, or nulls: padded slots render as a misleading flat/empty segment ("empty left + small sliver right") that the user reads as data not matching reality. Buffers hold only real points and grow up to the cap before shifting. Confidence: 0.8
- Reset a shared realtime window only when its data source actually changes (device/interface switch) — re-opening the same detail view or a periodic poll must not wipe/restart the already-painted live buffer. Backend history backfill is a rescue path reserved for when the WS stream is down/stale, never a periodic overwrite while ticks flow. Confidence: 0.7
- Chart time labels must use backend-provided timestamps; do not generate local client time when the backend already sends time. Confidence: 0.7
- Avoid duplicate wiring: one scheduler per data cadence and a single subscription per stream (subscribe once on open, remove on close) — no second polling interval or WebSocket listener for the same data. Confidence: 0.8

## Backend & API change discipline
- Backend/API changes must stay backward compatible: when enriching a response or payload, keep the legacy fields/shape alongside new structured fields (additive change), never replace them wholesale, so existing endpoints and consumers keep working. Confidence: 0.9
- When a metric is genuinely unsupported by the device (no sensor, MIB not implemented) or its data source is unavailable, surface an informative per-metric status with a clear reason and a data-source label (influx/snmp) — never a bare "-"/"—" and never an invented value just to look filled. Confidence: 0.9
- Prefers capability-based, vendor-agnostic collection over assuming every device exposes the same data: probe the real device (e.g. SNMP walk) before hardcoding OIDs/values, and structure the code as an extensible registry/adapter where adding a new vendor or log source = one entry, not a change to core logic. Confidence: 0.7
- Schema changes must be delivered as idempotent migrations in `schema.sql` (e.g. an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` section executed by `initDB()` on every startup), not as declarations that only work on a fresh `CREATE TABLE` — long-lived databases must upgrade in place without drop/recreate, and a code/DB schema mismatch (columns declared in schema.sql but missing in the live DB) counts as an unfixed bug. Confidence: 0.7
- Keeps clear role separation across monitoring layers (metrics/events/incidents/logs): raw logs are always stored as an audit trail (zero-loss); only explicit correlation rules turn logs into events; incidents stay owned by the health engine — a log must never auto-become an incident. Normalize external data to an internal model so the UI never depends on vendor formats. Confidence: 0.7

## Device Discovery & Presentation
- For device discovery nodes (e.g., unmanaged devices graph), always expose the complete set of scraped attributes — particularly providing multiple transport options like both IPv4 and IPv6 addresses — so the user can select the address needed for manual configuration or connection. Confidence: 0.8

## Visual & presentation style
- Prefers a formal, enterprise-grade aesthetic over playful or casual UI — expects sharp angles, compact layouts, and subdued colors that evoke professional monitoring dashboards (e.g., NOC tools, Datadog, SolarWinds). Confidence: 0.9
- Prefers minimal border radii (3–4px for cards/buttons) and thin, opacity-driven borders instead of generous rounding or solid-color borders. Confidence: 0.8
- Prefers very subtle, barely-perceptible shadows for elevation rather than prominent drop-shadows. Confidence: 0.8
- Prefers muted, lower-saturation brand and functional colors; operational indicators should be precise and recognizable but not overly vibrant. Confidence: 0.8
- Prefers compact, dense typography (e.g., ~13px base font-size, tight line-heights) to maximize dashboard information density while maintaining legibility. Confidence: 0.8

## CLI & platform compatibility
- Device names passed to RouterOS CLI must have spaces stripped/removed entirely (no separators) — e.g., "MikroTik VM" becomes "MikroTikVM". Do NOT escape spaces with backslashes or replace with underscores/other chars. Confidence: 0.9
- Always use RouterOS API-style forward-slash syntax for ALL generated CLI commands — subcommands separated by `/` (e.g., `/system/logging/action/add name=X target=remote`, `/system/snmp/add`, `/system/logging/add topics=...`). Do NOT use space-separated subcommand style (e.g., never `/system logging action add`). This is the canonical RouterOS CLI format. Confidence: 0.9
- Only include 3 essential monitoring gaps in command generation: **network**, **snmp**, **syslog**. Do NOT generate recommendations for non-essential features such as SNMP traps or Telegraf agents — remove/hide them from the gaps list and probe set. Confidence: 0.9

## Topology & stale-data visibility
- When a monitored link/connection drops, keep the last-known item visible in the UI with an explicit status marker (e.g. dashed red edge + "last seen X ago" tooltip) instead of hiding/removing it — a single failed discovery cycle must not make a whole branch vanish as if the cable was cut; don't hide information, mark the condition. Confidence: 0.7
- Never silently discard admin-entered overrides/annotations during destructive operations (e.g. a "Reset all" button): snapshot and restore manual values such as a manually set IPv4 rather than wiping them. Confidence: 0.7
- Prefers explicit/manual cleanup of accumulated stale data over automatic deletion: stale/red entries persist until an admin-triggered reset, with no silent auto-cleanup window. Confidence: 0.6