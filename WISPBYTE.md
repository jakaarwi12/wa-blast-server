# Deploy backend ke Wispbyte (Node.js)

Panduan singkat supaya backend ini bisa dipakai oleh panel:
https://jakaarwi12.github.io/wa-blast-web/

## 1. Buat server

1. Buka https://wispbyte.com/client/servers
2. **Create Server**
3. Isi nama, pilih **Free Plan**, Docker image: **Node.js**
4. Tunggu sampai server aktif.

## 2. Ambil kode backend

Di server yang baru dibuat:

- **Cara A (paling mudah):** buka **GitHub Integration**, isi repo:
  ```
  https://github.com/jakaarwi12/wa-blast-server
  ```
  branch `main`, lalu klik **Clone / Pull**.
- **Cara B (manual):** buka **Files → Upload Files**, upload tiga file saja:
  `index.js`, `package.json`, `package-lock.json`.
  **Jangan upload `node_modules`** — Wispbyte akan install otomatis dari `package.json`.

## 3. Atur Startup

Buka menu **Startup**:

- **JS_FILE:** `index.js` ← **WAJIB**. Kalau masih `Kirimwa.js` (sisa server lama), server akan error `Cannot find module '/home/container/Kirimwa.js'`.
- **Docker Image:** pilih **Node.js 20** kalau tersedia. Kalau image yang tersedia cuma **Node 19.9.0**, lihat bagian **"Node 19"** di bawah.
- **Startup Command:** biarkan default (sudah otomatis `npm install` lalu `node index.js`)
- Di **Server Configuration / Environment**, tambahkan:

| Nama | Nilai | Keterangan |
|------|-------|------------|
| `PORT` | port dari **Console → Server info → Address** | misal `1234` (angle setelah `:`) |
| `HOST` | `0.0.0.0` | wajib supaya container bisa diakses dari luar |
| `AUTO_UPDATE` | `1` | opsional, auto `git pull` saat restart |

## Node 19 (kalau image Node 20 tidak tersedia)

Baileys 6.7.18 punya gerbang `engine-requirements.js` yang menolak `npm install` di Node < 20:

```
❌ This package requires Node.js 20+ to run reliably.
```

Itu **hanya skrip install**, bukan runtime. Ada dua cara melewatinya:

### Cara A — upload ZIP yang sudah berisi node_modules (paling pasti)

1. Ambil file `wa-blast-wispbyte.zip` (sudah disiapkan, isinya `index.js` + `node_modules` + folder sesi).
2. Di server Wispbyte: **Files → Upload Files** → pilih ZIP itu → setelah terupload, klik `...` → **Unarchive**.
3. Di **Startup**, ganti **Startup Command** menjadi hanya:

```
/usr/local/bin/node /home/container/index.js
```

   (tanpa `npm install`, jadi gerbang Node 20 tidak dijalankan sama sekali)

### Cara B — tetap pakai npm, lewati skrip install

Ganti **Startup Command** menjadi:

```
if [[ -d .git ]] && [[ ${AUTO_UPDATE} == "1" ]]; then git pull; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install --omit=dev --ignore-scripts --no-audit --no-fund; fi; /usr/local/bin/node /home/container/index.js
```

`--ignore-scripts` melewati `engine-requirements.js` dan semua postinstall (aman, karena semua dependensi murni JavaScript).

## 4. Start

Buka **Console → Start**. Tunggu ±1–3 menit saat `npm install` berjalan.

Log sukses terlihat seperti:

```
[xx.xx.xx] Server aktif di http://0.0.0.0:1234
[xx.xx.xx] Belum ada akun pengirim tertaut...
```

Kalau muncul `Cannot find module`, berarti `npm install` belum jalan — klik restart, atau tambahkan di **Additional Node.js Packages**: `@whiskeysockets/baileys express socket.io pino`.

## 5. Dapatkan URL publik

Di **Console → Server info → Address** biasanya ada `node.wispbyte.com:1234`.
Klik **Add Domain** untuk dapat alamat HTTPS, misalnya:

```
https://wa-blast-xyz.wispbyte.app
```

**Penting:** pakai URL **HTTPS**. Panel di GitHub Pages itu HTTPS, jadi browser akan memblokir kalau backend masih `http://IP:port` (mixed content).

## 6. Hubungkan ke panel web

Buka https://jakaarwi12.github.io/wa-blast-web/

Isi **Koneksi Server Node.js** dengan URL HTTPS dari Wispbyte → **Simpan & Hubungkan**.
Atau langsung:

```
https://jakaarwi12.github.io/wa-blast-web/?backend=https://wa-blast-xyz.wispbyte.app
```

Badge berubah jadi **TERHUBUNG**, lalu lakukan pairing nomor pengirim.

## Catatan

- Sesi WhatsApp disimpan di folder `sesi_wa/` dalam server Wispbyte (disk 1 GB), jadi lebih awet daripada Render Free.
- Jangan kirim lebih dari ~1 pesan/detik kalau nomor mau aman.
- Baileys 6.7.18 dipakai karena sudah teruji; versi terbaru punya advisory keamanan, tapi belum saya uji di sini.
