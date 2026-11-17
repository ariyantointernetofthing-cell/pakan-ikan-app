# Panduan Pakan Ikan Otomatis: ESP32 + Firebase + Aplikasi Android Sendiri

Panduan ini untuk pemula. Ikuti urutannya dari atas ke bawah, jangan dilompati.
Total waktu sekitar 1 sampai 2 jam untuk pertama kali.

## Isi paket

Lihat struktur folder lengkap di [README](../README.md#struktur-folder). Ringkasnya:
`firmware/` (kode ESP32), `aplikasi/` (aplikasi Android), `firebase/` (aturan database), `docs/` (panduan dan gambar).

## Gambaran cara kerja

```
 ┌──────────────┐        internet        ┌─────────────────────┐        internet        ┌──────────────┐
 │  ESP32 alat  │ ─── kirim status ────► │  Firebase Realtime  │ ◄──── baca status ──── │  Aplikasi HP │
 │  pakan ikan  │ ◄── perintah/jadwal ── │      Database       │ ──── tulis perintah ─► │   (APK)      │
 └──────────────┘                        └─────────────────────┘                        └──────────────┘
```

Firebase berperan sebagai "papan tulis" bersama. ESP32 menulis jarak sensor, level pakan, dan status setiap 5 detik. Aplikasi menulis perintah "beri pakan" dan jadwal. ESP32 langsung tahu jika ada perubahan karena terus mendengarkan (stream).

Perbandingan dengan versi Blynk:

| Fitur Blynk lama | Versi baru |
|---|---|
| V1 status pakan, V5 status sistem | Kartu status + tanda "Alat online/offline" di aplikasi |
| V2 tombol beri pakan | Tombol besar "BERI PAKAN SEKARANG" |
| V4 jarak, V9 level (Gauge) | Lingkaran persen + teks jarak sensor |
| V6, V7, V8 jadwal (Time Input) | 3 kartu jadwal dengan pilihan jam dan hari |
| V10 pemberian terakhir | Teks "Terakhir diberi pakan" + daftar riwayat 10 terakhir |
| logEvent laporan 2 jam | Kartu "Laporan Berkala" di aplikasi (lihat catatan di bagian 6) |

Rangkaian kabel tidak berubah sama sekali. Semua pin sama dengan kode lamamu.

---

## LANGKAH 1. Menyiapkan Firebase

### 1.1 Buat proyek
1. Buka https://console.firebase.google.com dan login dengan akun Google.
2. Klik **Create a project** (atau **Add project**).
3. Isi nama proyek, misalnya `pakan-ikan`. Klik **Continue**.
4. Matikan **Google Analytics** (tidak dibutuhkan). Klik **Create project**, tunggu, lalu **Continue**.

### 1.2 Buat Realtime Database
1. Di menu kiri pilih **Build** lalu **Realtime Database**.
2. Klik **Create Database**.
3. Lokasi: pilih **Singapore (asia-southeast1)** karena paling dekat dengan Indonesia. Klik **Next**.
4. Pilih **Start in locked mode**. Klik **Enable**.
5. Di bagian atas halaman database terlihat alamat seperti:
   `https://pakan-ikan-xxxxx-default-rtdb.asia-southeast1.firebasedatabase.app/`
   **Salin alamat ini** ke Notepad. Ini adalah `DATABASE_URL`.

### 1.3 Aktifkan login Email/Password
1. Menu kiri **Build** lalu **Authentication**. Klik **Get started**.
2. Tab **Sign-in method**, pilih **Email/Password**, aktifkan saklar pertama (Enable), klik **Save**.

### 1.4 Buat 2 akun pengguna
Masih di Authentication, buka tab **Users**, klik **Add user** dua kali:

| Untuk | Email | Password |
|---|---|---|
| Alat ESP32 | `esp32@pakanikan.id` | buat sendiri, minimal 6 karakter |
| Kamu sebagai **admin** (aplikasi HP) | email kamu, misalnya Gmail | buat sendiri |

Email untuk ESP32 tidak perlu email sungguhan. Catat kedua password di Notepad. Pengguna lain (keluarga, teman) nanti ditambahkan langsung dari aplikasi oleh admin.

> Kenapa dua akun? Supaya password di dalam kode ESP32 berbeda dengan password yang kamu pakai di HP.

### 1.5 Pasang aturan keamanan (Rules)
1. Kembali ke **Realtime Database**, buka tab **Rules**.
2. Hapus semua isinya, lalu tempel isi file `3_firebase/database.rules.json`.
3. Ganti semua `GANTI_EMAIL_ADMIN@gmail.com` dengan email akun admin dari langkah 1.4 (huruf kecil semua). Jika email ESP32 kamu berbeda dari `esp32@pakanikan.id`, ganti juga.
4. Klik **Publish**.

Arti aturan ini:

| Data | Siapa yang boleh |
|---|---|
| `pakanIkan` (status, perintah, jadwal, riwayat) | ESP32, admin, dan pengguna yang ditambahkan admin |
| `pengguna` (daftar pengguna) | dibaca admin dan pengguna, diubah hanya oleh admin |
| `wifiAlat` (nama dan password WiFi alat) | hanya ESP32 dan admin |

**Penting:** biarkan **Enable create (sign-up)** di Authentication > Settings > User actions tetap **tercentang**. Fitur ini dibutuhkan supaya admin bisa menambah pengguna dari aplikasi. Tetap aman, karena orang yang mendaftar sendiri ditolak oleh Rules.

> Cara termudah mengisi Rules, `config.js`, dan kode ESP32: pakai halaman **Setup Firebase Pakan Ikan** langkah 7. Halaman itu membuat ketiganya otomatis dari isianmu.

### 1.6 Ambil konfigurasi untuk aplikasi
1. Klik ikon **roda gigi** di samping "Project Overview", pilih **Project settings**.
2. Di tab **General**, cari tulisan **Web API Key**. Salin ke Notepad. Ini adalah `API_KEY` untuk ESP32.
3. Gulir ke bawah ke **Your apps**, klik ikon **`</>`** (Web).
4. Nama aplikasi: `Pakan Ikan App`. **Jangan** centang Firebase Hosting. Klik **Register app**.
5. Akan muncul kode berisi `const firebaseConfig = { ... }`. Salin bagian itu ke Notepad. Klik **Continue to console**.

Contoh yang akan kamu dapat:
```js
const firebaseConfig = {
  apiKey: "AIzaSyB...",
  authDomain: "pakan-ikan-xxxxx.firebaseapp.com",
  databaseURL: "https://pakan-ikan-xxxxx-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pakan-ikan-xxxxx",
  storageBucket: "pakan-ikan-xxxxx.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc..."
};
```

**Penting:** pastikan ada baris `databaseURL`. Jika tidak ada, tambahkan sendiri memakai alamat dari langkah 1.2 (tanpa garis miring `/` di akhir).

---

## LANGKAH 2. Menyiapkan Arduino IDE

1. Unduh dan pasang **Arduino IDE 2** dari https://www.arduino.cc/en/software
2. **Pasang paket board ESP32**
   - Buka **Tools** lalu **Board** lalu **Boards Manager**.
   - Cari `esp32`, pilih **esp32 by Espressif Systems**, klik **Install**.
   - Jika tidak muncul: buka **File** lalu **Preferences**, isi kolom **Additional boards manager URLs** dengan
     `https://espressif.github.io/arduino-esp32/package_esp32_index.json` lalu ulangi.
3. **Pasang library** lewat **Tools** lalu **Manage Libraries** (atau ikon buku di kiri):
   - Cari `ESP32Servo`, pasang **ESP32Servo** by Kevin Harrington.
   - Cari `Firebase ESP Client`, pasang **Firebase Arduino Client Library for ESP8266 and ESP32** by **Mobizt**. Jika ditanya "install dependencies", pilih **Install all**.
   - Library Blynk tidak dibutuhkan lagi.

---

## LANGKAH 3. Upload kode ke ESP32

1. Buka folder `firmware/arduino/PakanIkanFirebase/`.
2. Salin file `kredensial.contoh.h` menjadi **`kredensial.h`** di folder yang sama (paket zip pribadimu sudah berisi `kredensial.h` yang terisi). Buka dengan Notepad lalu isi:

```cpp
#define WIFI_SSID      "NamaWiFiKamu"      // nama WiFi / hotspot
#define WIFI_PASSWORD  "passwordWiFi"      // password WiFi
#define API_KEY        "AIzaSyB..."        // dari langkah 1.6 nomor 2
#define DATABASE_URL   "https://pakan-ikan-xxxxx-default-rtdb.asia-southeast1.firebasedatabase.app"
#define USER_EMAIL     "esp32@pakanikan.id" // akun ESP32 dari langkah 1.4
#define USER_PASSWORD  "password-esp32"    // password akun ESP32
#define OTA_PASSWORD   "passwordOTA"       // password update lewat WiFi
```

   `kredensial.h` **tidak ikut** ke GitHub (ada di `.gitignore`), jadi password aman walau repository publik.
   Lalu buka `PakanIkanFirebase.ino` dengan Arduino IDE. Di **Tools > Partition Scheme** pilih **Minimal SPIFFS (1.9MB APP with OTA)**.

3. Pilih board: **Tools** lalu **Board** lalu **esp32** lalu **ESP32 Dev Module**.
4. Colokkan ESP32 ke laptop, pilih **Tools** lalu **Port** (misalnya COM3).
5. Klik tombol **Upload** (panah ke kanan). Jika macet di "Connecting....", tahan tombol **BOOT** di ESP32 sampai upload berjalan.
6. Buka **Serial Monitor** (ikon kaca pembesar kanan atas), set **115200 baud**.

Yang seharusnya muncul:
```
Menghubungkan ke WiFi "NamaWiFiKamu"......
WiFi terhubung, IP: 192.168.x.x
Firebase Client v4.4.x
Token info: type = id token (GITKit token), status = on request
Token info: type = id token (GITKit token), status = ready
Sistem pakan ikan siap
Terhubung ke Firebase, mendengarkan perintah aplikasi
Jarak objek: 12.40 cm, level pakan: 57%
```

7. Cek di Firebase Console, buka **Realtime Database** tab **Data**. Akan muncul `pakanIkan > status` dengan angka yang berubah tiap 5 detik. Jika ini sudah muncul, **ESP32 kamu sudah berhasil**.

> Catatan Wokwi: pakai isi folder `firmware/wokwi/` (sketch.ino, diagram.json, libraries.txt). WiFi sudah diset `Wokwi-GUEST`; isi akun Firebase di bagian atas sketch.ino.

---

## LANGKAH 4. Membuat APK lewat GitHub (tanpa Android Studio)

Server GitHub yang akan membuatkan APK. Kamu cukup upload file, lalu menunggu.

### 4.1 Isi config.js DULU
1. Buka file `aplikasi/app/src/main/assets/config.js` dengan **Notepad**.
2. Ganti seluruh isinya dengan hasil A dari halaman Setup Firebase langkah 7. Isinya `firebaseConfig` dan `EMAIL_ADMIN`.
3. Simpan (Ctrl+S).

### 4.2 Siapkan akun GitHub
1. Buka https://github.com/signup dan daftar (email, password, username). Verifikasi email yang dikirim GitHub.
2. Catat **username** kamu. Contoh: jika profilmu `https://github.com/rolasagusta`, maka username adalah `rolasagusta`.

### 4.3 Upload dengan file sekali klik (cara A, disarankan, khusus Windows)
1. **Ekstrak ZIP dulu.** Klik kanan `PakanIkanFirebase.zip`, pilih **Extract All**, lalu **Extract**. Jangan menjalankan file dari dalam ZIP.
2. Buka folder hasil ekstrak (folder utama, yang berisi README.md).
3. Klik dua kali **`UPLOAD_KE_GITHUB.bat`**.
   - Jika muncul layar biru **"Windows protected your PC"**, klik **More info** lalu **Run anyway**. Ini muncul karena file buatan sendiri, bukan virus.
4. **Jika Git belum terpasang**, file ini memasangnya otomatis. Klik **Yes** jika Windows minta izin. Setelah tulisan "Git selesai dipasang" muncul, tutup jendela hitam itu lalu **klik dua kali file .bat lagi**.
5. **Buat repository dulu di browser** (jika belum): klik **+** di kanan atas github.com, pilih **New repository**, nama `pakan-ikan-app`, pilih **Public**, jangan centang README, klik **Create repository**.
6. Salin link repository dari address bar browser, contoh `https://github.com/ariyantointernetofthing-cell/pakan-ikan-app`.
7. Kembali ke jendela hitam, **klik kanan** untuk menempel link, lalu tekan **Enter**. Link SSH (`git@github.com:...`) juga diterima dan diubah otomatis.
8. Jika upload pertama gagal, file ini otomatis mencoba lagi.
9. Muncul jendela **Connect to GitHub**. Klik **Sign in with your browser**, lalu **Authorize**. Pastikan login dengan akun **pemilik repository**. Jika ditanya "Hapus login GitHub lama dan login ulang?", tekan **Y**.
10. Jika berhasil, muncul tulisan **[OK] BERHASIL** dan browser membuka tab **Actions**. Lanjut ke langkah 4.4.

**Mengubah aplikasi di kemudian hari:** edit file di folder proyek (misalnya `config.js`), simpan, lalu klik dua kali `UPLOAD_KE_GITHUB.bat` lagi dan tekan **Enter** saat ditanya link. Perubahan terkirim dan APK baru dibuat otomatis.

Hal yang dilakukan file .bat ini, supaya kamu tahu:

| Tahap | Perintah | Arti |
|---|---|---|
| Cek Git | `where git`, `winget install Git.Git` | Memasang Git jika belum ada |
| Cek config | `findstr ISI_API_KEY` | Mengingatkan jika config.js belum diisi |
| Siapkan | `git init`, `git add`, `git commit` | Menjadikan folder sebagai repository dan mencatat semua file |
| Kirim | `git remote add`, `git push` | Mengirim file ke repository GitHub milikmu |

File `.gitignore` memastikan `kredensial.h`, folder `pribadi/`, file .bat, dan sampah build tidak ikut terupload. File .bat juga **membatalkan upload** jika menemukan password di file yang akan dikirim.

### 4.3b Upload lewat browser (cara B, jika cara A gagal atau tidak memakai Windows)
1. Di github.com klik **+** di kanan atas, pilih **New repository**. Nama `pakan-ikan-app`, pilih **Public**, jangan centang README, klik **Create repository**.
2. Di halaman repository yang masih kosong, klik link **uploading an existing file**.
3. Buka folder proyek di File Explorer. Seret folder `.github`, `aplikasi`, `docs`, `firebase`, `firmware` dan file `README.md`, `.gitignore`. **Jangan** seret folder `pribadi` dan jangan sertakan file `kredensial.h`.
4. Tunggu sampai semua file selesai terunggah, lalu klik **Commit changes**.

Cek hasilnya: di halaman utama repository harus terlihat `.github`, `aplikasi`, `docs`, `firebase`, `firmware`, `README.md`.
Jika folder `.github` **tidak** muncul, klik **Add file** lalu **Create new file**, ketik nama `.github/workflows/build-apk.yml`, tempel isi file `build-apk.yml` dari paket ini, lalu **Commit changes**.

### 4.4 Tunggu build selesai
1. Buka tab **Actions** di repository.
2. Akan ada proses bernama **Build APK Pakan Ikan** dengan ikon kuning berputar. Tunggu sekitar 3 sampai 6 menit.
3. Ikon berubah **hijau (✓)** artinya berhasil. Jika **merah (✗)**, klik prosesnya, lihat langkah yang gagal, dan lihat bagian Masalah Umum di bawah.
4. Tombol **sekali klik**: kapan pun ingin build ulang, buka **Actions**, pilih **Build APK Pakan Ikan**, klik **Run workflow** lalu **Run workflow**.

### 4.5 Unduh dan pasang APK
1. Di halaman utama repository, lihat panel kanan bagian **Releases**. Klik rilis paling atas (misalnya `Pakan Ikan build 1`).
2. Klik **PakanIkan.apk** untuk mengunduh.
   - Bisa langsung dari browser HP, karena repository publik.
3. Buka file APK di HP. Jika muncul peringatan "sumber tidak dikenal", izinkan **Install unknown apps** untuk aplikasi tersebut.
4. Jika Google Play Protect memberi peringatan, pilih **More details** lalu **Install anyway**. Ini normal untuk aplikasi buatan sendiri.
5. Buka aplikasi **Pakan Ikan**, login dengan **akun admin** (bukan akun ESP32). Biarkan **Ingat saya di perangkat ini** tercentang supaya tidak perlu login lagi.

### 4.6 Mengubah aplikasi di kemudian hari
Cara termudah: edit file di laptop lalu klik dua kali `UPLOAD_KE_GITHUB.bat`. Cara lain: ubah file langsung di GitHub (klik file, klik ikon pensil, edit, **Commit changes**). APK baru otomatis dibuat. Pasang APK baru langsung menimpa yang lama, data login tetap aman.

---

## LANGKAH 5. Uji coba

| Uji | Cara | Hasil yang benar |
|---|---|---|
| Koneksi | Buka aplikasi saat ESP32 menyala | Tanda **● Alat online** hijau, level dan jarak muncul |
| Beri pakan manual | Tekan **BERI PAKAN SEKARANG** | Dalam 1 sampai 2 detik servo bergerak, blower dan LED menyala 4 detik, riwayat bertambah "Aplikasi" |
| Tombol fisik | Tekan tombol di pin 23 | Pakan keluar, riwayat bertambah "Tombol fisik" |
| Jadwal | Atur Jadwal 1 ke 2 menit dari sekarang, aktifkan, klik **Simpan** | Serial Monitor menulis `Jadwal 1: HH:MM`, lalu pakan keluar tepat waktu |
| Offline | Cabut daya ESP32 | Setelah sekitar 20 detik aplikasi menampilkan **● Alat offline** |
| Laporan | Ubah sementara `INTERVAL_LAPORAN` menjadi `60UL * 1000UL` | Tiap 1 menit kartu Laporan Berkala berubah |

Kalibrasi level pakan tetap sama seperti dulu: ukur jarak saat wadah penuh dan kosong, lalu isi `JARAK_PENUH` dan `JARAK_KOSONG` di kode ESP32.

---

## LANGKAH 5b. Fitur Pengaturan di aplikasi

Buka tab **Pengaturan** di aplikasi. Bagian WiFi Alat dan Pengguna hanya muncul untuk admin.

### Ingat perangkat
Saat login ada pilihan **Ingat saya di perangkat ini**.
- Tercentang: tetap masuk walau aplikasi ditutup atau HP dinyalakan ulang. Email juga diingat.
- Tidak tercentang: otomatis keluar saat aplikasi ditutup. Cocok untuk HP pinjaman.
- Tombol **Keluar dari akun** membuat perangkat itu lupa login.

### Menambah pengguna (admin)
1. Isi **Nama**, **Email**, dan **Password** (minimal 6 karakter), tekan **Tambah pengguna**.
2. Berikan email dan password itu ke orangnya. Ia memasang APK yang sama dan login.
3. **Cabut akses**: tekan tombolnya dua kali. Orang itu langsung tidak bisa melihat data. Akun loginnya masih tercatat di Firebase Authentication. Jika ingin dihapus total, hapus di Firebase Console > Authentication > Users.
4. Setiap pengguna bisa **ganti password** sendiri di bagian Akun Saya.

### Mengganti WiFi alat dari aplikasi (admin, alat harus online)
1. Isi **Nama WiFi baru** dan **Password WiFi**, tekan **Kirim ke alat**.
2. Alat mencoba WiFi baru selama 20 detik. Hasilnya muncul di aplikasi: "Berhasil pindah ke ..." atau "Gagal tersambung ke ..., kembali ke ...".
3. WiFi tersimpan di memori ESP32, jadi tetap dipakai walau listrik mati.

### Mengatur WiFi lewat hotspot (alat offline atau pindah tempat)
1. Cabut daya ESP32. **Tahan tombol beri pakan**, colokkan daya, terus tahan 3 detik sampai **LED berkedip cepat**. Mode ini juga aktif sendiri jika alat tidak menemukan WiFi yang tersimpan saat menyala.
2. Di HP, sambungkan WiFi ke **PakanIkan-Setup** dengan password **12345678**. Jika muncul "tidak ada internet", pilih tetap tersambung.
3. Halaman setup biasanya terbuka sendiri. Jika tidak, matikan data seluler lalu buka `http://192.168.4.1` (ada tombolnya di aplikasi, tab Pengaturan).
4. Pilih WiFi dari daftar, isi password, tekan **Simpan dan sambungkan**. Alat restart dan tersambung.
5. Jika 5 menit tidak ada yang tersambung ke hotspot, alat restart sendiri dan mencoba WiFi lagi. Ini berguna jika router baru menyala lebih lambat dari alat setelah listrik padam.

---

## LANGKAH 6. Hal yang perlu diketahui

1. **Jadwal tetap jalan walau internet putus.** Jadwal disimpan di memori ESP32 setelah dibaca dari Firebase. Tetapi jika ESP32 dinyalakan ulang tanpa internet, jadwal dan jam belum didapat sampai internet tersambung lagi.
2. **Perintah dari aplikasi kedaluwarsa dalam 2 menit.** Ini supaya tombol yang ditekan saat alat mati tidak tiba-tiba dijalankan berjam-jam kemudian. Aplikasi juga menolak mengirim perintah saat alat offline.
3. **Laporan 2 jam belum berupa notifikasi HP.** Di Blynk, `logEvent` bisa memunculkan notifikasi. Di versi ini laporan tampil di aplikasi saat dibuka. Notifikasi push memerlukan Firebase Cloud Messaging (FCM) dan server tambahan, bisa jadi pengembangan berikutnya.
4. **Aplikasi butuh internet**, karena tampilan memuat SDK Firebase dari internet.
5. **Kuota gratis.** Firebase paket gratis (Spark) dan GitHub Actions untuk repository private (2.000 menit per bulan) jauh lebih dari cukup untuk proyek ini.
6. **Riwayat** terus bertambah di database. Jika ingin menghapus, buka Firebase Console, arahkan ke `pakanIkan > riwayat`, klik ikon tempat sampah.

---

## Masalah umum

| Gejala | Penyebab dan solusi |
|---|---|
| Arduino: `Firebase_ESP_Client.h: No such file` | Library Mobizt belum terpasang. Ulangi langkah 2 nomor 3. |
| Serial: `Token info ... error: INVALID_PASSWORD` atau `EMAIL_NOT_FOUND` | Email atau password akun ESP32 salah di kode. |
| Serial: `API key not valid` | `API_KEY` salah salin. Ambil ulang dari Project settings. |
| Serial: `permission denied` | Rules belum di-Publish, atau email di Rules tidak sama persis dengan email akun. |
| Serial: WiFi titik-titik terus | Nama atau password WiFi salah, atau hotspot memakai 5 GHz. ESP32 hanya bisa 2,4 GHz. |
| Serial: `Jadwal` tidak berjalan | Jam belum sinkron dari internet. Tunggu 1 menit setelah WiFi terhubung. |
| Aplikasi: "Tidak ada koneksi internet" | HP tidak ada internet saat aplikasi dibuka. Klik **Coba lagi**. |
| Aplikasi: "apiKey di config.js salah" atau login gagal terus | Isi `config.js` belum diganti atau salah salin. Edit di GitHub, tunggu build baru, pasang ulang. |
| Aplikasi: "Akses ditolak" | Email akun HP tidak tercantum di Rules (langkah 1.5). |
| Aplikasi: selalu "Alat offline" padahal Serial normal | `DATABASE_URL` di ESP32 dan `databaseURL` di config.js berbeda. Harus sama persis. |
| GitHub Actions merah di langkah **Build APK** | Klik langkah itu dan baca pesan error. Paling sering karena ada file yang tidak ikut terupload. Bandingkan daftar file dengan paket ini. |
| .bat: "Git selesai dipasang" tetapi saat dijalankan lagi tetap minta pasang Git | Restart laptop, lalu jalankan .bat lagi. |
| .bat: `Repository not found` | Link salah ketik, atau laptop login dengan akun GitHub lain. Jalankan .bat lagi, tempel link yang benar dari address bar, dan pilih **Y** saat ditawari login ulang. |
| .bat: jendela langsung tertutup | Klik kanan file .bat, pilih **Edit**, pastikan file tidak rusak. Atau pakai cara B. |
| GitHub: tab Actions kosong | Folder `.github` tidak ikut terupload. Lihat langkah 4.3b bagian bawah. |
| Aplikasi: "Akun ini belum diberi akses" | Akun belum ditambahkan admin, atau `EMAIL_ADMIN` di config.js tidak sama dengan email admin di Rules. |
| Aplikasi: tambah pengguna gagal "Pendaftaran akun dimatikan" | Centang lagi **Enable create (sign-up)** di Authentication > Settings > User actions. |
| Aplikasi: ganti WiFi "Alat gagal membaca pengaturan WiFi" | Rules belum versi baru (belum ada bagian `wifiAlat`). Pasang Rules dari halaman setup langkah 7C. |
| Hotspot PakanIkan-Setup tidak muncul | Tombol harus ditahan **sebelum** daya dicolokkan dan tetap ditahan 3 detik sampai LED berkedip cepat. |
| HP: "App not installed" | Hapus versi lama aplikasi lalu pasang lagi. |

---

## Lampiran: struktur data di Firebase

```
pakanIkan
├── status                     (ditulis ESP32 tiap 5 detik)
│   ├── statusPakan    "Siap memberi pakan"
│   ├── sedangMemberi  false
│   ├── jarak          12.4
│   ├── level          57
│   ├── terakhir       "07:00, 08/11"
│   ├── ip             "192.168.1.20"
│   └── update         1762600000000   (jam server, untuk cek online)
├── kontrol                    (ditulis aplikasi)
│   ├── beriPakan      false
│   ├── waktuPerintah  1762600000
│   ├── jadwal
│   │   ├── j1  { aktif: true, jam: 7,  menit: 0,  hari: 127 }
│   │   ├── j2  { aktif: true, jam: 17, menit: 30, hari: 31 }
│   │   └── j3  { aktif: false, ... }
│   └── wifiVersi      1762600000      (tanda ada WiFi baru dari aplikasi)
├── riwayat                    (satu catatan tiap pemberian pakan)
│   └── -Nxyz...  { sumber: "Aplikasi", waktu: 1762600000000 }
└── laporan                    (laporan terbaru tiap 2 jam)
    └── { pesan: "Pakan telah diberikan 2x ...", waktu: ... }

pengguna                       (diatur admin dari aplikasi)
└── <uid>  { nama: "Bapak", email: "bapak@gmail.com", dibuat: ... }

wifiAlat                       (hanya admin dan ESP32)
└── { ssid: "WiFi Rumah", pass: "...", versi: 1762600000 }
```

Nilai `hari` adalah gabungan bit: Senin = 1, Selasa = 2, Rabu = 4, Kamis = 8, Jumat = 16, Sabtu = 32, Minggu = 64. Contoh 127 artinya setiap hari, 31 artinya Senin sampai Jumat.
