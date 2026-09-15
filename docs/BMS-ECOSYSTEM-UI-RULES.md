# BMS Ecosystem — UI/UX Rules (Paste ke Sesi AI Coding App Baru)

> Dokumen ini adalah **kontrak desain** untuk semua app baru yang masuk ekosistem BMS.
> Sumber kebenaran: app `it-monitoring` (BMS IT Monitoring), file `public/css/input.css`,
> `public/css/style.css`, dan `public/index.html`. Angka/hex di bawah diambil apa adanya
> dari app tersebut — jangan diganti dengan selera default AI.

---

## 0. Cara Pakai

Kirim ke sesi AI coding app baru, urutannya:

1. Paste blok **Prompt Pembuka** di bawah ini.
2. Paste **seluruh isi dokumen ini** (bagian 1–13) sebagai konteks.
3. Baru kemudian tulis brief fitur app barunya.

Satu app = satu produk, tapi **satu bahasa visual**. Nama produk boleh beda, DNA visual tidak.

### Prompt Pembuka (copy-paste)

```
Kamu membangun app baru yang merupakan bagian dari ekosistem BMS
(PT. Berlian Manyar Sejahtera), satu keluarga dengan "BMS IT Monitoring".

WAJIB: ikuti dokumen "BMS Ecosystem UI/UX Rules" yang saya lampirkan di bawah
secara literal. Token warna, radius, font, motion, dan komponen tidak boleh
dikarang ulang atau "diperbaiki" sesuai selera default.

Gaya target: Enterprise NOC Dashboard — dark, solid, formal, padat data,
tabular, tenang (bukan startup marketing page, bukan glassmorphism).

Sebelum menulis kode, ringkas dulu: (a) token yang akan kamu pakai,
(b) komponen yang akan kamu buat, (c) apa yang TIDAK akan kamu lakukan.
Setelah saya setuju, baru implementasi.
```

---

## 1. Identitas & Vibe

**Satu kalimat:** *Enterprise Network Operations Center — layar gelap yang tenang,
padat data, dan presisi; terasa seperti instrumen, bukan brosur.*

| Dimensi | Aturan |
|---|---|
| Tema | **Dark-only.** Tidak ada light mode. |
| Permukaan | **Solid.** `background` solid + `1px` border tipis. **Tanpa** `backdrop-filter`, tanpa blur, tanpa see-through layering. (Catatan: ada komentar lama "frosted glass" di CSS — itu sudah ditinggalkan; section *"solid surfaces, no see-through layering"* adalah aturan aktif.) |
| Kepadatan | **Tinggi.** Base font `13px`. Banyak informasi dalam viewport 100vh. |
| Sudut | **Minimal:** kontrol `3px`, permukaan `4px`. Hanya pill asli (status/counter) yang `999px`. |
| Bayangan | **Hampir tak terasa** untuk kartu; besar hanya untuk modal/drawer. |
| Warna aksen | **Hanya BMS brand blue `#2596be`** + 3 warna status fungsional. Tidak ada warna dekoratif lain. |
| Nuansa | Tenang, tidak "berteriak". Angka adalah bintangnya, bukan gradien. |

**Terlarang keras:** gradient ungu/biru-pink ala SaaS, glow neon besar, `border-radius`
≥ 12px, emoji sebagai ikon, hero section tengah, ilustrasi 3D, animasi bounce,
kartu-kartu "floating" tanpa border.

---

## 2. Design Tokens (verbatim — jangan diubah)

### 2a. Runtime tokens (`:root`)

```css
:root {
  /* Surfaces — SOLID */
  --bg-base: #0a0e17;              /* page background */
  --bg-surface: #121a2a;           /* sidebar / header / panel */
  --bg-surface-elevated: #1b2436;  /* raised surfaces, badges, inputs */
  --bg-card: #161f30;              /* card fill */
  --bg-card-hover: #1d2739;        /* card hover */
  --bg-hover: #23304a;             /* button / interactive hover */
  --bg-input: #0e1421;             /* recessed input background */

  /* Borders */
  --border-subtle: rgba(255, 255, 255, 0.10);
  --border-highlight: rgba(255, 255, 255, 0.18);

  /* Brand — BMS corporate */
  --color-brand: #2596be;
  --color-brand-strong: #1d7a9c;
  --color-accent: #2596be;

  /* Data-viz */
  --color-inbound: #2596be;
  --color-outbound: #1d7a9c;

  /* Status fungsional — makna tetap, tidak boleh dipakai dekoratif */
  --color-online: #34d399;   /* emerald — settled / success */
  --color-warning: #fbbf24;  /* amber   — pending / degraded */
  --color-offline: #fb7185;  /* rose    — failed / alert */
  --color-info: #2596be;

  /* Text */
  --text-primary: rgba(255, 255, 255, 0.95);
  --text-secondary: rgba(255, 255, 255, 0.72);
  --text-muted: rgba(255, 255, 255, 0.50);

  /* Type */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-display: 'Outfit', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;

  /* Layout */
  --sidebar-left-w: 248px;
  --sidebar-right-w: 320px;

  /* Motion */
  --transition-fast: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-smooth: 0.3s cubic-bezier(0.4, 0, 0.2, 1);

  /* Radius scale — minimal, uniform enterprise rounding */
  --radius-sm: 3px;     /* controls: input, button, nav, chip, tag */
  --radius-md: 4px;     /* surfaces: card, panel, modal, table wrap */
  --radius-pill: 999px; /* genuine pills only: status, counter */
}
```

### 2b. Tailwind v4 layer (`@theme`) — untuk utility `bg-*`, `text-*`, `border-*`

```css
@theme {
  --color-brand: #2596be;
  --color-brand-strong: #1d7a9c;
  --color-brand-soft: rgba(37, 150, 190, 0.12);
  --color-accent: #2596be;
  --color-accent-soft: rgba(37, 150, 190, 0.1);

  --color-bg-base: #0a0e17;
  --color-surface: #121a2a;
  --color-elevated: #1b2436;
  --color-card: #161f30;
  --color-card-hover: #1d2739;

  --color-border-subtle: rgba(255, 255, 255, 0.10);
  --color-border-default: rgba(255, 255, 255, 0.14);
  --color-border-highlight: rgba(255, 255, 255, 0.18);

  --color-online: #34d399;
  --color-warning: #fbbf24;
  --color-offline: #fb7185;

  --color-inbound: #2596be;
  --color-outbound: #1d7a9c;

  --color-text-primary: #f0f3f7;
  --color-text-secondary: rgba(255, 255, 255, 0.72);
  --color-text-muted: rgba(255, 255, 255, 0.50);

  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-display: 'Outfit', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;

  --radius-card: 4px;
  --radius-button: 3px;
  --radius-modal: 6px;

  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.2);
  --shadow-modal: 0 20px 60px rgba(0, 0, 0, 0.5);
}
```

### 2c. Global base

```css
html, body {
  height: 100vh;
  overflow: hidden;              /* shell scroll-nya per-panel, bukan per-page */
  background-color: var(--color-bg-base);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-size: 13px;               /* base kecil = density tinggi */
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

### 2d. Scrollbar (wajib, biar tidak "OS default")

```css
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-subtle); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-highlight); }
```

Font di-load dari Google Fonts:
`Inter:wght@300;400;500;600;700`, `Outfit:wght@500;600;700;800`, `JetBrains Mono:wght@400;500`.

---

## 3. Layout Shell

Shell 3 kolom penuh viewport, `overflow: hidden` di root; tiap panel scroll sendiri.

```
┌────────────┬──────────────────────────────────┬─────────────┐
│ ZONA 1     │ ZONA 2  Header + KPI grid        │ ZONA 5      │
│ Sidebar    ├──────────────────────────────────┤ Event       │
│ kiri       │ ZONA 3  Konten utama / grid      │ Stream      │
│ 248px      │                                  │ 320px       │
│            ├──────────────────────────────────┤ (collapsible│
│ nav +      │ ZONA 4  Analytics (chart, dsb)   │  )          │
│ user panel │                                  │             │
└────────────┴──────────────────────────────────┴─────────────┘
```

```css
#app-container { display: flex; width: 100vw; height: 100vh; overflow: hidden; }

.sidebar-left  { width: var(--sidebar-left-w);  background: var(--bg-surface);
                 border-right: 1px solid var(--border-subtle); flex-shrink: 0; z-index: 20; }
.sidebar-right { width: var(--sidebar-right-w); background: var(--bg-surface);
                 border-left: 1px solid var(--border-subtle); flex-shrink: 0; z-index: 20;
                 transition: width var(--transition-smooth), margin-right var(--transition-smooth); }
```

Aturan shell:
- Lebar sidebar **tetap** (248 / 320), bukan `fr`/persen.
- Pemisah antar zona = **1px border**, bukan shadow/gap besar.
- Sidebar kanan **collapsible**; saat collapsed muncul `btn-floating-expand` di viewport.
- View switching = show/hide panel, **bukan** route reload. Simpan view terakhir ke `localStorage`.
- Tidak ada page scroll. `overflow-y: auto` hanya di list/panel dalam.

### Header (Zona 2)

- Baris atas: judul halaman (`h1` + subtitle) di kiri, indikator di kanan.
- Indikator kanan: badge SLA uptime + SVG sparkline, dan **connection-state-pill** (dot pulse + teks status).
- Di bawahnya: **grid 4 KPI card** — `grid-template-columns: repeat(4, 1fr); gap: 14px;`.
  KPI selalu berjumlah 4 dan bermakna tetap: **Total / OK / Degraded / Failed**
  (kartu ke-4 memakai aksen `--color-offline`).

### Sidebar kiri

Struktur wajib: `brand-header` (logo + nama produk + nama perusahaan) → `nav-menu` → `user-panel` di bawah.

```css
.nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; border-radius: var(--radius-sm);
  color: var(--text-secondary); font-size: 0.875rem; font-weight: 500;
  border: 1px solid transparent; cursor: pointer;
  transition: all var(--transition-fast);
}
.nav-item:hover  { color: var(--text-primary); background: var(--bg-surface-elevated); border-color: var(--border-subtle); }
.nav-item.active {
  color: #ffffff;
  background: rgba(37, 150, 190, 0.16);
  border-color: rgba(37, 150, 190, 0.45);
  box-shadow: inset 3px 0 0 var(--color-brand);   /* tanda aktif = bar kiri, bukan glow */
}
.nav-item svg { width: 18px; height: 18px; stroke-width: 2; flex-shrink: 0; }
```

`nav-badge` (counter) = pill kecil di kanan item; muncul hanya kalau > 0.

---

## 4. Tipografi

| Peran | Font | Ukuran | Berat | Catatan |
|---|---|---|---|---|
| Judul halaman (`h1`) | Outfit (`--font-display`) | ~1.1–1.3rem | 700 | Sentence case |
| Angka hero (KPI, metric) | Outfit | `1.7rem` | 700 | `letter-spacing: -0.5px` |
| Body / tabel | Inter | `0.75–0.875rem` | 400–500 | — |
| Label mikro, header tabel | Inter | `0.6–0.65rem` | 600 | UPPERCASE, `letter-spacing: 0.5–0.8px` |
| Angka teknis / OID / log | JetBrains Mono | `0.7–0.8rem` | 400–500 | — |

Aturan keras:
- **Semua angka data wajib `font-variant-numeric: tabular-nums`** (KPI, nilai metrik, sel tabel, uptime, stat). Ini yang bikin kolom angka rata & tidak "goyang" saat realtime.
- Nama produk & nama perusahaan di brand header: UPPERCASE, `letter-spacing`.
- **Maksimum 2 tingkat warna teks** dalam satu blok: primary untuk nilai, muted/secondary untuk label.
- Jangan pakai lebih dari 3 ukuran font dalam satu komponen.
- Jangan pakai `font-weight: 900` atau italic untuk data; italic hanya untuk pesan status lembut.

```css
.kpi-number {
  font-family: var(--font-display);
  font-size: 1.7rem; font-weight: 700;
  color: var(--text-primary); line-height: 1.1; letter-spacing: -0.5px;
  font-variant-numeric: tabular-nums;
}
```

---

## 5. Komponen (signature wajib)

### 5.1 KPI Card

```css
.kpi-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 16px 18px;
  display: flex; align-items: center; gap: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 4px 20px rgba(0,0,0,0.3);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.kpi-card:hover { background: var(--bg-card-hover); border-color: var(--border-highlight); }
.kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
```

Isi: `kpi-icon-wrap` (kotak ikon ±52px) → `kpi-info` (`kpi-label` / `kpi-number` / `kpi-desc`).
Warna status masuk lewat **border + tint ikon**, bukan mengecat seluruh kartu.

### 5.2 Card umum (device/item card)

Pola dasar sama dengan KPI: solid `--bg-card`, border 1px, radius 4px, padding 16px.

**Status lewat border + tint gradient 180° yang tipis** (satu-satunya pemakaian gradient):

```css
.device-card.fault-online  { border-color: rgba(52, 211, 153, 0.35);
  background: linear-gradient(180deg, rgba(52, 211, 153, 0.14), rgba(52, 211, 153, 0.05)), var(--bg-card); }
.device-card.fault-warning { border-color: rgba(251, 191, 36, 0.40);
  background: linear-gradient(180deg, rgba(251, 191, 36, 0.16), rgba(251, 191, 36, 0.06)), var(--bg-card); }
.device-card.fault-offline { border-color: rgba(251, 113, 133, 0.45);
  background: linear-gradient(180deg, rgba(251, 113, 133, 0.18), rgba(251, 113, 133, 0.07)), var(--bg-card); }
```

Hover menaikkan border alpha **dan** menambah glow status yang sangat lembut
(`box-shadow: 0 0 20px rgba(<status>, 0.12)`).

Selected (kartu yang sedang dibuka) — border menebal, padding dikurangi 1px agar ukuran tidak lompat:

```css
.device-card.selected {
  border-width: 2px;
  padding: 15px;
  background: rgba(37, 150, 190, 0.04);
  border-color: rgba(37, 150, 190, 0.3);
}
```

### 5.3 Status pill / badge

```css
.status-pill {
  padding: 3px 12px; border-radius: 999px;
  font-size: 0.65rem; font-weight: 600;
  display: inline-flex; align-items: center; gap: 6px;
  transition: var(--transition-fast);
}
.status-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.online  { color: var(--color-online); }
.status-pill.warning { color: var(--color-warning); }
.status-pill.offline { color: var(--color-offline); }
```

Badge severity (log/incident) = teks berwarna + border kiri, **bukan** blok solid:
`critical/emergency/alert → #ef4444` (`font-weight: 800`), warning → `--color-warning`.

### 5.4 Tombol (3 varian saja)

| Varian | Style | Pakai untuk |
|---|---|---|
| Primary `.btn-action` | bg & border `--color-brand`, teks `#fff` | aksi utama |
| Secondary `.btn-secondary` | bg `--bg-surface-elevated`, border `--border-subtle`, teks primary | aksi pendamping |
| Filter `.btn-filter` | transparan; `.active` = bg brand + teks putih | segment/toggle grup |
| Danger `.btn-danger` | hanya untuk destruktif, terpisah dari grup | hapus/reset |

```css
.btn-action {
  background: var(--color-brand); border: 1px solid var(--color-brand); color: #ffffff;
  padding: 7px 14px; border-radius: var(--radius-sm);
  font-size: 0.8rem; font-weight: 600; font-family: var(--font-sans);
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  transition: var(--transition-fast);
}
```

Aturan: tombol **selalu punya border** (walau warnanya sama dengan bg), radius `3px`,
tinggi konsisten, ikon opsional 14–16px. Tidak ada tombol tanpa label teks.

### 5.5 Input / form

```css
.form-control {
  background: var(--bg-input);           /* recessed = lebih gelap dari kartu */
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 10px 14px; font-size: 0.85rem; font-family: var(--font-sans);
  outline: none; transition: all var(--transition-fast);
}
```

Focus: border → `--color-brand` (bukan outline browser).

### 5.6 Tabel

Wrapper `.table-wrap` dengan border + radius 4px + `overflow-x: auto`.

```css
table thead th {
  background: var(--bg-surface-elevated);
  padding: 9px 12px; text-align: left;
  color: var(--text-muted); font-weight: 600;
  text-transform: uppercase; font-size: 0.62rem; letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border-subtle); white-space: nowrap;
}
table tbody tr { border-bottom: 1px solid var(--border-subtle); }
table td { font-variant-numeric: tabular-nums; }
```

Zebra **tidak dipakai**; pemisah baris = 1px border. Hover baris = `--bg-card-hover`.

### 5.7 Modal & Drawer

```css
.modal-box {
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  width: 90%; max-width: 520px;
  box-shadow: 0 24px 70px rgba(0,0,0,0.6);
  animation: zoomIn 0.25s ease-out;
}
```

Drawer/panel samping: `slideInRight 0.3s`. Backdrop: hitam transparan (bukan blur).

### 5.8 Progress / resource bar

Track tipis (tinggi ±6px) + fill radius 4px. Warna fill mengikuti ambang:
`< 75%` brand → `≥ 75%` warning → `≥ 90%` offline.

### 5.9 Empty / unsupported state

**Selalu ada kalimat alasan**, bukan sekadar `-` atau `--`:
`"Belum ada data …"`, `"Perangkat tidak melaporkan … (alasan)"`.
Kelas `*-empty-state` (app existing: `.dic-empty-state`, `.alerts-empty`; chart: `.dic-chart-empty`):
teks `--text-muted`, italic, padding longgar.

### 5.10 Event stream / activity feed (Zona 5)

Item = baris dengan `icon` + `title` + `target` + `time-tag`. Warna ikon = severity.
Enter animation `slideInRight 0.3s`. Flash highlight untuk event baru:
`animation: threatFlash 1.8s ease-out;`. Header panel: judul + counter pill + toggle collapse.

---

## 6. Warna = Makna (non-negotiable)

| Warna | Hex | Arti tunggal |
|---|---|---|
| Brand blue | `#2596be` | identitas, aksi utama, inbound, item aktif |
| Brand strong | `#1d7a9c` | outbound, hover/active state tombol primary |
| Emerald | `#34d399` | online / settled / sukses |
| Amber | `#fbbf24` | warning / degraded / pending |
| Rose | `#fb7185` | offline / failed / critical |
| Red (badge) | `#ef4444` | severity critical di log |
| Mint (chart) | `#10b981` | nilai minimum (latency) |
| Cyan (chart) | `#00f2fe` | seri rata-rata / inbound chart |
| Orange (chart) | `#ff9900` | seri outbound chart |

Aturan:
- Warna status **hanya** untuk status. Jangan pakai emerald/amber/rose sebagai dekorasi.
- Satu layar maksimal: brand + 3 status. Tidak ada warna keempat kecuali di chart.
- Teks di atas fill berwarna = `#fff`; jangan bikin teks berwarna di atas fill berwarna.

---

## 7. Motion

| Token | Nilai | Pakai untuk |
|---|---|---|
| `--transition-fast` | `0.2s cubic-bezier(0.4, 0, 0.2, 1)` | hover, border, warna, nav |
| `--transition-smooth` | `0.3s cubic-bezier(0.4, 0, 0.2, 1)` | collapse sidebar, panel |

Keyframes yang tersedia dan boleh dipakai:

```css
@keyframes pulse-glow   { 0%,100% { opacity:1; transform:scale(1); }  50% { opacity:.6; transform:scale(.85); } } /* live dot, 1.5s infinite */
@keyframes pulse-danger { /* denyut untuk state kritis */ }
@keyframes slideInRight { /* event/panel masuk */ }
@keyframes zoomIn       { /* modal 0.25s ease-out */ }
@keyframes fadeSlideIn  { /* baris list 0.2s ease-out */ }
@keyframes fadeIn       { /* 0.2s ease-out */ }
@keyframes spin         { /* spinner: 0.8s linear infinite, border-top-color brand */ }
@keyframes threatFlash  { /* highlight 1.8s ease-out untuk event baru */ }
```

Aturan:
- Animasi = **umpan balik**, bukan hiburan. Hanya: masuknya elemen, perubahan status, kelangsungan live.
- **Chart: `animation: false`** (wajib) supaya streaming 1s mulus.
- Tidak ada `bounce`, `elastic`, parallax, atau animasi durasi > 0.4s (kecuali spinner & flash).
- Hormati `prefers-reduced-motion` di app baru.

---

## 8. Chart / Data-viz

Chart.js v4, canvas, `maintainAspectRatio: false`, `animation: false`.

```js
// Signature garis (area chart realtime)
{
  borderWidth: 2,
  pointRadius: 0,          // tanpa titik — garis saja
  tension: 0.3,            // kurva lembut
  fill: true,              // area di bawah garis, pakai gradient vertikal
}
// Grid & ticks
scales: {
  x: { grid: { color: 'rgba(255,255,255,0.10)' }, ticks: { color: '#a8b6c8', font: { size: 9 }, maxTicksLimit: 6 } },
  y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.14)' }, ticks: { color: '#a8b6c8', font: { size: 9 } } }
}
```

Aturan:
- Legend custom (HTML), **bukan** legend bawaan Chart.js: `legend-dot` + `legend-item` + `legend-bar`.
- Donut: ada angka di tengah (`donut-center-number` + label kecil di bawahnya).
- Warna seri wajib dari daftar bagian 6; inbound=brand, outbound=brand-strong.
- Line min/avg/max: `min → #10b981`, `avg → #00f2fe` (borderWidth 2), `max → #ef4444` (borderWidth 1.5).
- Sumbu selalu punya satuan di tick (`Mbps`, `ms`, `%`).
- Chart kosong → `.chart-empty` dengan pesan alasan, bukan kanvas kosong.

---

## 9. Ikonografi

- **Inline SVG saja** (Lucide/Feather style), `fill="none"`, `stroke="currentColor"`,
  `stroke-width="2"`, `viewBox="0 0 24 24"`.
- Ukuran: nav 18px, tombol 14–16px, KPI 22–24px, indikator 12px.
- Warna ikon = `currentColor` mengikuti state induknya.
- **Tidak ada emoji**, tidak ada icon font, tidak ada ilustrasi raster (kecuali logo brand).

---

## 10. Copy & Bahasa

- **Label UI & navigasi: English** (Dashboard, Devices, Alerts, Reports, Settings, Online, Offline, Warning) — konsisten dengan app existing.
- **Kalimat penjelas, empty state, alasan teknis, tooltip: Bahasa Indonesia** yang ringkas dan informatif.
- Nada: tenang, teknis, tanpa marketing. `"Perangkat tidak merespons atau tidak menyediakan metrik ini via SNMP/InfluxDB"` — bukan `"Oops! Something went wrong 😅"`.
- Angka: format `1.93 GiB`, `512.2 MiB`, `2.53 GiB` — selalu ada satuan, 1 desimal untuk nilai, dan **persentase dalam tanda kurung** setelah nilai.
- Waktu: `HH:MM:SS` 24 jam locale `id-ID`.

---

## 11. Responsive

Breakpoint yang dipakai app existing:

| Range | Perilaku |
|---|---|
| ≥ 1201px | Layout penuh 3 kolom |
| ≤ 1200px | Grid KPI tetap 4, konten menyusut |
| ≤ 1024px | Sidebar kiri icon-only, sidebar kanan auto-hidden |
| ≤ 768px | Bottom nav bar; tidak ada panel samping |
| ≤ 480px | Tabel `font-size: 0.7rem`, padding menyusut |

Aturan: jangan redesign di mobile — **sembunyikan**, bukan ubah bentuk. Grid KPI tetap 4 kolom sampai 1024px, baru turun.

---

## 12. Do / Don't

**Do**
- Solid surfaces + 1px border sebagai bahasa utama pemisah.
- Radius 3–4px; pill hanya untuk status/counter.
- `tabular-nums` di semua angka.
- Uppercase + letter-spacing untuk label mikro & header tabel.
- Satu warna aksen (brand) + 3 warna status dengan makna tetap.
- Alasan tekstual untuk setiap data yang kosong/tidak didukung.
- Ikon inline SVG `currentColor`.

**Don't**
- ❌ `backdrop-filter` / glassmorphism / kartu tembus pandang.
- ❌ Gradient dekoratif (satu-satunya gradient adalah tint status kartu 180° yang tipis).
- ❌ `border-radius` ≥ 12px, shadow blur besar pada kartu, glow neon.
- ❌ Warna ungu/pink/biru-terang ala SaaS starter.
- ❌ Emoji, ilustrasi 3D, mascot, hero section tengah.
- ❌ Animasi bounce/spring; chart dengan animasi.
- ❌ Menampilkan `--`/`-` tanpa penjelasan.
- ❌ Mengarang token baru "karena lebih bagus" — deviasi harus disetujui eksplisit.

---

## 13. Checklist Sebelum Ship

- [ ] Semua warna berasal dari token bagian 2 (tidak ada hex baru di luar daftar).
- [ ] Semua radius ∈ {3px, 4px, 999px} (modal boleh 6px).
- [ ] Base body `13px`; semua angka `tabular-nums`.
- [ ] Shell 100vh, `overflow: hidden` di root, scroll per-panel.
- [ ] Tidak ada `backdrop-filter`, tidak ada gradient dekoratif.
- [ ] Chart: `animation: false`, `pointRadius: 0`, legend HTML custom, tick ada satuan.
- [ ] Setiap state kosong/error punya kalimat alasan.
- [ ] Hover/focus pakai token transisi, bukan durasi karangan.
- [ ] Ikon = inline SVG `currentColor` (tidak ada emoji/icon font).
- [ ] Warna status hanya bermakna status (online/warning/offline).
- [ ] Tampilan dicek di 1440 / 1024 / 768 px.

---

## Lampiran — Parametrisasi untuk App Baru

Yang **boleh** berubah per app:

| Item | Aturan |
|---|---|
| Nama produk (brand header) | Ganti sesuai app baru. |
| Nama perusahaan | Tetap `PT. Berlian Manyar Sejahtera`. |
| Logo | Pakai logo brand BMS yang sama. |
| Item navigasi | Sesuaikan domain app, jumlah 5–8 item, ikon gaya sama. |
| 4 KPI card | Sesuaikan makna, tapi tetap 4 dan tetap punya hierarki Total → OK → Degraded → Failed. |
| Chart | Sesuaikan metrik, warna tetap dari palet. |

Yang **tidak boleh** berubah: seluruh token bagian 2, radius, tipografi,
bahasa warna, motion, dan aturan komponen di bagian 5.
