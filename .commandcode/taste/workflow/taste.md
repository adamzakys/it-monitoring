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
- Fix generated artifacts at the source that creates them (config template/generator), not just the currently-broken files: the user expects newly added resources (e.g. a device added via UI later) to also come out valid, so regenerate existing files from the corrected generator and confirm the real binary/command parses them. Confidence: 0.7
- For large multi-part tasks expects a written plan first ("pahami dan buatkan plan dulu agar kamu paham") and iterates on it: plan revisions/approval questions until agreed, then implements phase-by-phase with per-phase verification and a final regression check. Confidence: 0.7
