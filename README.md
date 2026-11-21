# WA Auto Sender — Backend Node.js

Backend **Baileys + Express + Socket.IO** untuk panel web:
https://jakaarwi12.github.io/wa-blast-web/

## Deploy

- **Wispbyte (akun sudah ada):** ikuti **[WISPBYTE.md](WISPBYTE.md)** — repo ini bisa langsung di-Pull lewat GitHub Integration.
- **Render (alternatif):**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jakaarwi12/wa-blast-server)

1. Klik tombol di atas.
2. Login dengan GitHub (Render akan meminta izin akses repo ini).
3. Pilih **Free**, lalu **Apply**. `render.yaml` sudah terisi otomatis.
4. Tunggu sampai status **Live**. Salin URL-nya, misalnya `https://wa-blast-server.onrender.com`.
5. Buka https://jakaarwi12.github.io/wa-blast-web/ → panel **Koneksi Server Node.js** → tempel URL itu → **Simpan & Hubungkan**.

Alternatif: buka langsung
`https://jakaarwi12.github.io/wa-blast-web/?backend=https://wa-blast-server.onrender.com`

## Endpoint

- `GET /` — GUI bawaan (cadangan kalau GitHub Pages bermasalah)
- `GET /health` — status server
- Socket.IO — semua perintah panel

## Catatan penting

- Render **Free** akan tidur setelah ±15 menit tanpa request dan filesystem-nya tidak persisten. Sesi WhatsApp (`sesi_wa/`) bisa hilang saat server bangun lagi → perlu pairing ulang.
- Supaya sesi awet, gunakan **Starter + Persistent Disk** di Render, atau simpan sesi di storage eksternal.
- Nomor pengirim dan target diisi lewat panel, tidak disimpan hardcode di kode.
- Risiko ban nomor tetap ada kalau kirim tiap 2 detik. Pakai nomor cadangan.
