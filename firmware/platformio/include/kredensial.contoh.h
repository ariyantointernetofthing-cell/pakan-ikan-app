// =====================================================================
//  kredensial.h  |  Pakan Ikan Otomatis
//  CONTOH. Salin file ini menjadi "kredensial.h" (satu folder), lalu isi.
//  kredensial.h tidak ikut diupload ke GitHub.
// =====================================================================
#pragma once

// WiFi bawaan (selalu dicoba, tidak bisa dihapus dari aplikasi).
// WiFi lain ditambah dari aplikasi dan disimpan di EEPROM.
#define WIFI_SSID      "NAMA_WIFI_UTAMA"
#define WIFI_PASSWORD  "PASSWORD_WIFI_UTAMA"
#define WIFI_SSID_2    ""                // bawaan kedua (kosongkan "" jika tidak dipakai)
#define WIFI_PASSWORD_2 ""

#define API_KEY        "ISI_WEB_API_KEY"
#define DATABASE_URL   "https://NAMA-PROYEK-default-rtdb.asia-southeast1.firebasedatabase.app"

#define USER_EMAIL     "esp32@pakanikan.id"
#define USER_PASSWORD  "ISI_PASSWORD_AKUN_ESP32"

// Password untuk update firmware lewat WiFi (OTA). Ganti sesukamu,
// lalu isi password yang sama di aplikasi saat update.
#define OTA_PASSWORD   "GANTI_PASSWORD_OTA"
#define OTA_HOSTNAME   "pakan-ikan"
