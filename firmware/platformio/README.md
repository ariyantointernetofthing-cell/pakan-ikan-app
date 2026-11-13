# Pakan Ikan v3.8 (PlatformIO)

## Isi folder
| File | Fungsi |
|---|---|
| `platformio.ini` | Pengaturan board, partisi, dan library (diunduh otomatis) |
| `src/main.cpp` | Program ESP32 (sama dengan PakanIkanFirebase.ino v3.8) |
| `include/kredensial.contoh.h` | Contoh isian WiFi, akun Firebase, password OTA |

## Cara flash
1. Pasang **VS Code**, lalu di menu Extensions pasang **PlatformIO IDE**. Tunggu sampai selesai dan restart VS Code jika diminta.
2. **File > Open Folder**, pilih folder `firmware/platformio` ini (folder yang berisi `platformio.ini`).
   **Wajib sebelum upload:** salin `include/kredensial.contoh.h` menjadi `include/kredensial.h`, lalu isi WiFi, akun Firebase, dan password OTA.
3. Tunggu PlatformIO selesai menyiapkan proyek (pertama kali bisa 5 sampai 15 menit karena mengunduh toolchain ESP32 dan library).
4. Colok ESP32 lewat USB. **Cabut adaptor 12 V** dulu.
5. Klik ikon **panah ke kanan (Upload)** di bilah biru bawah, atau tekan `Ctrl+Alt+U`.
   Jika macet di "Connecting....", tahan tombol **BOOT** di ESP32 sampai upload berjalan.
6. Klik ikon **colokan (Serial Monitor)** di bilah bawah untuk melihat log (115200 baud).

## Update lewat WiFi (OTA)
Setelah alat pernah diflash lewat USB dengan proyek ini, update berikutnya bisa tanpa kabel:

**Dari laptop (PlatformIO):** laptop harus di WiFi yang sama dengan alat. Di bilah biru bawah, ganti environment ke
`env:esp32dev_ota`, lalu klik Upload. Jika gagal menemukan `pakan-ikan.local`, buka `platformio.ini` dan ganti
`upload_port` dengan IP alat (terlihat di aplikasi, Pengaturan > Update Firmware).

**Dari HP (aplikasi Pakan Ikan):**
1. Klik ikon **centang (Build)** di bilah bawah.
2. Ambil file `.pio/build/esp32dev/firmware.bin`, kirim ke HP.
   Pakai `firmware.bin`, bukan `bootloader.bin` atau `partitions.bin`.
3. Aplikasi > Pengaturan > Update Firmware lewat WiFi. Pilih file, isi password OTA, Kirim.
   HP harus di WiFi yang sama dengan alat (atau alat tersambung ke hotspot HP itu).

Password OTA = isi `OTA_PASSWORD` di `include/kredensial.h`. Tulis password yang sama di baris `--auth=` pada `platformio.ini`.

## Mengubah WiFi awal atau akun
Edit `include/kredensial.h`. File ini tidak ikut ke GitHub (ada di `.gitignore`).

## Catatan
* Versi ini memakai platform `espressif32` 6.x (Arduino core 2.0.x).
* Partisi `min_spiffs.csv` sama dengan pilihan Arduino IDE "Minimal SPIFFS (1.9MB APP with OTA)".
  Jika sebelumnya ESP32 diflash dengan skema lain, update OTA baru bisa jalan setelah satu kali flash lewat USB dengan proyek ini.
