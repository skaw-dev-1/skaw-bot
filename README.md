# SKAW GROUP — Boombox Converter v9.0.0

Rebuild baru untuk TitanBot/Discord.js v14. Fokus versi ini adalah runtime Railway yang stabil, diagnostik yang jelas, queue satu proses, progress embed, history untuk reroll, dan output direct `http://` Top4toP.

## Penting sebelum install

Versi yt-dlp yang dipin adalah `2026.08.19`. Release tersebut menyediakan binary Linux glibc dan binary Linux musl terpisah. Railway yang dipakai SKAW GROUP terdeteksi sebagai Linux x64 + musl, sehingga v9 memilih `yt-dlp_musllinux`; pada Linux glibc v9 memilih `yt-dlp_linux`.

Versi yt-dlp saat ini membutuhkan Node 22+ untuk JavaScript runtime YouTube/EJS. Karena itu v9 mengubah `package.json` menjadi `engines.node >=22.0.0` dan membuat `.node-version` berisi `22`.

## Instalasi yang aman

**Jangan extract paket ini ke dalam repo sebagai folder yang akan ikut di-commit.** Cara yang disarankan:

1. Download `SKAW-Boombox-v9-full.zip`.
2. Extract sebagai folder terpisah, misalnya `/workspaces/SKAW-Boombox-v9`.
3. Buka terminal di root repo TitanBot `/workspaces/skaw-bot`.
4. Jalankan:

```bash
node ../SKAW-Boombox-v9/scripts/install-skaw-boombox-v9.mjs
npm install --save-exact ffmpeg-static@5.3.0
node scripts/check-boombox-v9.mjs
```

Installer akan:

- memvalidasi syntax payload sebelum menyentuh repo;
- menyimpan backup di `/tmp/skaw-boombox-v9-backup-*`, jadi tidak membuat folder backup lama di repo;
- mengganti hanya file Boombox yang ada di paket;
- memastikan `src/app.js` memanggil `startBoomboxService(this)` sekali;
- mengubah `engines.node` menjadi `>=22.0.0`;
- menulis `.node-version` = `22`;
- memakai `ffmpeg-static@5.3.0`;
- menambahkan script `npm run boombox:check`.

Tidak ada perubahan pada Giveaway atau Auto Message di paket ini.

## Railway — WAJIB

Di Railway, buka:

`comfortable-vitality` → service `skaw-bot` → **Variables**

Tambahkan:

```text
RAILPACK_NODE_VERSION=22
```

Lalu redeploy service. Railpack memprioritaskan `RAILPACK_NODE_VERSION` di atas `engines.node`.

Setelah redeploy, buka Railway service shell:

```bash
railway ssh --service skaw-bot
```

dan cek:

```bash
node -v
```

Target: `v22.x.x` atau lebih baru.

## Command Discord

Admin/Manage Server:

```text
/boombox-config channel channel:<CHANNEL>
/boombox-config enable
/boombox-config disable
/boombox-config status
/boombox-config test
/boombox-config reset
```

User di channel yang sudah dikonfigurasi:

```text
/bb url:<URL YouTube/TikTok/Spotify/SoundCloud>
/bb url:<URL> ulang:true
```

Prefix:

```text
!bb <URL YouTube/TikTok/Spotify/SoundCloud>
!bb ulang <URL Top4toP hasil SKAW>
!bb ulang <URL sumber asli>
```

`/bb` dan `!bb` hanya diproses ketika channel cocok dengan channel yang disimpan. URL acak tidak diproses.

## Alur conversion

```text
Discord command
   → validasi guild/channel/cooldown
   → queue
   → yt-dlp metadata
   → download audio
   → FFmpeg → MP3 192K
   → ukuran MP3 divalidasi
   → upload ke Top4toP
   → direct HTTP MP3 divalidasi
   → history tersimpan
   → hasil dikirim ke Discord
```

Untuk Spotify, bot mengambil metadata track dari Spotify oEmbed lalu mencari sumber audio publik yang cocok melalui yt-dlp/YouTube Search. Bot tidak mencoba mengambil file audio privat dari akun Spotify.

## Engine yt-dlp

v9 menggunakan binary resmi yt-dlp dan SHA-256 resmi dari `SHA2-256SUMS`.

Cache default ada di temporary directory:

```text
/tmp/skaw-group/boombox-v9/
```

Variabel opsional:

```text
BOOMBOX_YTDLP_VERSION=2026.08.19
BOOMBOX_RUNTIME_DIR=/custom/writable/cache
BOOMBOX_YTDLP_PATH=/custom/path/to/yt-dlp
BOOMBOX_YTDLP_COOKIES_FILE=/custom/cookies.txt
BOOMBOX_YTDLP_PROXY=http://host:port
BOOMBOX_AUDIO_QUALITY=192K
```

`BOOMBOX_YTDLP_PATH` harus menunjuk ke executable yt-dlp yang benar-benar bisa dijalankan oleh container.

## Top4toP

v9 membaca form upload dari halaman Top4toP saat runtime, membawa hidden/checkbox fields yang ditemukan, mengupload MP3, mencari URL `.mp3` dari response, lalu menormalkannya ke `http://` dan memvalidasi direct response tanpa mengikuti redirect.

Top4toP saat ini mencantumkan MP3 sebagai format yang didukung. Batas upload visitor pada panduan publik adalah 100 MB; v9 memakai default maksimum 95 MB untuk memberi margin.

Top4toP bukan API resmi yang dipaketkan ke v9. Karena itu `boombox-config test` melakukan probe form upload, sementara keberhasilan upload nyata hanya bisa dibuktikan oleh conversion test di deployment yang sedang berjalan.

Gunakan hanya audio yang memang kamu berhak mengunduh/mengonversi dan patuhi aturan layanan Top4toP.

## Reroll

History memetakan source URL ke setiap URL Top4toP yang dibuat SKAW.

Contoh:

```text
!bb ulang http://f1.top4top.io/p_123/test.mp3
```

akan mencari record tersebut dan mengambil `sourceUrl` asli, lalu membuat conversion + upload baru.

Kalau URL Top4toP bukan hasil SKAW, bot tidak menebak sumber asalnya; pengguna harus memasukkan URL sumber asli.

## Pemeriksaan setelah deploy

1. `/boombox-config test`
2. `/boombox-config status`
3. `/boombox-config channel`
4. `/boombox-config enable`
5. jalankan satu test:

```text
/bb url:<URL YouTube pendek/public>
```

Periksa progress sampai muncul:

```text
QUEUE → METADATA → DOWNLOAD → CONVERT → UPLOAD → DONE
```

Hasil akhir harus berupa URL Top4toP direct `http://...mp3`.

## Troubleshooting

Kalau `Node.js 20.x` masih muncul di Discord:

- pastikan `RAILPACK_NODE_VERSION=22` ada di service yang benar;
- redeploy, bukan hanya restart;
- buka Railway SSH dan cek `node -v`.

Kalau muncul `yt-dlp ... ENOENT`:

```bash
railway ssh --service skaw-bot
node -v
ls -lah /tmp/skaw-group/boombox-v9/
```

Lalu:

```bash
/boombox-config test
```

v9 sudah melakukan self-test `yt-dlp --version` sebelum menganggap engine ready. Jadi error binary akan ditampilkan sebagai diagnosis engine, bukan menunggu sampai conversion.

## Rollback

Installer mencatat backup di `/tmp/skaw-boombox-v9-backup-*`.

Contoh:

```bash
node scripts/rollback-skaw-boombox-v9.mjs /tmp/skaw-boombox-v9-backup-YYYY-MM-DDTHH-MM-SS-SSSZ
```

Setelah rollback, review:

```bash
git diff
```

sebelum commit.
