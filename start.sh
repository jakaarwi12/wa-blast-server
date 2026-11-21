#!/data/data/com.termux/files/usr/bin/bash
# Jalankan dari folder tempat file ini berada
cd "$(dirname "$0")" || exit 1

# Alamat publik yang dipakai untuk membuka panel di browser
export PUBLIC_IP="${PUBLIC_IP:-78.154.103.41}"
export PORT="${PORT:-14836}"
# 0.0.0.0 = dengarkan semua interface. Jangan diisi IP publik kalau IP itu
# bukan milik perangkat ini (bind akan gagal, otomatis fallback ke 0.0.0.0).
export HOST="${HOST:-0.0.0.0}"

echo "===================================================="
echo " WA Auto Sender - Node.js"
echo " Folder   : $(pwd)"
echo " Bind     : ${HOST}:${PORT}"
echo " Buka di  : http://${PUBLIC_IP}:${PORT}"
echo " Lokal    : http://127.0.0.1:${PORT}"
echo " Tekan CTRL+C untuk menghentikan"
echo "===================================================="

node index.js
