# Taste
- Writes task specs in Indonesian (Bahasa Indonesia) with English technical terms, and expects the final report in the same style. Confidence: 0.9
- Wants every change reported with the actual file and line number ("Semua perubahan harus/wajib menyebut file dan line number asli"). Confidence: 0.85
- Wants deliverables structured in a fixed order: audit & findings → root cause per symptom → data-flow mapping (source device → collector/backend → DB/API → frontend binding, including an old-vs-new field mapping table and the query before vs after the fix) → patch per file with original line numbers → rationale → runtime/API evidence → items still needing production verification. Confidence: 0.8
- When the user posts feature status as an itemized ✅/⚠️/❌ verdict checklist, responds verdict-by-verdict (already fixed / patched now / requires action outside our code such as device-side config) rather than one blanket summary. Confidence: 0.6
- When handed an itemized todo/checkbox checklist, treats it as potentially stale: verifies each item's real state in the code first, then only completes what is genuinely outstanding and reports per-item status. Confidence: 0.8
- Prefers direct execution over conversational filler or idle status updates; when awaiting results on a long-running task, expects the model to act immediately and deliver outputs rather than lingering with explanatory text. Confidence: 0.8
- Prefers discussing the investigation scope, approach, and expected findings with the model before diving into implementation. Confidence: 0.9
