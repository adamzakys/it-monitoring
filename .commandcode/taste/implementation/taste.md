# Taste

## Data & runtime binding
- No dummy/fake data and no hardcoded numbers in fixes; panels must bind to real existing runtime data, with neutral placeholders (e.g. "—") for fields that genuinely don't exist. Confidence: 0.9
- Never substitute fabricated fallback series (e.g. a sine/cos "trendline") for missing real history just to keep a chart populated or visually consistent — the user flags such data as "dummy". When the real history table is empty, prefer an honest empty trendline plus truthful copy explaining when real data will appear (e.g. "menunggu minimal 1 hari data riil") and expose how many real data days an aggregate covers (e.g. sla_data_days). Confidence: 0.8
- Never leave a panel blank or stuck loading: use explicit states — loading skeleton, "Failed to load runtime data" on API failure, "No telemetry available" when there is no data. Confidence: 0.7

## UI/chart choices
- Prefers chart types matched to the metric semantics: area chart for throughput RX/TX, line chart for latency (min/avg/max) and packet-loss time-series; resource utilization (CPU/memory/disk/temp) as progress bars. Dislikes donut gauges. Confidence: 0.6
- Realtime panels must keep charts live and clean up timers/WebSocket listeners on close to avoid memory leaks. Confidence: 0.6

## Data architecture & realtime sync
- Single source of truth per information category: a metric or incident must appear in exactly one panel; when two widgets show the same data (e.g. Live Traffic + Analytics Throughput) they must share one state/dataset instead of separate fetches or duplicated displays. Confidence: 0.8
- Realtime charts must use persistent datasets with a fixed-cap sliding window (append new point, shift oldest); never recreate the chart or wholesale-replace chart arrays on each poll — that is what caused the "chart resets to start" bug. Confidence: 0.8
- Never pre-pad chart buffers to a fixed length with empty labels, zeros, or nulls: padded slots render as a misleading flat/empty segment ("empty left + small sliver right") that the user reads as data not matching reality. Buffers hold only real points and grow up to the cap before shifting. Confidence: 0.8
- Reset a shared realtime window only when its data source actually changes (device/interface switch) — re-opening the same detail view or a periodic poll must not wipe/restart the already-painted live buffer. Backend history backfill is a rescue path reserved for when the WS stream is down/stale, never a periodic overwrite while ticks flow. Confidence: 0.7
- Chart time labels must use backend-provided timestamps; do not generate local client time when the backend already sends time. Confidence: 0.7
- Avoid duplicate wiring: one scheduler per data cadence and a single subscription per stream (subscribe once on open, remove on close) — no second polling interval or WebSocket listener for the same data. Confidence: 0.8
