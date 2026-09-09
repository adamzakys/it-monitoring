# Taste

## Communication & reporting
- Writes task specs in Indonesian (Bahasa Indonesia) with English technical terms, and expects the final report in the same style. Confidence: 0.9
- Wants every change reported with the actual file and line number ("Semua perubahan wajib menyebut file dan line number asli"). Confidence: 0.8
- Wants deliverables structured in a fixed order: audit & findings → root cause per symptom → data-flow mapping (source device → collector/backend → DB/API → frontend binding) → patch per file with original line numbers → rationale → runtime/API evidence → items still needing production verification. Confidence: 0.8
- When the user posts feature status as an itemized ✅/⚠️/❌ verdict checklist, responds verdict-by-verdict (already fixed / patched now / requires action outside our code such as device-side config) rather than one blanket summary. Confidence: 0.6
