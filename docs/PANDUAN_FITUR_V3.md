# Pakan Ikan v3.9: Fitur Baru dan Cara Memasang

## Urutan pemasangan (wajib berurutan)

1. **Rules Firebase.** Realtime Database > tab Rules. Hapus semua, tempel isi `database.rules.json` versi v3.3, klik **Publish**. Versi ini menambah indeks waktu untuk grafik riwayat dan mengizinkan ESP32 menulis daftar WiFi.
2. **Firmware ESP32 (sekali lewat kabel USB).**
   - Buka `PakanIkanFirebase.ino` v3 di Arduino IDE.
   - **Tools > Partition Scheme > Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)**. Wajib supaya update lewat WiFi (OTA) bisa jalan.
   - Upload. Setelah ini, update berikutnya bisa lewat WiFi dari aplikasi, Arduino IDE, atau PlatformIO.
   - Bisa juga lewat PlatformIO: pakai folder `PakanIkan_PlatformIO`.
3. **Aplikasi.** Ekstrak `AplikasiPakanIkan_v3.zip`, klik dua kali `UPLOAD_KE_GITHUB.bat`, tekan Enter. Ambil APK baru di Releases, pasang menimpa yang lama.

Jadwal lama (Jadwal 1 sampai 3) tetap ada dan otomatis dipindah ke format baru saat admin membuka aplikasi.

## Fitur baru

| Fitur | Di mana | Keterangan |
|---|---|---|
| Jadwal tanpa batas | Beranda, tombol **+ Tambah jadwal** | Tambah, ubah, hapus (tekan Hapus dua kali). Alat menyimpan maksimal 30 jadwal. |
| Katup pakan | Pengaturan > Katup Pakan (admin) | Sudut buka, sudut tutup, kecepatan 1 sampai 10, lama terbuka 0,1 sampai 10 detik. Tombol **Tes beri pakan** untuk mencoba. Hanya servo katup yang terpengaruh. |
| Kalibrasi sensor | Pengaturan > Kalibrasi (admin) | Isi wadah penuh, tekan "Pakai jarak sekarang" di titik PENUH. Kosongkan wadah, tekan di titik HABIS. Simpan. |
| Penyimpanan di EEPROM | Otomatis | SEMUA pengaturan (daftar WiFi, jadwal, kalibrasi, katup, blower, servo pengarah, restart terjadwal) disimpan di EEPROM ESP32 dalam satu blok dengan tanda dan checksum. Tetap ada walau listrik mati atau internet putus. Data dari firmware lama dipindah otomatis saat pertama menyala. |
| Restart otomatis | Pengaturan > Restart Otomatis (admin) | Pilih jam dan hari. Ada juga tombol **Restart alat sekarang** (tekan dua kali). |
| Update firmware (OTA) | Pengaturan > Update Firmware (admin) | Dua cara: **lewat internet** lewat Firebase (v3.8, tidak perlu satu WiFi) atau **lewat WiFi yang sama** (mekanisme proyek kontrol pompa). Lihat bagian di bawah. |
| Riwayat pemberian pakan | Tab **Riwayat** | Grafik batang per jam (24 jam) atau per hari (7 dan 30 hari), plus daftar. |
| Riwayat isi wadah | Tab **Riwayat** | Grafik garis dan daftar. Alat mencatat tiap 10 menit. |
| Kekuatan jaringan | Kepala aplikasi (ikon batang) dan tab Riwayat | dBm sekarang dan grafik riwayat sinyal. |
| Daftar WiFi (tambah dan hapus) | Pengaturan > WiFi Alat (admin) | Maksimal 8 WiFi plus WiFi bawaan dari kode. Alat memilih WiFi tersimpan dengan sinyal terkuat. Menambah atau menghapus tidak membuat alat pindah jaringan. |
| Tampilan baru | Seluruh aplikasi | Tema laut dalam, jam dan tanggal lengkap (hari, tanggal, jam, detik, WIB), info sinyal, lama alat aktif, data terakhir, dan jadwal berikutnya. |
| Animasi ikan makan | Beranda, akuarium | Ikan berenang santai. Saat memberi pakan, pelet jatuh dan ikan naik mengunyah. Animasi ringan, hanya CSS. |
| Lama blower (relay) menyala | Pengaturan > Blower (admin) | 1 sampai 60 detik, dihitung sejak pakan mulai keluar. Blower tetap menyala sampai katup selesai menutup. |
| Jenis relay (v3.7, v3.9) | Pengaturan > Blower (Relay) (admin) | Pilih **Aktif HIGH**, **Aktif LOW**, atau **LOW modul 5V**, lalu tekan **Tes relay 3 detik**. Disimpan di EEPROM alat. Jika relay menyala terus di Aktif HIGH maupun Aktif LOW, pilih **LOW modul 5V** (open-drain): modul relay 5V aktif LOW sering tidak mau mati dengan sinyal 3,3V dari ESP32. |
| Servo pengarah | Pengaturan > Servo Pengarah Pakan (admin) | Batas kiri, batas kanan (0 sampai 180 derajat), dan kecepatan sapu 1 sampai 10. Jika batas kiri sama dengan kanan, pengarah diam. |
| Animasi menyambar | Beranda, akuarium | Ikan melesat dan menyambar pelet setiap kali pakan keluar, baik dari tombol aplikasi, jadwal, maupun tombol fisik di alat. |
| Ekspor CSV | Tab Riwayat > Ekspor CSV | Pilih data: semua informasi (satu file), riwayat pakan, riwayat isi wadah dan sinyal, jadwal, status dan pengaturan alat, atau pengguna (admin). Rentang 24 jam, 7 hari, 30 hari, atau semua. Disimpan lewat dialog Simpan Android. Pemisah titik koma dan desimal koma untuk Excel Indonesia. Password WiFi tidak ikut. |

Riwayat lebih tua dari 60 hari dihapus otomatis saat admin membuka aplikasi, supaya database tidak penuh.

## Daftar WiFi alat

* **Tambah WiFi:** Pengaturan > WiFi Alat > isi nama dan password > **+ Tambah WiFi**. Jika nama sudah ada, password-nya diperbarui.
* **Hapus WiFi:** tekan **Hapus** dua kali. Jika WiFi itu sedang dipakai, alat tetap tersambung sampai WiFi putus atau alat restart.
* Keterangan di tiap WiFi: **Tersimpan di alat** artinya alat sudah menerima daftar terbaru. **Menunggu alat online** artinya daftar dikirim saat alat online.
* WiFi bawaan (`WIFI_SSID` di kode) selalu dicoba dan tidak bisa dihapus dari aplikasi.
* Saat menyala, alat memindai WiFi sekitar dan memilih WiFi tersimpan dengan sinyal terkuat.
* **Saat WiFi yang dipakai putus**, sekitar 5 detik kemudian alat langsung memindai dan menyambung ke WiFi lain di daftar yang tersedia (yang sinyalnya terkuat). Jika belum ada yang tersedia, alat mencoba lagi tiap 20 detik. Total waktu pindah biasanya 10 sampai 25 detik.
* Pastikan WiFi kedua sudah berstatus **Tersimpan di alat** di aplikasi sebelum mencoba mematikan WiFi pertama. Jika masih "Menunggu alat online", alat belum menerima daftar terbaru.
* WiFi yang ditambah lewat hotspot **PakanIkan-Setup** juga masuk ke daftar ini secara otomatis setelah alat online.

## Update firmware lewat internet (v3.8)

Tidak perlu satu WiFi dengan alat. File `.bin` diunggah ke Firebase, lalu alat mengunduhnya sendiri.

1. **Sekali saja:** pasang Rules Firebase terbaru (ada bagian `otaFirmware`, hanya admin yang boleh mengunggah firmware). Realtime Database > Rules > tempel > **Publish**.
2. **Sekali saja:** alat harus sudah memakai firmware v3.8. Pasang v3.8 lewat kabel USB atau lewat cara WiFi yang sama di bawah. Firmware lama belum mengerti perintah update lewat internet.
3. Aplikasi: Pengaturan > Update Firmware > **Cara kirim: Lewat internet**.
4. Tekan **Pilih file .bin**, lalu **Kirim ke alat**. Aplikasi mengunggah file (sekitar 1,5 MB data, 10 sampai 60 detik tergantung sinyal HP).
5. Alat mulai mengunduh dalam beberapa detik, memasang firmware, lalu restart. Aplikasi menampilkan "Update berhasil" setelah alat online lagi. Total biasanya 1 sampai 3 menit.

Catatan:
- Jika alat sedang offline, update berjalan otomatis begitu alat online (perintah berlaku 24 jam).
- Jika unduhan gagal di tengah jalan, firmware lama tetap jalan. ESP32 juga menolak file yang rusak.
- Selama update, pemberian pakan dan perintah aplikasi berhenti sementara.
- Kuota gratis Firebase cukup: tiap update memakai sekitar 1,5 MB unggah dan 1,5 MB unduh.

## Update firmware lewat WiFi yang sama (cara lama)

Cara kerjanya sama dengan proyek kontrol pompa dan upload OTA Arduino IDE: aplikasi mengirim undangan UDP
ke IP alat (port 3232), menjawab tantangan password (password tidak dikirim polos), lalu alat menyambung balik
ke HP lewat TCP dan menerima file `.bin`. Aplikasi mendukung autentikasi ESP32 lama (MD5) dan baru (SHA-256).

1. **Buat file .bin di laptop.** Arduino IDE (partition scheme tetap Minimal SPIFFS): **Sketch > Export Compiled Binary**,
   lalu **Sketch > Show Sketch Folder**, folder `build`, ambil `PakanIkanFirebase.ino.bin`.
   PlatformIO: klik Build, ambil `.pio/build/esp32dev/firmware.bin`.
   Jangan pakai file yang namanya mengandung `merged`, `bootloader`, atau `partitions`.
2. Kirim file `.bin` itu ke HP (kabel USB, Google Drive, atau WhatsApp ke diri sendiri lalu unduh).
3. **HP harus di WiFi yang sama dengan alat.** Jika alat tersambung ke hotspot HP, cukup nyalakan hotspot di HP itu.
4. Aplikasi: Pengaturan > Update Firmware lewat WiFi.
   - Alamat IP alat terisi otomatis dari alat.
   - Tekan **Pilih file .bin**, pilih file.
   - Isi **password OTA** (sama dengan `OTA_PASSWORD` di `kredensial.h`). Aplikasi mengingatnya.
   - Tekan **Kirim ke alat**. Tunggu bilah progres sampai selesai (sekitar 20 sampai 60 detik).
5. Alat restart dengan firmware baru dan online lagi sekitar 30 detik kemudian. Versi firmware tampil di kartu Update Firmware.

Selama update, pemberian pakan dan Firebase di alat berhenti sementara. Jika gagal di tengah jalan, firmware lama tetap jalan.

**Dari laptop tanpa HP:** Arduino IDE, menu **Tools > Port**, pilih port jaringan `pakan-ikan` lalu Upload (isi password OTA saat diminta).
PlatformIO: pilih environment `esp32dev_ota` lalu Upload.

## Tombol fisik saat menyalakan alat

| Tahan tombol sambil colok daya | Tanda LED | Mode |
|---|---|---|
| 3 detik lalu lepas | berkedip cepat | Hotspot setup WiFi (PakanIkan-Setup) |

## Versi Wokwi

`sketch.ino` versi Wokwi sudah memakai `#define MODE_WOKWI`: tanpa OTA dan tanpa hotspot, laporan dan catatan isi wadah tiap 1 menit supaya grafik cepat terisi. `diagram.json` dan `libraries.txt` tidak berubah.

## Masalah umum v3

| Gejala | Solusi |
|---|---|
| Arduino: `Sketch too big` | Partition Scheme belum Minimal SPIFFS (1.9MB APP with OTA). |
| Update: "Alat tidak menjawab" | HP dan alat tidak di WiFi yang sama, atau IP salah. Cek IP di kartu Update Firmware. Jika HP pakai data seluler sambil terhubung WiFi tanpa internet, Android kadang memutus WiFi: matikan data seluler sementara. |
| Update: "Password OTA salah" | Isi password yang sama dengan `OTA_PASSWORD` di kode ESP32. |
| Update: "Alat tidak menyambung balik ke HP" | Beberapa jaringan (WiFi kampus atau kantor) memblokir sambungan antar perangkat. Pakai hotspot HP untuk alat. |
| Update: "bukan firmware ESP32" | File salah. Pakai `PakanIkanFirebase.ino.bin` atau `firmware.bin`, bukan `merged`, `bootloader`, atau `partitions`. |
| Update: "Alat tidak mengonfirmasi" | Firmware di alat diflash dengan partition scheme lain. Flash sekali lewat USB dengan Minimal SPIFFS. |
| Grafik riwayat kosong terus | Rules v3 belum di-Publish (perlu `.indexOn`), atau firmware alat masih v2. |
| Level selalu 0% atau 100% | Kalibrasi terbalik atau belum diatur. Titik HABIS harus angka lebih besar dari titik PENUH. |


## Riwayat saat alat offline (v3.6)

- Setiap pemberian pakan (jadwal, tombol, aplikasi) langsung dicatat ke memori flash alat, walau WiFi putus.
- Saat offline, isi wadah juga dicatat tiap 1 jam.
- Saat alat online kembali, catatan dikirim satu per satu dengan jam aslinya. Grafik dan daftar di aplikasi jadi tetap lengkap.
- Di daftar riwayat, catatan itu diberi keterangan **"tercatat saat offline"**. Di CSV ada kolom **Tercatat saat offline**.
- Kapasitas: 60 pemberian pakan dan 120 catatan isi wadah. Jika penuh, yang tertua dibuang.
- Jika listrik padam lalu alat menyala tanpa internet, jam belum diketahui. Pemberian pakan dari tombol tetap dicatat dan diberi jam server saat terkirim.
