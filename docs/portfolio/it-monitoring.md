# BMS IT Monitoring — Dokumentasi Portofolio

> **Cara pakai dokumen ini**
> Ini draf isi portofolio. Bagian 1–3 siap dipindahkan ke platform portofolio (Webflow, Framer, WordPress, dsb).
> Setiap penanda `[BUTUH SCREENSHOT ...]` harus diganti dengan gambar asli — daftar ringkasnya ada di **Lampiran A**.
> Semua angka di dokumen ini **hanya** yang benar-benar ada di produk. Bagian **Results & Impact** berisi placeholder yang wajib kamu isi dengan data nyata (lihat catatan di bagian itu).

---

## 1. Project Overview

### Judul Proyek

**BMS IT Monitoring — Platform Monitoring Jaringan Real-Time untuk Network Operations Center**

*Alternatif judul (pilih satu):*
- BMS IT Monitoring: Visibilitas Real-Time Seluruh Infrastruktur Jaringan
- BMS IT Monitoring: Dari Polling Perangkat ke Keputusan Operasional dalam 1 Detik

---

### Slug URL

```
bms-it-monitoring
```

*Alternatif:* `bms-network-monitoring` · `bms-noc-platform` · `itnetmon`

**Meta description (≤160 karakter, untuk SEO):**
> Platform monitoring jaringan real-time untuk NOC: metrik 1 detik via ICMP/SNMP, peta topologi otomatis, manajemen insiden, dan laporan SLA 30 hari.

---

### Ringkasan Singkat — Value & Tujuan Bisnis

**BMS IT Monitoring** menyatukan seluruh pengawasan infrastruktur jaringan ke dalam satu layar operasi. Tim IT dan NOC bisa melihat kondisi setiap perangkat — router, switch, access point, server, hingga UPS dan IP camera — secara **real-time dengan pembaruan tiap 1 detik**, tanpa membuka banyak alat terpisah.

**Masalah yang diselesaikan:**
- Kondisi jaringan diperiksa secara manual dan reaktif; gangguan baru diketahui setelah pengguna melapor.
- Data kesehatan perangkat tersebar di banyak tempat, tidak ada satu sumber kebenaran.
- Tidak ada riwayat insiden dan laporan ketersediaan yang bisa dipertanggungjawabkan.

**Nilai yang diberikan:**
- **Deteksi dini, bukan menunggu lapor** — status tiap perangkat naik-turun secara otomatis (Online / Warning / Offline) dari polling nyata.
- **Satu layar untuk semua** — inventaris, topologi, insiden, log, dan laporan SLA dalam satu dasbor.
- **Kesiapan konfigurasi perangkat** — sistem mendiagnosa perangkat yang belum terpasang dan langsung menyiapkan perintah konfigurasi siap tempel, sehingga perangkat baru cepat masuk ke pengawasan.
- **Akuntabilitas operasional** — laporan SLA 30 hari, riwayat insiden, dan jejak log yang bisa diekspor.

**Tujuan bisnis:** mempersingkat waktu dari "ada gangguan" menjadi "gangguan diketahui dan ditindaklanjuti" — dengan dasar data yang jujur (sistem tidak menampilkan metrik sintetis; jika data belum ada, ia menyatakannya secara eksplisit).

---

### Narasi Lengkap Overview

> **[BUTUH SCREENSHOT 01 — HERO]**
> Tangkapan **layar penuh Dashboard (kelima zona terlihat sekaligus)** pada resolusi desktop 1440px.
> Pastikan ada beberapa perangkat dengan status berbeda (online, warning, offline) dan grafik sedang bergerak.
> Simpan sebagai `01-dashboard-hero.png`.

![Dashboard NOC BMS IT Monitoring — 5 zona](./images/01-dashboard-hero.png)

#### Konteks

Infrastruktur jaringan sebuah organisasi tumbuh terus: router di tiap lantai, switch distribusi, access point, server, perangkat pendukung seperti UPS dan IP camera. Semakin banyak perangkat, semakin sulit memantau semuanya secara manual. Ketika sebuah link turun atau sebuah router kelebihan beban, dampaknya dirasakan pengguna lebih dulu daripada oleh tim IT.

**BMS IT Monitoring** dibangun untuk membalik urutan itu: operator melihat masalah di layar **sebelum** pengguna merasakannya.

#### Apa yang dibangun

Sebuah platform monitoring yang berjalan penuh di browser dengan dasbor bergaya **Enterprise NOC** — gelap, padat data, dan tenang; dirancang agar angka menjadi perhatian utama, bukan dekorasi. Dasbor disusun dalam **lima zona** yang semuanya muat dalam satu viewport:

| Zona | Isi | Fungsi bagi operator |
|---|---|---|
| **1. Sidebar kiri** | Navigasi modul + profil operator | Berpindah antar area kerja tanpa memuat ulang halaman |
| **2. Header & KPI** | Uptime 30 hari + sparkline, indikator koneksi langsung, 4 kartu agregat | Ringkasan kondisi seluruh jaringan sekali pandang |
| **3. Center Stage** | Grid inventaris perangkat dinamis | Menemukan dan memilih perangkat dengan cepat |
| **4. Analytics** | Grafik trafik inbound/outbound & donat distribusi kesehatan | Membaca tren dan pola beban jaringan |
| **5. Event Stream** | Umpan insiden kronologis | Mengikuti kejadian terbaru secara langsung |

> **[BUTUH SCREENSHOT 02 — ZONA 2 & 4]**
> Crop bagian **Header + 4 kartu KPI** (termasuk badge uptime 30 hari dan sparkline), lalu satu tangkapan lagi untuk **grafik trafik + donat kesehatan**.
> Simpan sebagai `02-kpi-header.png` dan `03-analytics.png`.

![Header dan KPI agregat](./images/02-kpi-header.png)

![Grafik trafik real-time dan distribusi kesehatan](./images/03-analytics.png)

#### Bagaimana datanya mengalir

Platform ini mengumpulkan data dari perangkat melalui beberapa protokol standar, lalu menyajikannya kembali ke browser:

- **Metrik (kondisi jaringan):** perangkat di-*polling* berkala lewat **ICMP (ping)** untuk ketersediaan/latensi, dan **SNMP** untuk trafik per-antarmuka serta sumber daya sistem (CPU, memori, uptime). Hasilnya masuk ke basis data deret waktu, lalu dialirkan ke dasbor melalui **WebSocket dengan irama 1 detik** sehingga grafik bergerak mulus tanpa memuat ulang halaman.
- **Log & peristiwa:** perangkat mengirim **syslog** ke platform, dan **SNMP trap** dapat diterima untuk notifikasi kejadian. Log dinormalisasi (berbagai format vendor diterima), disimpan sebagai jejak audit, lalu dikorelasikan menjadi **event** dan **insiden** yang punya alur tindak lanjut.
- **Topologi:** platform menelusuri hubungan antar-perangkat dari data tetangga jaringan, sehingga terbentuk **peta topologi otomatis** yang memperlihatkan siapa terhubung ke siapa.

> **[BUTUH SCREENSHOT 04 — EVENT STREAM]**
> Panel kanan **Event Stream / Incidents** saat ada beberapa entri insiden aktif (warna berbeda per tingkat keparahan).
> Simpan sebagai `04-event-stream.png`.

![Event stream insiden real-time](./images/04-event-stream.png)

#### Alur kerja operator

1. **Buka dasbor** — langsung terlihat: berapa perangkat total, berapa sehat, berapa bermasalah.
2. **Perhatikan kartu merah/amber** — klik perangkat yang bermasalah untuk membuka panel detail.
3. **Panel detail perangkat** menampilkan kesehatan menyeluruh: ringkasan status, trafik langsung, latensi (min/avg/max/jitter), packet loss, ringkasan antarmuka, sumber daya sistem, log perangkat, serta daftar insiden dan garis waktu kejadian.
4. **Tindak lanjuti di Alerts** — tabel audit insiden mencatat tingkat keparahan, perangkat, waktu kejadian, durasi, dan status; operator dapat menandai insiden sudah diakui (ACK).
5. **Tinjau laporan** — halaman Reports menyajikan ketersediaan (SLA) 30 hari, volume data yang masuk, rata-rata latensi, packet loss kumulatif, dan tabel harian yang bisa **diekspor ke CSV**.

> **[BUTUH SCREENSHOT 05 — DEVICE DETAIL]**
> **Device Intelligence Center** (panel detail perangkat, seluruh kartu terlihat). Pilih perangkat yang punya data lengkap.
> Simpan sebagai `05-device-detail.png`.

![Panel detail perangkat (Device Intelligence Center)](./images/05-device-detail.png)

#### Untuk perangkat yang belum termonitor

Salah satu pembeda platform ini adalah **Configuration Readiness**: sebelum perangkat bisa dipantau, sistem menjalankan diagnosa cepat (konektivitas, SNMP, syslog) dan menghasilkan **daftar perintah konfigurasi yang siap disalin** ke perangkat — misalnya untuk perangkat RouterOS. Jadi proses *onboarding* perangkat tidak lagi menebak-nebak, cukup mengikuti instruksi yang sudah disesuaikan dengan perangkat tersebut.

> **[BUTUH SCREENSHOT 06 — READINESS]**
> Halaman **Readiness** yang menampilkan hasil pemindaian (centang/silang per lapis pemeriksaan) beserta blok perintah konfigurasi yang dihasilkan.
> Simpan sebagai `06-readiness.png`.

![Configuration Readiness dan perintah konfigurasi yang dihasilkan](./images/06-readiness.png)

---

## 2. Keunggulan & Fitur (Highlights)

*Ditulis untuk audiens non-teknis — fokus pada kapabilitas, kemudahan pakai, dan tampilan.*

### 1. Semua kondisi jaringan dalam satu layar
Dasbor lima zona menampilkan kesehatan seluruh jaringan tanpa berpindah halaman: ringkasan angka di atas, daftar perangkat di tengah, tren trafik di bawah, dan umpan kejadian di samping. Tidak ada tab yang harus dicari, tidak ada data yang tersembunyi.

### 2. Diperbarui setiap detik, bukan setiap beberapa menit
Grafik dan status bergerak secara langsung (pembaruan **1 detik**). Operator melihat perubahan saat itu juga — bukan potret lama yang sudah kedaluwarsa.

### 3. Status yang langsung terbaca
Setiap perangkat punya warna yang konsisten dan bermakna tetap: **hijau = normal, kuning = perlu perhatian, merah = bermasalah**. Warna hanya dipakai untuk status — sehingga sebuah warna di layar tidak pernah ambigu.

### 4. Peta topologi yang menggambar dirinya sendiri
Platform memetakan hubungan antar-perangkat secara otomatis dan menampilkan jaringan sebagai graf yang interaktif. Perangkat yang belum terdaftar pun tetap muncul sebagai titik agar gambaran jaringan tidak berlubang. Ada tombol **Rescan** untuk memperbarui peta kapan saja.

> **[BUTUH SCREENSHOT 07 — TOPOLOGY]**
> Halaman **Map Topology** dengan graf yang cukup ramai (minimal 5–8 node) dan legenda status.
> Simpan sebagai `07-topology.png`.

![Peta topologi jaringan interaktif](./images/07-topology.png)

### 5. Pusat insiden, bukan sekadar daftar alarm
Insiden tercatat lengkap: tingkat keparahan, perangkat terdampak, waktu pertama terdeteksi, durasi, dan status penanganan. Sistem juga menekan alarm berulang (tidak "spam") dan menggabungkan kejadian sejenis, sehingga operator fokus pada masalah nyata.

### 6. Deteksi ancaman dari korelasi log
Platform tidak hanya menampilkan log — ia **membaca pola** di dalamnya dan mengangkatnya menjadi sesi insiden: misalnya percobaan login gagal berulang, perubahan konfigurasi, perubahan pengaturan waktu, atau perangkat yang reboot. Hasilnya adalah garis waktu ancaman yang bisa ditindaklanjuti, bukan tumpukan baris teks.

> **[BUTUH SCREENSHOT 08 — ALERTS]**
> Halaman **Alerts** (tabel audit insiden) dengan beberapa baris dan badge tingkat keparahan berwarna, sekaligus **drawer detail insiden** terbuka.
> Simpan sebagai `08-alerts.png`.

![Pusat audit insiden](./images/08-alerts.png)

### 7. Laporan ketersediaan yang bisa dipertanggungjawabkan
Halaman Reports menyajikan **ketersediaan 30 hari**, volume data yang masuk, latensi rata-rata, dan packet loss kumulatif, lengkap dengan tabel harian dan tombol **Export CSV** untuk lampiran laporan.

> **[BUTUH SCREENSHOT 09 — REPORTS]**
> Halaman **Reports** menampilkan angka SLA, sparkline/grafik, dan tabel harian.
> Simpan sebagai `09-reports.png`.

![Laporan performa dan ketersediaan (SLA)](./images/09-reports.png)

### 8. Menambah perangkat baru jadi cepat dan terarah
Menambahkan perangkat baru hanya butuh beberapa isian, dengan uji koneksi bawaan. Untuk perangkat yang belum siap, halaman Readiness memberikan panduan langkah demi langkah beserta perintah konfigurasinya.

> **[BUTUH SCREENSHOT 10 — ADD DEVICE]**
> **Modal Add Device** yang terbuka, memperlihatkan pilihan tipe perangkat dan frekuensi polling.
> Simpan sebagai `10-add-device.png`.

![Menambahkan perangkat baru dengan uji koneksi](./images/10-add-device.png)

### 9. Tampilan yang terasa seperti instrumen, bukan brosur
Antarmuka dirancang dengan disiplin: permukaan solid, garis pemisah tipis, sudut minimal, dan angka yang selalu rata (tabular). Tidak ada gradien dekoratif atau animasi berlebihan. Efek visual hanya dipakai saat ada sesuatu yang perlu diberi tahu — misalnya saat status berubah.

### 10. Tetap jalan meski infrastruktur pendukung belum lengkap
Platform dapat berjalan dengan basis data penuh, atau dalam mode ringan ketika basis data belum tersedia, sehingga sistem tetap dapat dievaluasi dan diuji sejak dini. Tidak ada metrik yang "dipalsukan": jika data belum ada, layar menyatakannya dengan jelas beserta alasannya.

### 11. Inventaris perangkat yang rapi dan lengkap
Puluhan jenis perangkat dikenali dengan ikon dan label yang konsisten — dari router, switch, dan access point, sampai server, hypervisor, penyimpanan, CCTV, UPS, dan perangkat IoT. Inventaris menjadi satu sumber kebenaran untuk seluruh aset jaringan.

> **[BUTUH SCREENSHOT 11 — DEVICES]**
> Halaman **Devices** (tabel inventaris) dengan beberapa baris, ikon tipe perangkat, dan status.
> Simpan sebagai `11-devices.png`.

![Inventaris perangkat](./images/11-devices.png)

### 12. Pengaturan yang bisa diubah tanpa menyentuh kode
Konfigurasi integrasi basis data dapat diubah langsung dari halaman **Settings** di browser, termasuk uji koneksi. Kredensial sensitif tidak pernah dikirim balik ke browser.

> **[BUTUH SCREENSHOT 12 — SETTINGS]**
> Halaman **Settings** dengan status InfluxDB dan Telegraf agent yang terlihat "aktif/terhubung".
> Simpan sebagai `12-settings.png`.

![Pengaturan sistem dan integrasi](./images/12-settings.png)

---

## 3. Hasil & Dampak Bisnis (Results & Impact)

> ⚠️ **PENTING — jangan mengarang metrik.**
> Isi hanya dengan angka yang benar-benar kamu miliki dari penggunaan nyata (data internal, catatan operasional, atau pengukuran sebelum/sesudah).
> Semua placeholder `[ISI: ...]` di bawah **wajib diganti** atau **dihapus** jika datanya tidak tersedia. Lebih baik menampilkan sedikit klaim jujur daripada banyak klaim kosong.

### 3.1 Ringkasan dampak (isi dengan data nyata)

| Aspek | Sebelum | Sesudah | Sumber data |
|---|---|---|---|
| Jumlah perangkat terpantau | `[ISI: berapa perangkat]` | `[ISI: berapa perangkat]` | Inventaris / halaman Devices |
| Waktu mengetahui gangguan (deteksi) | `[ISI: dicek manual / setelah lapor]` | `[ISI: mis. < 1 menit dari gangguan]` | Catatan operator |
| Waktu menambah perangkat baru ke pengawasan | `[ISI: menit/jam]` | `[ISI: menit]` | Catatan onboarding |
| Ketersediaan jaringan dilaporkan (SLA) | `[ISI: belum terukur]` | `[ISI: mis. 99,x % / 30 hari]` | Halaman Reports |
| Insiden tercatat & terlacak | `[ISI: tidak terdokumentasi]` | `[ISI: berapa insiden/bulan]` | Halaman Alerts |

### 3.2 Pencapaian yang bisa dibuktikan dari produk

Bagian ini berisi fakta yang **dapat diverifikasi langsung di dalam sistem** (bukan estimasi). Pilih yang paling relevan untuk ditonjolkan.

- **Pembaruan kondisi jaringan setiap 1 detik** — dananya mengalir berkelanjutan ke dasbor, bukan polling berkala yang lambat.
- **Cakupan laporan ketersediaan 30 hari** dengan tabel harian dan **ekspor CSV**.
- **Puluhan jenis perangkat** dikenali dalam satu taksonomi inventaris.
- **Deteksi ancaman berbasis korelasi log** dengan **11 aturan** yang mengangkat pola berbahaya menjadi sesi insiden.
- **Onboarding terpandu** — diagnostik kesiapan konfigurasi plus perintah siap tempel (mis. 7 aturan logging per topik untuk perangkat RouterOS).
- **Multi-protokol** dalam satu platform: ICMP, SNMP, syslog (UDP/TCP), SNMP trap, serta penemuan topologi LLDP/CDP.
- **Jejak audit log** dengan retensi yang dapat diatur, sehingga kejadian dapat ditelusuri kembali.

> **[BUTUH SCREENSHOT 13 — BUKTI DAMPAK]**
> Tangkapan layar **halaman Reports dengan angka nyata** (SLA, ingestion, latency, tabel harian) — ini yang paling kuat untuk bagian "Hasil".
> Bila ada, tambahkan tangkapan **sebelum/sesudah** (mis. catatan manual lama vs. dasbor).
> Simpan sebagai `13-impact-report.png`.

![Bukti dampak: laporan ketersediaan dengan data nyata](./images/13-impact-report.png)

### 3.3 Testimoni / kutipan (opsional)

Bila ada rekan tim atau pemangku kepentingan yang memakai sistem ini, satu kutipan singkat sangat menguatkan.

> `[ISI: kutipan, mis. "Sebelumnya kami tahu kabel putus dari laporan pengguna. Sekarang terlihat di layar sebelum ada yang menghubungi." — Nama, Peran]`

---

## Lampiran A — Daftar Screenshot yang Dibutuhkan

Simpan semua gambar di folder `docs/portfolio/images/` dengan nama berikut. Format disarankan **PNG**, lebar minimal **1600px** (desktop), dan jangan menyertakan data sensitif (kredensial, IP publik, nama pengguna asli jika perlu).

| # | Nama file | Isi yang harus terlihat |
|---|---|---|
| 01 | `01-dashboard-hero.png` | Layar dashboard penuh, kelima zona terlihat, grafik bergerak |
| 02 | `02-kpi-header.png` | Header + 4 kartu KPI + badge uptime 30 hari & sparkline |
| 03 | `03-analytics.png` | Grafik trafik inbound/outbound + donat distribusi kesehatan |
| 04 | `04-event-stream.png` | Panel kanan Event Stream/Incidents dengan beberapa entri |
| 05 | `05-device-detail.png` | Panel detail perangkat lengkap (semua kartu) |
| 06 | `06-readiness.png` | Halaman Readiness: hasil pemindaian + blok perintah konfigurasi |
| 07 | `07-topology.png` | Peta topologi dengan beberapa node + legenda |
| 08 | `08-alerts.png` | Halaman Alerts + drawer detail insiden terbuka |
| 09 | `09-reports.png` | Halaman Reports: SLA, angka, tabel harian |
| 10 | `10-add-device.png` | Modal Add Device (tipe perangkat + frekuensi polling) |
| 11 | `11-devices.png` | Tabel inventaris perangkat |
| 12 | `12-settings.png` | Halaman Settings: status InfluxDB & Telegraf |
| 13 | `13-impact-report.png` | Reports dengan data nyata (bukti dampak) |
| 14 | `14-logo.png` *(opsional)* | Logo brand di header sidebar |
| 15 | `15-threat-timeline.png` *(opsional)* | Threat Timeline di panel detail perangkat |

### Tips pengambilan gambar
- Gunakan data yang **wajar dan beragam** (campur status online/warning/offline) agar layar terlihat hidup.
- Samakan ukuran jendela browser di semua tangkapan agar tampilan konsisten saat disandingkan.
- Samakan tingkat zoom (disarankan 100%) dan sembunyikan bilah bookmark.
- Untuk graf topologi, atur agar node tidak saling menumpuk sebelum menangkap.
- Redaksi nama perangkat/IP bila bersifat rahasia — konsisten di seluruh gambar.

---

## Lampiran B — Informasi Teknis Ringkas (untuk lampiran/credential)

*Bagian ini untuk kolom "Tools & Technologies" di portofolio, bukan untuk dibaca klien awam.*

| Kategori | Teknologi |
|---|---|
| Backend | Node.js, Express, WebSocket (`ws`) |
| Basis data | PostgreSQL (dengan mode fallback tanpa DB), InfluxDB v2 (deret waktu) |
| Pengumpulan data | Telegraf (ICMP/SNMP), protokol ICMP, SNMP v2c, Syslog UDP/TCP, SNMP Trap, LLDP/CDP |
| Frontend | Vanilla JavaScript, Chart.js, vis-network, Tailwind CSS v4 |
| Karakter UI | Enterprise NOC — dark-only, padat data, permukaan solid, angka tabular |

**Nama & brand:** produk **BMS IT Monitoring** (nama teknis lama: ITNETMON), bagian dari ekosistem **BMS** milik **PT. Berlian Manyar Sejahtera**.

---

## Lampiran C — Catatan Kejujuran (WAJIB dibaca sebelum publikasi)

Beberapa klaim lama di dalam repo **tidak akurat** dan **jangan** dimasukkan ke portofolio:

| Klaim | Status | Sebaiknya |
|---|---|---|
| "simulated dynamic telemetry" / metrik sintetis | Sudah tidak ada di kode | Sebut sebagai mode fallback **data nyata** (ICMP/SNMP), bukan simulasi |
| "5-layer diagnostics probe" | Implementasinya **3 probe** (ping, SNMP, syslog) | Tulis "diagnosa kesiapan (ping, SNMP, syslog)" |
| Dukungan **MNDP** | Disebut di komentar, tidak diimplementasikan | Cukup sebut **LLDP & CDP** |
| Akses **SSH** ke perangkat | Disebut di docstring, tidak ada implementasi | Jangan disebut |
| **SNMP v3** | Tidak ada di kode (hanya v2c) | Sebut **SNMP v2c** |
| "SLA target: 99.5%" & "100% nodes are reachable" | Teks statis di UI, bukan hasil ukur | Jangan jadikan klaim dampak; gunakan angka nyata dari halaman Reports |

Prinsipnya: **tampilkan apa yang benar-benar diukur sistem.** Kredibilitas portofolio justru datang dari klaim yang bisa dibuktikan.
