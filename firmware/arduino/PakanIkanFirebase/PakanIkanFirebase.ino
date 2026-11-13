/*
  =====================================================================
   PAKAN IKAN OTOMATIS  |  ESP32 + Firebase Realtime Database  (v3)
  =====================================================================
   Fitur:
   - Beri pakan dari aplikasi, tombol fisik, dan jadwal (jumlah bebas)
   - Katup pakan: sudut buka, sudut tutup, kecepatan, lama buka diatur dari aplikasi
   - Blower (relay): lama menyala dan jenis relay (aktif HIGH / aktif LOW) diatur dari aplikasi
   - Servo pengarah: sudut batas kiri, kanan, dan kecepatan sapu diatur dari aplikasi
   - Kalibrasi sensor (titik penuh dan titik habis) dari aplikasi
   - SEMUA pengaturan tersimpan di EEPROM: daftar WiFi, jadwal, kalibrasi,
     katup, restart terjadwal (tetap ada walau listrik mati atau internet putus)
   - Reboot otomatis terjadwal dan reboot dari aplikasi
   - Riwayat pemberian pakan dan riwayat isi wadah (untuk grafik di aplikasi)
   - Kekuatan sinyal WiFi dilaporkan ke aplikasi
   - WiFi bisa diganti dari aplikasi, atau lewat hotspot "PakanIkan-Setup"
   - Update firmware lewat WiFi (OTA) dari aplikasi, Arduino IDE, atau PlatformIO

   Library (Library Manager Arduino IDE):
     1. "ESP32Servo" (Kevin Harrington)
     2. "Firebase Arduino Client Library for ESP8266 and ESP32" (Mobizt)
   EEPROM, WebServer, DNSServer, ArduinoOTA sudah bawaan board ESP32.

   PENTING untuk Arduino IDE:
     Tools > Board            : ESP32 Dev Module
     Tools > Partition Scheme : Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)
     (Skema ini wajib supaya update lewat WiFi (OTA) bisa jalan.)

   Tombol fisik saat menyalakan ESP32 (tahan tombol, lalu colok daya):
     tahan 3 detik  -> LED berkedip cepat -> mode hotspot setup WiFi

   Update firmware lewat WiFi (OTA):
     HP dan alat harus di jaringan WiFi yang sama (misalnya alat tersambung ke hotspot HP).
     Dari aplikasi: Pengaturan > Update Firmware, pilih file .bin, isi password OTA, Kirim.
     Dari Arduino IDE / PlatformIO: pilih port jaringan "pakan-ikan" lalu Upload.
  =====================================================================
*/

#include <WiFi.h>
#include <EEPROM.h>
#include <Preferences.h>   // hanya untuk memindahkan data lama (v3.3 ke bawah) ke EEPROM
#include <WebServer.h>
#include <DNSServer.h>
#include <ArduinoOTA.h>
#include <Update.h>
#include <ESP32Servo.h>
#include <time.h>
#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"


#define FIRMWARE_VERSI "3.9"

// =====================================================================
//  PASSWORD DAN AKUN ada di file terpisah: kredensial.h
//  File itu TIDAK ikut diupload ke GitHub (lihat .gitignore).
//  Belum punya? Salin "kredensial.contoh.h" menjadi "kredensial.h", lalu isi.
// =====================================================================
#if __has_include("kredensial.h")
#include "kredensial.h"
#else
#error "File kredensial.h belum ada. Salin kredensial.contoh.h menjadi kredensial.h lalu isi WiFi dan akun Firebase."
#endif

// ===== Hotspot setup =====
#define AP_SSID   "PakanIkan-Setup"
#define AP_PASS   "12345678"
const unsigned long BATAS_MODE_SETUP = 5UL * 60UL * 1000UL;

// ===== Pin =====
#define TRIG_PIN    5
#define ECHO_PIN    18
#define SERVO_PIN   19   // servo katup pakan
#define ARAH_PIN    4    // servo pengarah ujung pipa
#define BLOWER_PIN  25
#define LED_PIN     26
#define BUZZER_PIN  27
#define BUTTON_PIN  23

// ===== Alamat data di Firebase =====
#define PATH_STATUS    "/pakanIkan/status"
#define PATH_KONTROL   "/pakanIkan/kontrol"
#define PATH_PERINTAH  "/pakanIkan/kontrol/beriPakan"
#define PATH_RIWAYAT   "/pakanIkan/riwayat"
#define PATH_RIW_LEVEL "/pakanIkan/riwayatLevel"
#define PATH_LAPORAN   "/pakanIkan/laporan"
#define PATH_WIFI      "/wifiAlat"
#define PATH_OTA_FILE  "/otaFirmware/file"      // file .bin (base64) yang diunggah admin dari aplikasi
#define PATH_OTA_STATUS "/pakanIkan/otaStatus"  // kabar proses update lewat Firebase untuk aplikasi
#define BATAS_UMUR_OTA_FB 86400L                // perintah update lewat Firebase berlaku 24 jam

const long BATAS_UMUR_PERINTAH = 120; // detik

#ifdef MODE_WOKWI
const unsigned long INTERVAL_LAPORAN   = 60UL * 1000UL;       // Wokwi: tiap 1 menit
const unsigned long INTERVAL_LOG_LEVEL = 60UL * 1000UL;
const unsigned long INTERVAL_LOG_OFFLINE = 2UL * 60UL * 1000UL;      // Wokwi: tiap 2 menit
#else
const unsigned long INTERVAL_LAPORAN   = 2UL * 60UL * 60UL * 1000UL; // 2 jam
const unsigned long INTERVAL_LOG_LEVEL = 10UL * 60UL * 1000UL;       // 10 menit
const unsigned long INTERVAL_LOG_OFFLINE = 60UL * 60UL * 1000UL;     // saat offline: tiap 1 jam
#endif

Servo servoPakan;
Servo servoArah;
WebServer server(80);
DNSServer dns;

// ===== Firebase =====
FirebaseData fbdo;
FirebaseData fbStream;
FirebaseAuth auth;
FirebaseConfig config;
bool firebaseDimulai = false;

volatile bool adaPerubahanKontrol = false;
bool streamDimulai = false;
bool kontrolPertamaDibaca = false;
unsigned long waktuBacaKontrol = 0;

bool perluKirimStatus = false;
char sumberRiwayat[20] = "";
bool perluKirimLaporan = false;
bool perluLogLevel = false;
String pesanLaporan;

// ===== Pengaturan (tersimpan di EEPROM) =====
// Versi lama (EEPROM format 1, firmware v3.4.x) untuk konversi otomatis
struct PengaturanV1 {
  int penuhMm, kosongMm, sudutBuka, sudutTutup, kecepatan, durasiBukaMs;
  bool rbAktif;
  int rbJam, rbMenit, rbHari;
};

struct Pengaturan {
  int penuhMm = 30;        // jarak sensor saat wadah penuh (mm)
  int kosongMm = 250;      // jarak sensor saat wadah habis (mm)
  int sudutBuka = 90;      // sudut katup saat terbuka
  int sudutTutup = 0;      // sudut katup saat tertutup
  int kecepatan = 10;      // 1 = paling pelan, 10 = langsung
  int durasiBukaMs = 1000; // lama katup terbuka
  bool rbAktif = false;    // reboot terjadwal
  int rbJam = 3;
  int rbMenit = 0;
  int rbHari = 0x7F;
  int durasiBlowerMs = 4000; // lama relay/blower menyala (minimal, tetap menyala sampai katup menutup)
  int arahMin = 45;          // batas sudut servo pengarah (kiri)
  int arahMax = 135;         // batas sudut servo pengarah (kanan)
  int arahKecepatan = 7;     // 1 = sapu pelan, 10 = sapu cepat
  int relayAktifRendah = 0;  // jenis relay: 0 = aktif HIGH, 1 = aktif LOW, 2 = aktif LOW open-drain (modul 5V)
} atur;

// Versi lama (EEPROM format 2, firmware v3.5 sampai v3.6) untuk konversi otomatis
struct PengaturanV2 {
  int penuhMm, kosongMm, sudutBuka, sudutTutup, kecepatan, durasiBukaMs;
  bool rbAktif;
  int rbJam, rbMenit, rbHari;
  int durasiBlowerMs, arahMin, arahMax, arahKecepatan;
};

// ===== Jadwal (jumlah bebas, dibatasi memori) =====
#define MAKS_JADWAL 30
struct Jadwal {
  bool aktif;
  int jam;
  int menit;
  byte hari;          // bit 0 = Senin ... bit 6 = Minggu
  int kunciTerakhir;
};
Jadwal jadwal[MAKS_JADWAL];
int jumlahJadwal = 0;
String jadwalRingkas = "";   // format: aktif,jam,menit,hari;aktif,jam,menit,hari;...

// ===== Daftar WiFi (tersimpan di NVS) =====
#define MAKS_WIFI 8
String wifiSsid[MAKS_WIFI];
String wifiPass[MAKS_WIFI];
int    jumlahWifi = 0;
long   wifiVersi = 0;
String wifiPesan = "";
bool   perluSinkronWifi = false;
long   versiWifiBaru = 0;
String unggahSsid = "";          // WiFi yang ditambah lewat hotspot, dikirim ke Firebase saat online
String unggahPass = "";
unsigned long tWifiPutus = 0;    // kapan WiFi mulai terputus (0 = tersambung)
unsigned long tCobaWifi = 0;     // kapan terakhir mencoba menyambung ulang

bool modeSetup = false;
unsigned long waktuMulaiSetup = 0;
String daftarWifiHtml;

// ===== Update firmware lewat WiFi (OTA) =====
bool otaSiap = false;
bool otaBerjalan = false;
int  otaPersenTerakhir = -1;

// ===== Perintah reboot =====
bool perluReboot = false;
long rebootVersiTerakhir = 0;
long tesRelayTerakhir = 0;
long otaFbIdTerakhir = 0;      // perintah update lewat Firebase terakhir yang sudah diproses (disimpan di flash)
long otaFbIdBaru = 0;
bool perluOtaFirebase = false;
int  otaFbPersen = -1;
bool tesRelayAktif = false;
unsigned long tesRelaySampai = 0;

// ===== Status pemberian pakan =====
bool sedangMemberiPakan = false;
bool tombolSebelumnya = HIGH;
unsigned long waktuMulai = 0;
unsigned long waktuSapuTerakhir = 0;
const unsigned long TIUP_SETELAH_TUTUP = 1000; // blower tetap menyala sebentar setelah katup menutup

enum FaseKatup { KATUP_DIAM, KATUP_BUKA, KATUP_TAHAN, KATUP_TUTUP };
FaseKatup faseKatup = KATUP_DIAM;
int sudutKatup = 0;
unsigned long tLangkahKatup = 0;
unsigned long tFaseKatup = 0;
unsigned long tKatupSelesai = 0;

// ===== Pengarah ujung pipa =====
// Batas dan kecepatan diatur dari aplikasi (atur.arahMin, atur.arahMax, atur.arahKecepatan)
int sudutArah = 90;
int arahSapu = 1;

// ===== Sensor =====
const bool  ALARM_PAKAN_HABIS = false;
const int   BATAS_ALARM_PERSEN = 15;
float jarakTerakhir = -1;
float levelPakan = -1;

const long ZONA_WAKTU = 7 * 3600;

int jumlahPemberian = 0;
char pemberianTerakhir[24] = "-";

unsigned long tSensor = 0, tTombol = 0, tStatus = 0, tJadwal = 0, tLaporan = 0, tKedip = 0, tLogLevel = 0;
unsigned long tLogOffline = 0, tKirimAntrian = 0;

// =====================================================================
//  ANTRIAN RIWAYAT OFFLINE
//  Riwayat yang belum terkirim disimpan di memori flash (NVS, tempat yang
//  sama dengan EEPROM) supaya tidak hilang walau listrik padam. Begitu alat
//  online, antrian dikirim satu per satu dengan jam aslinya.
// =====================================================================
#define MAKS_ANTRIAN_PAKAN 60     // +/- 2 minggu jika 4x sehari
#define MAKS_ANTRIAN_LEVEL 120    // 5 hari jika dicatat tiap jam
struct EntriPakan { uint32_t waktu; int8_t level; char sumber[19]; };            // 24 byte
struct EntriLevel { uint32_t waktu; int8_t level; uint8_t cadangan; uint16_t jarak10; }; // 8 byte
struct AntrianPakan { uint16_t awal, jumlah; EntriPakan isi[MAKS_ANTRIAN_PAKAN]; };
struct AntrianLevel { uint16_t awal, jumlah; EntriLevel isi[MAKS_ANTRIAN_LEVEL]; };
AntrianPakan antrianPakan;
AntrianLevel antrianLevel;
bool antrianPakanBerubah = false, antrianLevelBerubah = false;
Preferences prefAntrian;

// ---- Struktur data EEPROM ----
// Harus di atas semua fungsi: Arduino IDE membuat prototipe fungsi otomatis
// di atas fungsi pertama, jadi tipe yang dipakai fungsi harus sudah dikenal.
#define EEPROM_UKURAN  2048
#define EEPROM_TANDA   0x50494B34UL   // "PIK4"
#define EEPROM_FORMAT  3

struct WifiEeprom { char ssid[33]; char pass[65]; };
struct JadwalEeprom { uint8_t aktif, jam, menit, hari; };
struct DataEeprom {
  uint32_t tanda;
  uint16_t format;
  Pengaturan atur;
  int32_t rebootVersi;
  int32_t wifiVersi;
  uint8_t jumlahWifi;
  WifiEeprom wifi[MAKS_WIFI];
  WifiEeprom unggah;               // WiFi dari hotspot yang belum masuk ke daftar aplikasi
  uint8_t jumlahJadwal;
  JadwalEeprom jadwal[MAKS_JADWAL];
  uint32_t ceksum;
};
static_assert(sizeof(DataEeprom) <= EEPROM_UKURAN, "DataEeprom terlalu besar");

// Tata letak EEPROM format 2 (firmware v3.5 sampai v3.6), hanya untuk dibaca lalu dikonversi
struct DataEepromV2 {
  uint32_t tanda;
  uint16_t format;
  PengaturanV2 atur;
  int32_t rebootVersi;
  int32_t wifiVersi;
  uint8_t jumlahWifi;
  WifiEeprom wifi[MAKS_WIFI];
  WifiEeprom unggah;
  uint8_t jumlahJadwal;
  JadwalEeprom jadwal[MAKS_JADWAL];
  uint32_t ceksum;
};

// Tata letak EEPROM format 1 (firmware v3.4.x), hanya untuk dibaca lalu dikonversi
struct DataEepromV1 {
  uint32_t tanda;
  uint16_t format;
  PengaturanV1 atur;
  int32_t rebootVersi;
  int32_t wifiVersi;
  uint8_t jumlahWifi;
  WifiEeprom wifi[MAKS_WIFI];
  WifiEeprom unggah;
  uint8_t jumlahJadwal;
  JadwalEeprom jadwal[MAKS_JADWAL];
  uint32_t ceksum;
};
DataEeprom ee;

// Deklarasi awal (fungsinya ada di bawah)
void berhentiPakan();
void tambahAntrianPakan(const char *sumber);
bool wifiBawaan(const String &ssid);
String teksWifiBawaan();

// Nyalakan / matikan relay blower sesuai jenis relay (aktif HIGH atau aktif LOW)
// Mode 2 (open-drain): pin hanya menarik ke GND saat menyala, saat mati pin dilepas
// sehingga modul relay 5V menarik IN-nya sendiri ke 5V. Untuk modul aktif LOW 5V
// yang tidak mau mati dengan sinyal HIGH 3,3V dari ESP32.
const char *namaJenisRelay() {
  return atur.relayAktifRendah == 2 ? "LOW open-drain" : (atur.relayAktifRendah ? "LOW" : "HIGH");
}

void aturPinRelay() {
  pinMode(BLOWER_PIN, atur.relayAktifRendah == 2 ? OUTPUT_OPEN_DRAIN : OUTPUT);
}

void relayBlower(bool nyala) {
  bool tingkat = atur.relayAktifRendah ? !nyala : nyala;
  digitalWrite(BLOWER_PIN, tingkat ? HIGH : LOW);
}

bool sudahWaktunya(unsigned long &penanda, unsigned long interval) {
  if (millis() - penanda >= interval) {
    penanda = millis();
    return true;
  }
  return false;
}

// =====================================================================
//  PENYIMPANAN DI MEMORI ESP32 (NVS, pengganti EEPROM)
// =====================================================================
void parseJadwal(const String &teks) {
  jumlahJadwal = 0;
  int awal = 0;
  while (awal < (int)teks.length() && jumlahJadwal < MAKS_JADWAL) {
    int akhir = teks.indexOf(';', awal);
    if (akhir < 0) akhir = teks.length();
    String bagian = teks.substring(awal, akhir);
    awal = akhir + 1;

    int a, j, m, h;
    if (sscanf(bagian.c_str(), "%d,%d,%d,%d", &a, &j, &m, &h) == 4) {
      if (j < 0 || j > 23 || m < 0 || m > 59) continue;
      jadwal[jumlahJadwal].aktif = a != 0;
      jadwal[jumlahJadwal].jam = j;
      jadwal[jumlahJadwal].menit = m;
      jadwal[jumlahJadwal].hari = (h & 0x7F) ? (h & 0x7F) : 0x7F;
      jadwal[jumlahJadwal].kunciTerakhir = -1;
      jumlahJadwal++;
    }
  }
}

// =====================================================================
//  EEPROM: satu blok data berisi SEMUA pengaturan
//  Alamat 0, ukuran sekitar 1,2 KB. Ada tanda dan checksum supaya data rusak
//  atau EEPROM kosong (alat baru) terdeteksi dan diganti nilai bawaan.
// =====================================================================
// (struktur data EEPROM ada di bagian atas, sebelum fungsi pertama)

// FNV-1a atas semua byte sebelum kolom ceksum
uint32_t fnv1a(const void *data, size_t panjang) {
  const uint8_t *b = (const uint8_t *)data;
  uint32_t h = 2166136261UL;
  for (size_t i = 0; i < panjang; i++) { h ^= b[i]; h *= 16777619UL; }
  return h;
}
uint32_t hitungCeksum(const DataEeprom &d) { return fnv1a(&d, offsetof(DataEeprom, ceksum)); }
uint32_t hitungCeksumV1(const DataEepromV1 &d) { return fnv1a(&d, offsetof(DataEepromV1, ceksum)); }
uint32_t hitungCeksumV2(const DataEepromV2 &d) { return fnv1a(&d, offsetof(DataEepromV2, ceksum)); }

void salinTeks(char *tujuan, size_t ukuran, const String &asal) {
  strncpy(tujuan, asal.c_str(), ukuran - 1);
  tujuan[ukuran - 1] = '\0';
}

String buatRingkasJadwal() {
  String t;
  for (int i = 0; i < jumlahJadwal; i++) {
    if (i) t += ";";
    t += String(jadwal[i].aktif ? 1 : 0) + "," + String(jadwal[i].jam) + "," + String(jadwal[i].menit) + "," + String(jadwal[i].hari);
  }
  return t;
}

void simpanSemua() {
  memset((void *)&ee, 0, sizeof(ee));
  ee.tanda = EEPROM_TANDA;
  ee.format = EEPROM_FORMAT;
  ee.atur = atur;
  ee.rebootVersi = rebootVersiTerakhir;
  ee.wifiVersi = wifiVersi;
  ee.jumlahWifi = jumlahWifi;
  for (int i = 0; i < jumlahWifi; i++) {
    salinTeks(ee.wifi[i].ssid, sizeof(ee.wifi[i].ssid), wifiSsid[i]);
    salinTeks(ee.wifi[i].pass, sizeof(ee.wifi[i].pass), wifiPass[i]);
  }
  salinTeks(ee.unggah.ssid, sizeof(ee.unggah.ssid), unggahSsid);
  salinTeks(ee.unggah.pass, sizeof(ee.unggah.pass), unggahPass);
  ee.jumlahJadwal = jumlahJadwal;
  for (int i = 0; i < jumlahJadwal; i++) {
    ee.jadwal[i].aktif = jadwal[i].aktif ? 1 : 0;
    ee.jadwal[i].jam = jadwal[i].jam;
    ee.jadwal[i].menit = jadwal[i].menit;
    ee.jadwal[i].hari = jadwal[i].hari;
  }
  ee.ceksum = hitungCeksum(ee);
  EEPROM.put(0, ee);
  if (EEPROM.commit()) Serial.println("EEPROM: semua pengaturan tersimpan");
  else Serial.println("EEPROM: GAGAL menyimpan");
}

// Data lama dari Preferences (firmware v3.3 ke bawah), dipindahkan sekali ke EEPROM
void muatDataLama() {
  Preferences pref;
  pref.begin("pakan", true);
  atur.penuhMm      = pref.getInt("penuh", atur.penuhMm);
  atur.kosongMm     = pref.getInt("kosong", atur.kosongMm);
  atur.sudutBuka    = pref.getInt("sBuka", atur.sudutBuka);
  atur.sudutTutup   = pref.getInt("sTutup", atur.sudutTutup);
  atur.kecepatan    = pref.getInt("cepat", atur.kecepatan);
  atur.durasiBukaMs = pref.getInt("durBuka", atur.durasiBukaMs);
  atur.rbAktif      = pref.getBool("rbAktif", atur.rbAktif);
  atur.rbJam        = pref.getInt("rbJam", atur.rbJam);
  atur.rbMenit      = pref.getInt("rbMenit", atur.rbMenit);
  atur.rbHari       = pref.getInt("rbHari", atur.rbHari);
  parseJadwal(pref.getString("jadwal", ""));
  rebootVersiTerakhir = pref.getLong("rbVersi", 0);
  pref.end();

  pref.begin("wifi", true);
  int n = pref.getInt("n", -1);
  jumlahWifi = 0;
  if (n < 0) {
    String lama = pref.getString("ssid", "");
    if (lama.length() && lama != WIFI_SSID) { wifiSsid[0] = lama; wifiPass[0] = pref.getString("pass", ""); jumlahWifi = 1; }
  } else {
    for (int i = 0; i < n && i < MAKS_WIFI; i++) {
      String ss = pref.getString(("s" + String(i)).c_str(), "");
      if (ss.length() == 0) continue;
      wifiSsid[jumlahWifi] = ss;
      wifiPass[jumlahWifi] = pref.getString(("p" + String(i)).c_str(), "");
      jumlahWifi++;
    }
  }
  wifiVersi  = pref.getLong("versi", 0);
  unggahSsid = pref.getString("uS", "");
  unggahPass = pref.getString("uP", "");
  pref.end();
}

void muatSemua() {
  EEPROM.begin(EEPROM_UKURAN);
  EEPROM.get(0, ee);
  bool sah = ee.tanda == EEPROM_TANDA && ee.format == EEPROM_FORMAT && ee.ceksum == hitungCeksum(ee) &&
             ee.jumlahWifi <= MAKS_WIFI && ee.jumlahJadwal <= MAKS_JADWAL;

  // EEPROM format 2 (v3.5 sampai v3.6): ubah ke format 3, jenis relay diberi nilai bawaan (aktif HIGH)
  if (!sah && ee.tanda == EEPROM_TANDA && ee.format == 2) {
    static DataEepromV2 v2;
    EEPROM.get(0, v2);
    if (v2.ceksum == hitungCeksumV2(v2) && v2.jumlahWifi <= MAKS_WIFI && v2.jumlahJadwal <= MAKS_JADWAL) {
      Serial.println("EEPROM format 2 ditemukan, dikonversi ke format 3...");
      Pengaturan baru;
      baru.penuhMm = v2.atur.penuhMm;               baru.kosongMm = v2.atur.kosongMm;
      baru.sudutBuka = v2.atur.sudutBuka;           baru.sudutTutup = v2.atur.sudutTutup;
      baru.kecepatan = v2.atur.kecepatan;           baru.durasiBukaMs = v2.atur.durasiBukaMs;
      baru.rbAktif = v2.atur.rbAktif;               baru.rbJam = v2.atur.rbJam;
      baru.rbMenit = v2.atur.rbMenit;               baru.rbHari = v2.atur.rbHari;
      baru.durasiBlowerMs = v2.atur.durasiBlowerMs; baru.arahMin = v2.atur.arahMin;
      baru.arahMax = v2.atur.arahMax;               baru.arahKecepatan = v2.atur.arahKecepatan;
      memset((void *)&ee, 0, sizeof(ee));
      ee.tanda = EEPROM_TANDA;
      ee.format = EEPROM_FORMAT;
      ee.atur = baru;
      ee.rebootVersi = v2.rebootVersi;
      ee.wifiVersi = v2.wifiVersi;
      ee.jumlahWifi = v2.jumlahWifi;
      memcpy(ee.wifi, v2.wifi, sizeof(ee.wifi));
      ee.unggah = v2.unggah;
      ee.jumlahJadwal = v2.jumlahJadwal;
      memcpy(ee.jadwal, v2.jadwal, sizeof(ee.jadwal));
      ee.ceksum = hitungCeksum(ee);
      sah = true;
      EEPROM.put(0, ee);
      EEPROM.commit();
    }
  }

  // EEPROM format 1 (v3.4.x): ubah ke format terbaru, pengaturan baru diberi nilai bawaan
  if (!sah && ee.tanda == EEPROM_TANDA && ee.format == 1) {
    static DataEepromV1 v1;
    EEPROM.get(0, v1);
    if (v1.ceksum == hitungCeksumV1(v1) && v1.jumlahWifi <= MAKS_WIFI && v1.jumlahJadwal <= MAKS_JADWAL) {
      Serial.println("EEPROM format 1 ditemukan, dikonversi ke format terbaru...");
      Pengaturan baru;   // nilai bawaan untuk pengaturan baru
      baru.penuhMm = v1.atur.penuhMm;       baru.kosongMm = v1.atur.kosongMm;
      baru.sudutBuka = v1.atur.sudutBuka;   baru.sudutTutup = v1.atur.sudutTutup;
      baru.kecepatan = v1.atur.kecepatan;   baru.durasiBukaMs = v1.atur.durasiBukaMs;
      baru.rbAktif = v1.atur.rbAktif;       baru.rbJam = v1.atur.rbJam;
      baru.rbMenit = v1.atur.rbMenit;       baru.rbHari = v1.atur.rbHari;
      memset((void *)&ee, 0, sizeof(ee));
      ee.tanda = EEPROM_TANDA;
      ee.format = EEPROM_FORMAT;
      ee.atur = baru;
      ee.rebootVersi = v1.rebootVersi;
      ee.wifiVersi = v1.wifiVersi;
      ee.jumlahWifi = v1.jumlahWifi;
      memcpy(ee.wifi, v1.wifi, sizeof(ee.wifi));
      ee.unggah = v1.unggah;
      ee.jumlahJadwal = v1.jumlahJadwal;
      memcpy(ee.jadwal, v1.jadwal, sizeof(ee.jadwal));
      ee.ceksum = hitungCeksum(ee);
      sah = true;
      EEPROM.put(0, ee);
      EEPROM.commit();
    }
  }

  if (!sah) {
    Serial.println("EEPROM kosong atau versi lama: memindahkan data lama ke EEPROM...");
    muatDataLama();
    simpanSemua();
  } else {
    atur = ee.atur;
    rebootVersiTerakhir = ee.rebootVersi;
    wifiVersi = ee.wifiVersi;
    jumlahWifi = ee.jumlahWifi;
    for (int i = 0; i < MAKS_WIFI; i++) {
      ee.wifi[i].ssid[32] = '\0';
      ee.wifi[i].pass[64] = '\0';
      wifiSsid[i] = i < jumlahWifi ? String(ee.wifi[i].ssid) : String("");
      wifiPass[i] = i < jumlahWifi ? String(ee.wifi[i].pass) : String("");
    }
    ee.unggah.ssid[32] = '\0';
    ee.unggah.pass[64] = '\0';
    unggahSsid = ee.unggah.ssid;
    unggahPass = ee.unggah.pass;
    jumlahJadwal = ee.jumlahJadwal;
    for (int i = 0; i < jumlahJadwal; i++) {
      jadwal[i].aktif = ee.jadwal[i].aktif != 0;
      jadwal[i].jam = constrain((int)ee.jadwal[i].jam, 0, 23);
      jadwal[i].menit = constrain((int)ee.jadwal[i].menit, 0, 59);
      jadwal[i].hari = ee.jadwal[i].hari ? ee.jadwal[i].hari : 0x7F;
      jadwal[i].kunciTerakhir = -1;
    }
  }
  jadwalRingkas = buatRingkasJadwal();

  Serial.printf("EEPROM dimuat: %d jadwal, penuh %d mm, habis %d mm, katup %d-%d derajat\n",
                jumlahJadwal, atur.penuhMm, atur.kosongMm, atur.sudutTutup, atur.sudutBuka);
  Serial.printf("  blower %d ms, relay aktif %s, pengarah %d-%d derajat kecepatan %d\n",
                atur.durasiBlowerMs, namaJenisRelay(), atur.arahMin, atur.arahMax, atur.arahKecepatan);
  Serial.printf("WiFi tersimpan (%d + bawaan):\n", jumlahWifi);
  for (int i = 0; i < jumlahWifi; i++) Serial.printf("  %d. %s\n", i + 1, wifiSsid[i].c_str());
  Serial.printf("  bawaan: %s\n", teksWifiBawaan().c_str());
}

// Nama lama dipertahankan supaya pemanggil lain tidak berubah
void simpanPengaturan() { simpanSemua(); }
void simpanDaftarWifi() { simpanSemua(); }
void simpanRebootVersi(long v) { rebootVersiTerakhir = v; simpanSemua(); }

bool wifiBawaan(const String &ssid) {
  return ssid == WIFI_SSID || (String(WIFI_SSID_2).length() && ssid == WIFI_SSID_2);
}

String teksWifiBawaan() {
  String t = WIFI_SSID;
  if (String(WIFI_SSID_2).length()) t += String(", ") + WIFI_SSID_2;
  return t;
}

// Tambah atau perbarui satu WiFi, ditaruh paling depan
void tambahWifiLokal(const String &ssid, const String &pass) {
  if (ssid.length() == 0 || wifiBawaan(ssid)) return;
  int ada = -1;
  for (int i = 0; i < jumlahWifi; i++) if (wifiSsid[i] == ssid) ada = i;
  int sampai = (ada >= 0) ? ada : min(jumlahWifi, MAKS_WIFI - 1);
  for (int i = sampai; i > 0; i--) { wifiSsid[i] = wifiSsid[i - 1]; wifiPass[i] = wifiPass[i - 1]; }
  wifiSsid[0] = ssid;
  wifiPass[0] = pass;
  if (ada < 0 && jumlahWifi < MAKS_WIFI) jumlahWifi++;
}

String daftarWifiTeks() {
  String t;
  for (int i = 0; i < jumlahWifi; i++) { if (i) t += "|"; t += wifiSsid[i]; }
  return t;
}

bool cobaKonek(const String &ssid, const String &pass, unsigned long batasMs) {
  Serial.printf("Menghubungkan ke WiFi \"%s\"", ssid.c_str());

  if (WiFi.status() == WL_CONNECTED) {
    WiFi.disconnect(false, true);
    delay(300);
  }

  if (ssid == "Wokwi-GUEST") {
    WiFi.begin(ssid.c_str(), pass.c_str(), 6);
  } else if (pass.length() == 0) {
    WiFi.begin(ssid.c_str());
  } else {
    WiFi.begin(ssid.c_str(), pass.c_str());
  }

  unsigned long mulai = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - mulai < batasMs) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi terhubung, IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.printf("Gagal terhubung (kode status %d).\n", (int)WiFi.status());
  return false;
}

// Pindai WiFi sekitar, lalu sambungkan ke WiFi tersimpan dengan sinyal terkuat.
// WiFi yang tidak terlihat saat pindai dicoba paling akhir.
bool hubungkanTerbaik(unsigned long batasPerJaringan) {
  String calonS[MAKS_WIFI + 2], calonP[MAKS_WIFI + 2];
  int calonR[MAKS_WIFI + 2];
  int n = 0;
  for (int i = 0; i < jumlahWifi; i++) {
    if (wifiSsid[i].length() == 0) continue;
    calonS[n] = wifiSsid[i]; calonP[n] = wifiPass[i]; calonR[n] = -999; n++;
  }
  calonS[n] = WIFI_SSID; calonP[n] = WIFI_PASSWORD; calonR[n] = -999; n++;
  if (String(WIFI_SSID_2).length()) { calonS[n] = WIFI_SSID_2; calonP[n] = WIFI_PASSWORD_2; calonR[n] = -999; n++; }

#ifndef MODE_WOKWI
  // Hentikan usaha menyambung lama supaya pindai tidak gagal
  WiFi.disconnect(false, true);
  delay(300);
  WiFi.mode(WIFI_STA);
  Serial.println("Memindai WiFi sekitar...");
  int ditemukan = WiFi.scanNetworks();
  if (ditemukan < 0) { delay(500); ditemukan = WiFi.scanNetworks(); }
  Serial.printf("Ditemukan %d WiFi\n", ditemukan < 0 ? 0 : ditemukan);
  for (int k = 0; k < ditemukan; k++) {
    String s = WiFi.SSID(k);
    for (int i = 0; i < n; i++) {
      if (calonS[i] == s && WiFi.RSSI(k) > calonR[i]) calonR[i] = WiFi.RSSI(k);
    }
  }
  WiFi.scanDelete();
#endif

  // Urutkan: yang terlihat dengan sinyal terkuat lebih dulu
  for (int a = 0; a < n; a++) for (int b = 0; b < n - 1 - a; b++) {
    if (calonR[b] < calonR[b + 1]) {
      String ts = calonS[b]; calonS[b] = calonS[b + 1]; calonS[b + 1] = ts;
      String tp = calonP[b]; calonP[b] = calonP[b + 1]; calonP[b + 1] = tp;
      int tr = calonR[b]; calonR[b] = calonR[b + 1]; calonR[b + 1] = tr;
    }
  }

  // 1) Coba semua WiFi tersimpan yang TERLIHAT saat pindai
  bool adaTerlihat = false;
  for (int i = 0; i < n; i++) {
    if (calonR[i] <= -999) continue;
    adaTerlihat = true;
    Serial.printf("Mencoba \"%s\" (%d dBm)\n", calonS[i].c_str(), calonR[i]);
    if (cobaKonek(calonS[i], calonP[i], batasPerJaringan)) return true;
  }
  // 2) Jika tidak ada yang terlihat, coba semua (mungkin WiFi tersembunyi)
#ifndef MODE_WOKWI
  if (adaTerlihat) return false;
#else
  (void)adaTerlihat;
#endif
  for (int i = 0; i < n; i++) {
    Serial.printf("Mencoba \"%s\" (tidak terlihat saat pindai)\n", calonS[i].c_str());
    if (cobaKonek(calonS[i], calonP[i], batasPerJaringan)) return true;
  }
  return false;
}

// =====================================================================
//  MODE HOTSPOT SETUP WIFI (192.168.4.1)
// =====================================================================
String aman(const String &s) {
  String h = s;
  h.replace("&", "&amp;");
  h.replace("<", "&lt;");
  h.replace(">", "&gt;");
  h.replace("\"", "&quot;");
  h.replace("'", "&#39;");
  return h;
}

void pindaiWifi() {
  int n = WiFi.scanNetworks();
  daftarWifiHtml = "";
  for (int i = 0; i < n && i < 20; i++) {
    String s = WiFi.SSID(i);
    if (s.length() == 0) continue;
    if (daftarWifiHtml.indexOf("value=\"" + aman(s) + "\"") >= 0) continue;
    daftarWifiHtml += "<option value=\"" + aman(s) + "\">" + aman(s) +
                      " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }
  WiFi.scanDelete();
}

const char HALAMAN_ATAS[] PROGMEM = R"HTML(<!DOCTYPE html><html lang="id"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setup WiFi Pakan Ikan</title><style>
body{font-family:system-ui,sans-serif;background:#EEF6F8;color:#17303A;margin:0}
header{background:#0B3B4F;color:#fff;padding:20px}h1{margin:0;font-size:20px}
main{padding:16px;max-width:420px;margin:auto}.k{background:#fff;border-radius:14px;padding:16px;margin-bottom:12px}
label{display:block;font-size:13px;color:#5F7A85;margin:10px 0 4px}
select,input{width:100%;padding:12px;font-size:16px;border:1px solid #CFE0E5;border-radius:10px;box-sizing:border-box}
button{width:100%;margin-top:16px;padding:14px;border:0;border-radius:10px;background:#0B3B4F;color:#fff;font-size:16px;font-weight:600}
small{color:#5F7A85}</style></head><body><header><h1>&#128031; Setup WiFi Pakan Ikan</h1></header><main>)HTML";

void halamanUtama() {
  String h = FPSTR(HALAMAN_ATAS);
  h += "<div class='k'><small>WiFi tersimpan di alat:</small><br>";
  for (int i = 0; i < jumlahWifi; i++) h += "&#8226; <b>" + aman(wifiSsid[i]) + "</b><br>";
  h += "&#8226; <b>" + aman(teksWifiBawaan()) + "</b> <small>(bawaan)</small></div>";
  h += "<form class='k' method='POST' action='/simpan'>";
  h += "<label>Pilih WiFi</label><select name='pilih' onchange=\"document.getElementById('s').value=this.value\">";
  h += "<option value=''>(pilih dari daftar)</option>" + daftarWifiHtml + "</select>";
  h += "<label>Nama WiFi (SSID)</label><input id='s' name='ssid' required>";
  h += "<label>Password WiFi</label><input name='pass' type='password' placeholder='kosongkan jika WiFi tanpa password'>";
  h += "<button type='submit'>Tambahkan dan sambungkan</button>";
  h += "<p><small>WiFi ini ditambahkan ke daftar (WiFi lama tidak dihapus). ESP32 hanya bisa WiFi 2,4 GHz. "
       "Setelah disimpan, alat restart dan hotspot ini hilang.</small></p></form>";
  h += "<form class='k' method='POST' action='/pindai'><button type='submit' style='background:#3FC1C9;margin:0'>Pindai ulang WiFi</button></form>";
  h += "</main></body></html>";
  server.send(200, "text/html", h);
}

void halamanSimpan() {
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");
  ssid.trim();
  if (ssid.length() == 0) {
    server.sendHeader("Location", "/");
    server.send(302, "text/plain", "");
    return;
  }
  tambahWifiLokal(ssid, pass);
  unggahSsid = ssid;     // dikirim ke daftar WiFi di aplikasi saat alat online
  unggahPass = pass;
  simpanDaftarWifi();
  String h = FPSTR(HALAMAN_ATAS);
  h += "<div class='k'><b>Tersimpan.</b><br>Alat akan restart dan mencoba tersambung ke <b>" + aman(ssid) +
       "</b>.<br><br><small>Sambungkan kembali HP ke internet, lalu buka aplikasi Pakan Ikan. Jika dalam 1 menit "
       "alat masih offline, kemungkinan password salah dan hotspot setup akan muncul lagi.</small></div></main></body></html>";
  server.send(200, "text/html", h);
  Serial.printf("WiFi baru disimpan: %s. Restart...\n", ssid.c_str());
  delay(1500);
  ESP.restart();
}

void mulaiModeSetup() {
  modeSetup = true;
  waktuMulaiSetup = millis();
  Serial.println("=== MODE SETUP WIFI ===");

  WiFi.disconnect();
  WiFi.mode(WIFI_AP_STA);
  pindaiWifi();
  WiFi.softAP(AP_SSID, AP_PASS);
  delay(200);

  dns.start(53, "*", WiFi.softAPIP());

  server.on("/", HTTP_GET, halamanUtama);
  server.on("/simpan", HTTP_POST, halamanSimpan);
  server.on("/pindai", HTTP_POST, []() {
    pindaiWifi();
    server.sendHeader("Location", "/");
    server.send(302, "text/plain", "");
  });
  server.onNotFound([]() {
    server.sendHeader("Location", "http://192.168.4.1/");
    server.send(302, "text/plain", "");
  });
  server.begin();

  Serial.printf("Sambungkan HP ke WiFi \"%s\" (password %s), lalu buka http://192.168.4.1\n", AP_SSID, AP_PASS);
}

void jalankanModeSetup() {
  dns.processNextRequest();
  server.handleClient();

  if (!sedangMemberiPakan && sudahWaktunya(tKedip, 250)) {
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }

  if (WiFi.softAPgetStationNum() > 0) waktuMulaiSetup = millis();
  if (millis() - waktuMulaiSetup > BATAS_MODE_SETUP) {
    Serial.println("Mode setup tidak dipakai, restart untuk mencoba WiFi lagi...");
    delay(200);
    ESP.restart();
  }
}

// =====================================================================
//  UPDATE FIRMWARE LEWAT WIFI (ArduinoOTA)
//  Protokol sama dengan upload OTA Arduino IDE (espota). Aplikasi Android
//  mengirim undangan UDP ke port 3232, menjawab tantangan password, lalu
//  alat menyambung balik ke HP lewat TCP untuk menerima file .bin.
// =====================================================================
void mulaiOta() {
#ifndef MODE_WOKWI
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.setPort(3232);

  ArduinoOTA.onStart([]() {
    otaBerjalan = true;
    otaPersenTerakhir = -1;
    if (sedangMemberiPakan) berhentiPakan();
    relayBlower(false);
    digitalWrite(BUZZER_PIN, LOW);
    // Hentikan stream Firebase supaya memori dan jaringan fokus ke update
    if (streamDimulai) {
      Firebase.RTDB.endStream(&fbStream);
      Firebase.RTDB.removeStreamCallback(&fbStream);
      streamDimulai = false;
    }
    Serial.println("Update firmware lewat WiFi dimulai...");
  });
  ArduinoOTA.onProgress([](unsigned int selesai, unsigned int total) {
    int persen = total ? (int)((uint64_t)selesai * 100 / total) : 0;
    digitalWrite(LED_PIN, (selesai / 4096) % 2);
    if (persen != otaPersenTerakhir && persen % 10 == 0) {
      otaPersenTerakhir = persen;
      Serial.printf("Update: %d%%\n", persen);
    }
  });
  ArduinoOTA.onEnd([]() {
    digitalWrite(LED_PIN, HIGH);
    Serial.println("Update selesai, restart...");
  });
  ArduinoOTA.onError([](ota_error_t e) {
    otaBerjalan = false;
    digitalWrite(LED_PIN, LOW);
    Serial.printf("Update gagal (kode %d)\n", (int)e);
  });

  ArduinoOTA.begin();
  otaSiap = true;
  Serial.printf("OTA siap: %s (%s) port 3232\n", OTA_HOSTNAME, WiFi.localIP().toString().c_str());
#endif
}

// Tahan tombol 3 detik saat menyala = mode hotspot setup WiFi
int tombolDitahanSaatMenyala() {
  if (digitalRead(BUTTON_PIN) != LOW) return 0;
  Serial.println("Tombol ditekan saat menyala. Tahan 3 detik untuk setup WiFi.");
  unsigned long mulai = millis();
  int hasil = 0;
  while (digitalRead(BUTTON_PIN) == LOW) {
    unsigned long lama = millis() - mulai;
    if (lama >= 3000) { hasil = 1; digitalWrite(LED_PIN, (millis() / 100) % 2); }
    else digitalWrite(LED_PIN, (millis() / 400) % 2);
    if (lama > 15000) break;
    delay(20);
  }
  digitalWrite(LED_PIN, LOW);
  tombolSebelumnya = HIGH;
  return hasil;
}

// =====================================================================
//  SENSOR
// =====================================================================
float bacaJarak() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long durasi = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (durasi == 0) return -1;
  return durasi * 0.0343 / 2.0;
}

float hitungLevel(float jarakCm) {
  if (jarakCm < 0) return -1;
  float penuh = atur.penuhMm / 10.0;
  float kosong = atur.kosongMm / 10.0;
  if (kosong - penuh < 0.5) return -1;   // kalibrasi tidak masuk akal
  float persen = (kosong - jarakCm) / (kosong - penuh) * 100.0;
  return constrain(persen, 0.0, 100.0);
}

// =====================================================================
//  PEMBERIAN PAKAN (katup dengan sudut dan kecepatan yang bisa diatur)
// =====================================================================
void catatPemberian(const char *sumber) {
  jumlahPemberian++;

  struct tm w;
  if (getLocalTime(&w, 0)) {
    snprintf(pemberianTerakhir, sizeof(pemberianTerakhir), "%02d:%02d, %02d/%02d",
             w.tm_hour, w.tm_min, w.tm_mday, w.tm_mon + 1);
  } else {
    snprintf(pemberianTerakhir, sizeof(pemberianTerakhir), "waktu belum sinkron");
  }

  strncpy(sumberRiwayat, sumber, sizeof(sumberRiwayat) - 1);
  sumberRiwayat[sizeof(sumberRiwayat) - 1] = '\0';
  tambahAntrianPakan(sumber);
}

unsigned long msPerDerajat() {
  int k = constrain(atur.kecepatan, 1, 10);
  return (unsigned long)(10 - k) * 3;  // 10 = langsung, 1 = 27 ms per derajat
}

void mulaiPakan(const char *sumber) {
  if (sedangMemberiPakan) return;

  sedangMemberiPakan = true;
  waktuMulai = millis();
  waktuSapuTerakhir = millis();

  sudutArah = atur.arahMin;
  arahSapu = 1;
  servoArah.write(sudutArah);

  sudutKatup = atur.sudutTutup;
  faseKatup = KATUP_BUKA;
  tLangkahKatup = millis();

  tesRelayAktif = false;
  relayBlower(true);
  digitalWrite(LED_PIN, HIGH);
  digitalWrite(BUZZER_PIN, HIGH);

  catatPemberian(sumber);
  Serial.printf("Pakan dimulai (sumber: %s)\n", sumber);
  perluKirimStatus = true;
}

void berhentiPakan() {
  sedangMemberiPakan = false;
  faseKatup = KATUP_DIAM;

  relayBlower(false);
  servoPakan.write(atur.sudutTutup);
  servoArah.write((atur.arahMin + atur.arahMax) / 2);
  digitalWrite(LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  Serial.println("Pakan selesai");
  perluKirimStatus = true;
}

// Gerakkan katup 1 derajat per langkah menuju target. true = sudah sampai.
bool gerakKatupMenuju(int target) {
  unsigned long jeda = msPerDerajat();
  if (jeda == 0) {
    sudutKatup = target;
    servoPakan.write(sudutKatup);
    return true;
  }
  if (millis() - tLangkahKatup < jeda) return false;
  tLangkahKatup = millis();
  if (sudutKatup < target) sudutKatup++;
  else if (sudutKatup > target) sudutKatup--;
  servoPakan.write(sudutKatup);
  return sudutKatup == target;
}

void kelolaKatup() {
  switch (faseKatup) {
    case KATUP_BUKA:
      if (gerakKatupMenuju(atur.sudutBuka)) {
        faseKatup = KATUP_TAHAN;
        tFaseKatup = millis();
      }
      break;
    case KATUP_TAHAN:
      if (millis() - tFaseKatup >= (unsigned long)atur.durasiBukaMs) {
        faseKatup = KATUP_TUTUP;
        tLangkahKatup = millis();
      }
      break;
    case KATUP_TUTUP:
      if (gerakKatupMenuju(atur.sudutTutup)) {
        faseKatup = KATUP_DIAM;
        tKatupSelesai = millis();
      }
      break;
    default:
      break;
  }
}

// Kecepatan 1..10: langkah 1 sampai 4 derajat, jeda 46 sampai 10 ms
void sapuArah() {
  int k = constrain(atur.arahKecepatan, 1, 10);
  unsigned long jeda = 10 + (unsigned long)(10 - k) * 4;
  int langkah = 1 + (k - 1) / 3;
  if (millis() - waktuSapuTerakhir < jeda) return;
  waktuSapuTerakhir = millis();

  if (atur.arahMax - atur.arahMin < 2) {   // batas terlalu sempit: diam di tengah
    servoArah.write((atur.arahMin + atur.arahMax) / 2);
    return;
  }
  sudutArah += arahSapu * langkah;
  if (sudutArah >= atur.arahMax) { sudutArah = atur.arahMax; arahSapu = -1; }
  else if (sudutArah <= atur.arahMin) { sudutArah = atur.arahMin; arahSapu = 1; }
  servoArah.write(sudutArah);
}

// =====================================================================
//  FIREBASE: menerima perintah dan pengaturan
// =====================================================================
void streamCallback(FirebaseStream data) {
  adaPerubahanKontrol = true;
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) Serial.println("Stream Firebase timeout, menyambung ulang...");
}

long waktuSekarangDetik() {
  time_t t = time(nullptr);
  return (t > 1700000000) ? (long)t : 0;
}

bool perintahMasihBaru(long waktuPerintah) {
  long sekarang = waktuSekarangDetik();
  if (sekarang > 0 && waktuPerintah > 0) return labs(sekarang - waktuPerintah) <= BATAS_UMUR_PERINTAH;
  return kontrolPertamaDibaca;
}

int ambilInt(FirebaseJson &json, const String &path, int bawaan) {
  FirebaseJsonData d;
  if (json.get(d, path) && d.success) return d.intValue;
  return bawaan;
}

bool ambilBool(FirebaseJson &json, const String &path, bool bawaan) {
  FirebaseJsonData d;
  if (json.get(d, path) && d.success) return d.boolValue;
  return bawaan;
}

// ---------- Update firmware lewat Firebase (tidak perlu WiFi yang sama) ----------
void simpanIdOtaFb(long id) {
  otaFbIdTerakhir = id;
  Preferences p;
  p.begin("otafb", false);
  p.putLong("id", id);
  p.end();
}

void muatIdOtaFb() {
  Preferences p;
  p.begin("otafb", true);
  otaFbIdTerakhir = p.getLong("id", 0);
  p.end();
}

void laporOtaFb(long id, const char *tahap, int persen, const String &pesan) {
  FirebaseJson j;
  j.set("id", (int)id);
  j.set("tahap", tahap);
  j.set("persen", persen);
  j.set("pesan", pesan);
  j.set("versiAlat", FIRMWARE_VERSI);
  j.set("waktu/.sv", "timestamp");
  if (!Firebase.RTDB.setJSON(&fbdo, PATH_OTA_STATUS, &j))
    Serial.printf("Gagal kirim kabar update: %s\n", fbdo.errorReason().c_str());
}

void kabarUnduhOta(RTDB_DownloadStatusInfo info) {
  if (info.status == firebase_rtdb_download_status_download) {
    int p = (int)info.progress;
    if (p != otaFbPersen) {
      otaFbPersen = p;
      if (p % 10 == 0) Serial.printf("  unduh firmware %d%%\n", p);
      digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    }
  } else if (info.status == firebase_rtdb_download_status_error) {
    Serial.printf("  unduh firmware gagal: %s\n", info.errorMsg.c_str());
  }
}

void jalankanOtaFirebase() {
  long id = otaFbIdBaru;
  otaFbIdBaru = 0;
  Serial.println("Update firmware lewat Firebase dimulai...");
  laporOtaFb(id, "mengunduh", 0, "Alat sedang mengunduh firmware dari Firebase");

  relayBlower(false);
  digitalWrite(BUZZER_PIN, LOW);
  if (streamDimulai) {   // hentikan stream supaya memori cukup untuk unduhan
    Firebase.RTDB.endStream(&fbStream);
    Firebase.RTDB.removeStreamCallback(&fbStream);
    streamDimulai = false;
  }

  otaFbPersen = -1;
  unsigned long mulai = millis();
  bool ok = Firebase.RTDB.downloadOTA(&fbdo, PATH_OTA_FILE, kabarUnduhOta);
  simpanIdOtaFb(id);   // dicatat sukses atau gagal, supaya tidak mengulang terus
  digitalWrite(LED_PIN, LOW);

  if (ok) {
    Serial.printf("Firmware baru terpasang (%lu detik). Restart...\n", (millis() - mulai) / 1000);
    laporOtaFb(id, "selesai", 100, "Firmware baru terpasang. Alat restart dan online lagi sekitar 30 detik.");
    delay(1500);
    ESP.restart();
  } else {
    String alasan = fbdo.errorReason();
    if (Update.isRunning()) Update.abort();
    Serial.printf("Update lewat Firebase gagal: %s\n", alasan.c_str());
    laporOtaFb(id, "gagal", otaFbPersen < 0 ? 0 : otaFbPersen, "Gagal: " + alasan + ". Firmware lama tetap dipakai.");
    adaPerubahanKontrol = true;   // stream dimulai lagi di loop
  }
}

void bacaKontrol() {
  if (!Firebase.RTDB.getJSON(&fbdo, PATH_KONTROL)) {
    Serial.printf("Gagal membaca kontrol: %s\n", fbdo.errorReason().c_str());
    adaPerubahanKontrol = true;
    return;
  }
  if (fbdo.dataType() != "json") {
    kontrolPertamaDibaca = true;
    return;
  }

  FirebaseJson &json = fbdo.jsonObject();
  FirebaseJsonData d;
  bool berubah = false;

  // ---------- Jadwal ----------
  if (json.get(d, "jadwalRingkas") && d.success) {
    String baru = d.stringValue;
    if (baru != jadwalRingkas) {
      parseJadwal(baru);
      jadwalRingkas = buatRingkasJadwal();
      berubah = true;
      Serial.printf("Jadwal diperbarui: %d jadwal\n", jumlahJadwal);
      for (int i = 0; i < jumlahJadwal; i++) {
        Serial.printf("  %d. %02d:%02d %s (hari=0x%02X)\n", i + 1, jadwal[i].jam, jadwal[i].menit,
                      jadwal[i].aktif ? "aktif" : "mati", jadwal[i].hari);
      }
    }
  }

  // ---------- Pengaturan alat ----------
  Pengaturan b = atur;
  b.sudutBuka    = constrain(ambilInt(json, "pengaturan/sudutBuka", b.sudutBuka), 0, 180);
  b.sudutTutup   = constrain(ambilInt(json, "pengaturan/sudutTutup", b.sudutTutup), 0, 180);
  b.kecepatan    = constrain(ambilInt(json, "pengaturan/kecepatan", b.kecepatan), 1, 10);
  b.durasiBukaMs = constrain(ambilInt(json, "pengaturan/durasiBukaMs", b.durasiBukaMs), 100, 30000);
  b.penuhMm      = ambilInt(json, "pengaturan/penuhMm", b.penuhMm);
  b.kosongMm     = ambilInt(json, "pengaturan/kosongMm", b.kosongMm);
  b.rbAktif      = ambilBool(json, "pengaturan/reboot/aktif", b.rbAktif);
  b.rbJam        = constrain(ambilInt(json, "pengaturan/reboot/jam", b.rbJam), 0, 23);
  b.rbMenit      = constrain(ambilInt(json, "pengaturan/reboot/menit", b.rbMenit), 0, 59);
  b.rbHari       = ambilInt(json, "pengaturan/reboot/hari", b.rbHari) & 0x7F;
  if (b.rbHari == 0) b.rbHari = 0x7F;
  b.durasiBlowerMs = constrain(ambilInt(json, "pengaturan/durasiBlowerMs", b.durasiBlowerMs), 500, 60000);
  b.arahMin        = constrain(ambilInt(json, "pengaturan/arahMin", b.arahMin), 0, 180);
  b.arahMax        = constrain(ambilInt(json, "pengaturan/arahMax", b.arahMax), 0, 180);
  b.arahKecepatan  = constrain(ambilInt(json, "pengaturan/arahKecepatan", b.arahKecepatan), 1, 10);
  // relayMode (v3.9: 0/1/2) diutamakan, relayAktifRendah (v3.7) untuk aplikasi lama
  {
    int lama = ambilBool(json, "pengaturan/relayAktifRendah", b.relayAktifRendah != 0) ? 1 : 0;
    if (b.relayAktifRendah == 2 && lama == 1) lama = 2;
    b.relayAktifRendah = constrain(ambilInt(json, "pengaturan/relayMode", lama), 0, 2);
  }
  if (b.arahMin > b.arahMax) { int t = b.arahMin; b.arahMin = b.arahMax; b.arahMax = t; }

  if (memcmp(&b, &atur, sizeof(Pengaturan)) != 0) {
    atur = b;
    berubah = true;
    if (!sedangMemberiPakan) {
      if (!tesRelayAktif) { relayBlower(false); aturPinRelay(); relayBlower(false); }   // terapkan jenis relay baru
      servoPakan.write(atur.sudutTutup);
      servoArah.write((atur.arahMin + atur.arahMax) / 2);
    }
    Serial.printf("Pengaturan baru: katup %d->%d derajat, kecepatan %d, buka %d ms, penuh %d mm, habis %d mm\n",
                  atur.sudutTutup, atur.sudutBuka, atur.kecepatan, atur.durasiBukaMs, atur.penuhMm, atur.kosongMm);
    Serial.printf("  blower %d ms, relay aktif %s, pengarah %d-%d derajat kecepatan %d\n",
                  atur.durasiBlowerMs, namaJenisRelay(), atur.arahMin, atur.arahMax, atur.arahKecepatan);
  }

  if (berubah) simpanPengaturan();

  // ---------- WiFi baru ----------
  long v = ambilInt(json, "wifiVersi", 0);
  if (v > 0 && v != wifiVersi) {
    perluSinkronWifi = true;
    versiWifiBaru = v;
  }

  // ---------- Reboot sekarang ----------
  long rb = ambilInt(json, "rebootSekarang", 0);
  if (rb > 0 && rb != rebootVersiTerakhir) {
    simpanRebootVersi(rb);
    if (perintahMasihBaru(rb)) perluReboot = true;
  }

  // ---------- Update firmware lewat Firebase ----------
  long oid = ambilInt(json, "otaFirebase/id", 0);
  if (oid > 0 && oid != otaFbIdTerakhir && oid != otaFbIdBaru) {
    long sek = waktuSekarangDetik();
    if (sek > 0 && labs(sek - oid) > BATAS_UMUR_OTA_FB) {
      Serial.println("Perintah update lewat Firebase sudah kedaluwarsa, diabaikan");
      simpanIdOtaFb(oid);
    } else {
      otaFbIdBaru = oid;
      perluOtaFirebase = true;
    }
  }

  // ---------- Tes relay 3 detik ----------
  long tr = ambilInt(json, "tesRelay", 0);
  if (tr > 0 && tr != tesRelayTerakhir) {
    bool pertama = tesRelayTerakhir == 0 && !kontrolPertamaDibaca;
    tesRelayTerakhir = tr;
    if (!pertama && perintahMasihBaru(tr) && !sedangMemberiPakan) {
      Serial.printf("Tes relay (aktif %s) selama 3 detik\n", namaJenisRelay());
      relayBlower(true);
      tesRelayAktif = true;
      tesRelaySampai = millis() + 3000UL;
    }
  }

  // ---------- Beri pakan ----------
  bool beri = ambilBool(json, "beriPakan", false);
  long waktuPerintah = ambilInt(json, "waktuPerintah", 0);
  if (beri) {
    Firebase.RTDB.setBool(&fbdo, PATH_PERINTAH, false);
    if (perintahMasihBaru(waktuPerintah)) mulaiPakan("Aplikasi");
    else Serial.println("Perintah lama dari aplikasi diabaikan (kedaluwarsa)");
  }

  kontrolPertamaDibaca = true;
}

// Ambil daftar WiFi dari aplikasi (/wifiAlat/daftar = array {ssid, pass}).
// Alat TIDAK pindah jaringan. Daftar baru dipakai saat WiFi sekarang putus atau alat restart.
void prosesSinkronWifi() {
  perluSinkronWifi = false;
  if (!Firebase.RTDB.getJSON(&fbdo, PATH_WIFI)) {
    Serial.printf("Gagal membaca daftar WiFi: %s\n", fbdo.errorReason().c_str());
    wifiPesan = "Alat gagal membaca daftar WiFi (cek Rules)";
    perluKirimStatus = true;
    return;
  }

  int n = 0;
  String s2[MAKS_WIFI], p2[MAKS_WIFI];
  if (fbdo.dataType() == "json") {
    FirebaseJson &json = fbdo.jsonObject();
    FirebaseJsonData d;
    for (int i = 0; i < 20 && n < MAKS_WIFI; i++) {
      String dasar = "daftar/[" + String(i) + "]/";
      if (!(json.get(d, dasar + "ssid") && d.success)) continue;
      String ssid = d.stringValue;
      ssid.trim();
      if (ssid.length() == 0 || wifiBawaan(ssid)) continue;
      String pass = (json.get(d, dasar + "pass") && d.success) ? d.stringValue : String("");
      s2[n] = ssid;
      p2[n] = pass;
      n++;
    }
  }

  for (int i = 0; i < MAKS_WIFI; i++) { wifiSsid[i] = i < n ? s2[i] : String(""); wifiPass[i] = i < n ? p2[i] : String(""); }
  jumlahWifi = n;
  wifiVersi = versiWifiBaru;
  simpanDaftarWifi();

  wifiPesan = "Daftar WiFi diperbarui: " + String(n) + " jaringan + bawaan";
  Serial.println(wifiPesan);
  for (int i = 0; i < jumlahWifi; i++) Serial.printf("  %d. %s\n", i + 1, wifiSsid[i].c_str());
  perluKirimStatus = true;
}

// WiFi yang ditambah lewat hotspot dimasukkan ke daftar di Firebase
void unggahWifiDariHotspot() {
  if (unggahSsid.length() == 0) return;
  int jumlah = 0;
  bool sudahAda = false;
  if (Firebase.RTDB.getJSON(&fbdo, PATH_WIFI "/daftar") && fbdo.dataType() == "array") {
    FirebaseJsonArray &arr = fbdo.jsonArray();
    jumlah = arr.size();
    FirebaseJsonData d;
    for (int i = 0; i < jumlah; i++) {
      if (arr.get(d, "/[" + String(i) + "]/ssid") && d.success && d.stringValue == unggahSsid) sudahAda = true;
    }
  }
  if (!sudahAda) {
    FirebaseJson j;
    j.set("ssid", unggahSsid);
    j.set("pass", unggahPass);
    j.set("dariAlat", true);
    String path = String(PATH_WIFI) + "/daftar/" + String(jumlah);
    if (!Firebase.RTDB.setJSON(&fbdo, path.c_str(), &j)) {
      Serial.printf("Gagal mengunggah WiFi: %s\n", fbdo.errorReason().c_str());
      unggahSsid = "";      // jangan diulang terus jika ditolak
      simpanDaftarWifi();
      return;
    }
  }
  Serial.printf("WiFi \"%s\" dari hotspot masuk ke daftar aplikasi\n", unggahSsid.c_str());
  unggahSsid = "";
  unggahPass = "";
  simpanDaftarWifi();
}

// =====================================================================
//  FIREBASE: mengirim data
// =====================================================================
void kirimStatus() {
  FirebaseJson j;
  j.set("statusPakan", sedangMemberiPakan ? "Sedang memberi pakan" : "Siap memberi pakan");
  j.set("sedangMemberi", sedangMemberiPakan);
  j.set("jarak", jarakTerakhir >= 0 ? roundf(jarakTerakhir * 10) / 10.0 : -1);
  j.set("level", levelPakan >= 0 ? (int)roundf(levelPakan) : -1);
  j.set("terakhir", pemberianTerakhir);
  j.set("ip", WiFi.localIP().toString());
  j.set("wifi", WiFi.SSID());
  j.set("rssi", (int)WiFi.RSSI());
  j.set("wifiPesan", wifiPesan);
  j.set("wifiTersimpan", daftarWifiTeks());
  j.set("wifiBawaan", teksWifiBawaan());
  j.set("firmware", FIRMWARE_VERSI);
  j.set("otaHost", OTA_HOSTNAME);
  j.set("uptime", (int)(millis() / 1000));
  j.set("jumlahJadwal", jumlahJadwal);
  j.set("antrianRiwayat", (int)(antrianPakan.jumlah + antrianLevel.jumlah));
  j.set("update/.sv", "timestamp");

  if (!Firebase.RTDB.updateNode(&fbdo, PATH_STATUS, &j)) {
    Serial.printf("Gagal kirim status: %s\n", fbdo.errorReason().c_str());
  }
}

// ---------- Antrian riwayat (offline) ----------
uint32_t epochSekarang() {
  time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;   // 0 = jam belum tersinkron
}

void muatAntrian() {
  prefAntrian.begin("antrian", true);
  if (prefAntrian.getBytesLength("pakan") != sizeof(antrianPakan) ||
      prefAntrian.getBytes("pakan", &antrianPakan, sizeof(antrianPakan)) != sizeof(antrianPakan) ||
      antrianPakan.awal >= MAKS_ANTRIAN_PAKAN || antrianPakan.jumlah > MAKS_ANTRIAN_PAKAN) {
    memset(&antrianPakan, 0, sizeof(antrianPakan));
  }
  if (prefAntrian.getBytesLength("level") != sizeof(antrianLevel) ||
      prefAntrian.getBytes("level", &antrianLevel, sizeof(antrianLevel)) != sizeof(antrianLevel) ||
      antrianLevel.awal >= MAKS_ANTRIAN_LEVEL || antrianLevel.jumlah > MAKS_ANTRIAN_LEVEL) {
    memset(&antrianLevel, 0, sizeof(antrianLevel));
  }
  prefAntrian.end();
  if (antrianPakan.jumlah || antrianLevel.jumlah)
    Serial.printf("Antrian riwayat belum terkirim: %u pakan, %u level\n", antrianPakan.jumlah, antrianLevel.jumlah);
}

void simpanAntrian() {
  if (!antrianPakanBerubah && !antrianLevelBerubah) return;
  prefAntrian.begin("antrian", false);
  if (antrianPakanBerubah) prefAntrian.putBytes("pakan", &antrianPakan, sizeof(antrianPakan));
  if (antrianLevelBerubah) prefAntrian.putBytes("level", &antrianLevel, sizeof(antrianLevel));
  prefAntrian.end();
  antrianPakanBerubah = antrianLevelBerubah = false;
}

void tambahAntrianPakan(const char *sumber) {
  AntrianPakan &q = antrianPakan;
  if (q.jumlah == MAKS_ANTRIAN_PAKAN) { q.awal = (q.awal + 1) % MAKS_ANTRIAN_PAKAN; q.jumlah--; }  // penuh: buang yang tertua
  EntriPakan &e = q.isi[(q.awal + q.jumlah) % MAKS_ANTRIAN_PAKAN];
  e.waktu = epochSekarang();
  e.level = levelPakan >= 0 ? (int8_t)roundf(levelPakan) : -1;
  strncpy(e.sumber, sumber, sizeof(e.sumber) - 1);
  e.sumber[sizeof(e.sumber) - 1] = '\0';
  q.jumlah++;
  antrianPakanBerubah = true;
  simpanAntrian();   // langsung disimpan, jaga-jaga listrik padam
}

void tambahAntrianLevel() {
  uint32_t t = epochSekarang();
  if (levelPakan < 0 || t == 0) return;   // tanpa jam, catatan level tidak berguna untuk grafik
  AntrianLevel &q = antrianLevel;
  if (q.jumlah == MAKS_ANTRIAN_LEVEL) { q.awal = (q.awal + 1) % MAKS_ANTRIAN_LEVEL; q.jumlah--; }
  EntriLevel &e = q.isi[(q.awal + q.jumlah) % MAKS_ANTRIAN_LEVEL];
  e.waktu = t;
  e.level = (int8_t)roundf(levelPakan);
  e.cadangan = 0;
  e.jarak10 = (uint16_t)constrain((int)roundf(jarakTerakhir * 10), 0, 65535);
  q.jumlah++;
  antrianLevelBerubah = true;
  simpanAntrian();
}

// Kirim satu entri antrian (yang tertua dulu). Dipanggil berulang dari loop saat online.
void kirimAntrian() {
  char isi[160];
  if (antrianPakan.jumlah) {
    EntriPakan &e = antrianPakan.isi[antrianPakan.awal];
    char sumberAman[sizeof(e.sumber)];
    for (size_t i = 0; i < sizeof(sumberAman); i++) {
      char c = e.sumber[i];
      sumberAman[i] = (c == '"' || c == '\\' || (c && c < 32)) ? '\'' : c;
      if (!c) break;
    }
    sumberAman[sizeof(sumberAman) - 1] = '\0';
    uint32_t kini = epochSekarang();
    bool tertunda = (e.waktu == 0 || kini == 0 || kini - e.waktu > 120);
    if (e.waktu) {
      snprintf(isi, sizeof(isi), "{\"sumber\":\"%s\",\"level\":%d,\"waktu\":%llu%s}", sumberAman, (int)e.level,
               (unsigned long long)e.waktu * 1000ULL, tertunda ? ",\"tertunda\":true" : "");
    } else {   // jam belum tersinkron saat itu: pakai jam server
      snprintf(isi, sizeof(isi), "{\"sumber\":\"%s\",\"level\":%d,\"waktu\":{\".sv\":\"timestamp\"},\"tertunda\":true}",
               sumberAman, (int)e.level);
    }
    FirebaseJson kirim; kirim.setJsonData(String(isi));
    if (Firebase.RTDB.pushJSON(&fbdo, PATH_RIWAYAT, &kirim)) {
      antrianPakan.awal = (antrianPakan.awal + 1) % MAKS_ANTRIAN_PAKAN;
      antrianPakan.jumlah--;
      antrianPakanBerubah = true;
    } else {
      Serial.printf("Gagal kirim riwayat: %s\n", fbdo.errorReason().c_str());
      tKirimAntrian = millis() + 10000UL;   // coba lagi 10 detik lagi
    }
  } else if (antrianLevel.jumlah) {
    EntriLevel &e = antrianLevel.isi[antrianLevel.awal];
    snprintf(isi, sizeof(isi), "{\"level\":%d,\"jarak\":%.1f,\"waktu\":%llu,\"tertunda\":true}",
             (int)e.level, e.jarak10 / 10.0f, (unsigned long long)e.waktu * 1000ULL);
    FirebaseJson kirim; kirim.setJsonData(String(isi));
    if (Firebase.RTDB.pushJSON(&fbdo, PATH_RIW_LEVEL, &kirim)) {
      antrianLevel.awal = (antrianLevel.awal + 1) % MAKS_ANTRIAN_LEVEL;
      antrianLevel.jumlah--;
      antrianLevelBerubah = true;
    } else {
      Serial.printf("Gagal kirim riwayat level: %s\n", fbdo.errorReason().c_str());
      tKirimAntrian = millis() + 10000UL;
    }
  }
  // Simpan ke flash saat antrian habis, atau tiap 10 entri terkirim (hemat tulis flash)
  static uint8_t hitung = 0;
  if (antrianPakanBerubah || antrianLevelBerubah) {
    if (++hitung >= 10 || (!antrianPakan.jumlah && !antrianLevel.jumlah)) { hitung = 0; simpanAntrian(); }
  }
}

void kirimLogLevel() {
  if (levelPakan < 0) return;
  FirebaseJson j;
  j.set("level", (int)roundf(levelPakan));
  j.set("jarak", roundf(jarakTerakhir * 10) / 10.0);
  j.set("rssi", (int)WiFi.RSSI());
  j.set("waktu/.sv", "timestamp");
  if (!Firebase.RTDB.pushJSON(&fbdo, PATH_RIW_LEVEL, &j)) {
    Serial.printf("Gagal kirim riwayat level: %s\n", fbdo.errorReason().c_str());
    tambahAntrianLevel();
  }
}

void kirimLaporan() {
  FirebaseJson j;
  j.set("pesan", pesanLaporan);
  j.set("waktu/.sv", "timestamp");
  if (!Firebase.RTDB.setJSON(&fbdo, PATH_LAPORAN, &j)) {
    Serial.printf("Gagal kirim laporan: %s\n", fbdo.errorReason().c_str());
  }
}

// =====================================================================
//  TUGAS BERKALA
// =====================================================================
void periksaJadwal() {
  struct tm w;
  if (!getLocalTime(&w, 0)) return;   // jam belum pernah tersinkron sejak menyala

  int hariKe = (w.tm_wday == 0) ? 7 : w.tm_wday;
  int menitSekarang = w.tm_hour * 60 + w.tm_min;

  // Jadwal tetap dijalankan walau terlambat sampai 3 menit (misalnya alat sedang
  // sibuk mencari WiFi tepat di menit jadwal). Kunci per hari mencegah dobel.
  for (int i = 0; i < jumlahJadwal; i++) {
    if (!jadwal[i].aktif) continue;
    if (!(jadwal[i].hari & (1 << (hariKe - 1)))) continue;
    int menitJadwal = jadwal[i].jam * 60 + jadwal[i].menit;
    int telat = menitSekarang - menitJadwal;
    if (telat < 0 || telat > 3) continue;
    int kunci = w.tm_yday * 1440 + menitJadwal;
    if (jadwal[i].kunciTerakhir == kunci) continue;
    if (sedangMemberiPakan) continue;   // tunggu pemberian sebelumnya selesai

    jadwal[i].kunciTerakhir = kunci;
    Serial.printf("Jadwal %02d:%02d berjalan%s\n", jadwal[i].jam, jadwal[i].menit, telat ? " (terlambat)" : "");
    char sumber[16];
    snprintf(sumber, sizeof(sumber), "Jadwal %02d:%02d", jadwal[i].jam, jadwal[i].menit);
    mulaiPakan(sumber);
  }

  // Reboot terjadwal. Syarat uptime > 2 menit mencegah reboot berulang di menit yang sama.
  if (atur.rbAktif && !sedangMemberiPakan && millis() > 120000UL &&
      atur.rbJam == w.tm_hour && atur.rbMenit == w.tm_min &&
      (atur.rbHari & (1 << (hariKe - 1)))) {
    Serial.println("Reboot terjadwal...");
    perluReboot = true;
  }
}

void pantauSensor() {
  jarakTerakhir = bacaJarak();
  levelPakan = hitungLevel(jarakTerakhir);

  if (jarakTerakhir >= 0) {
    Serial.printf("Jarak: %.1f cm, level pakan: %.0f%%, sinyal: %d dBm\n",
                  jarakTerakhir, levelPakan, (int)WiFi.RSSI());
    if (ALARM_PAKAN_HABIS && !sedangMemberiPakan && levelPakan >= 0) {
      digitalWrite(BUZZER_PIN, levelPakan <= BATAS_ALARM_PERSEN ? HIGH : LOW);
    }
  } else {
    Serial.println("Sensor belum terbaca");
  }
}

void pantauTombol() {
  bool tombol = digitalRead(BUTTON_PIN);
  if (tombolSebelumnya == HIGH && tombol == LOW) mulaiPakan("Tombol fisik");
  tombolSebelumnya = tombol;
}

void buatLaporan() {
  if (jumlahPemberian > 0) {
    pesanLaporan = "Pakan telah diberikan " + String(jumlahPemberian) +
                   "x (terakhir " + String(pemberianTerakhir) + "). ";
  } else {
    pesanLaporan = "Belum ada pemberian pakan pada periode ini. ";
  }
  if (levelPakan >= 0) pesanLaporan += "Sisa pakan: " + String(levelPakan, 0) + "%.";
  else pesanLaporan += "Level pakan belum terbaca.";

  Serial.println(pesanLaporan);
  perluKirimLaporan = true;
  jumlahPemberian = 0;
}

void rebootSekarang() {
  Serial.println("Restart ESP32...");
  if (firebaseDimulai && Firebase.ready()) {
    FirebaseJson j;
    j.set("statusPakan", "Sedang restart");
    Firebase.RTDB.updateNode(&fbdo, PATH_STATUS, &j);
  }
  delay(500);
  ESP.restart();
}

// =====================================================================
//  SETUP
// =====================================================================
void mulaiFirebase() {
  Serial.printf("Firebase Client v%s\n", FIREBASE_CLIENT_VERSION);
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  config.token_status_callback = tokenStatusCallback;

  Firebase.reconnectNetwork(false);  // penyambungan ulang WiFi diatur sendiri
  fbdo.setBSSLBufferSize(4096, 1024);
  fbStream.setBSSLBufferSize(4096, 1024);
  fbdo.setResponseSize(4096);

  Firebase.begin(&config, &auth);
  firebaseDimulai = true;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nPakan Ikan firmware v%s\n", FIRMWARE_VERSI);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  muatSemua();   // dimuat dulu supaya jenis relay sudah diketahui
  muatIdOtaFb();
  relayBlower(false);
  aturPinRelay();
  relayBlower(false);
  muatAntrian();

  servoPakan.setPeriodHertz(50);
  servoPakan.attach(SERVO_PIN, 500, 2400);
  servoPakan.write(atur.sudutTutup);
  sudutKatup = atur.sudutTutup;

  servoArah.setPeriodHertz(50);
  servoArah.attach(ARAH_PIN, 500, 2400);
  servoArah.write((atur.arahMin + atur.arahMax) / 2);

  digitalWrite(LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
  relayBlower(false);

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);          // jangan tulis WiFi ke flash bawaan, daftar ada di EEPROM
  WiFi.setAutoReconnect(false);    // penyambungan ulang diatur sendiri (lihat loop)

#ifdef MODE_WOKWI
  while (!cobaKonek(WIFI_SSID, WIFI_PASSWORD, 30000)) {
    Serial.println("Mencoba lagi...");
  }
#else
  if (tombolDitahanSaatMenyala() == 1) { mulaiModeSetup(); return; }

  if (!hubungkanTerbaik(15000)) { mulaiModeSetup(); return; }
#endif

  configTime(ZONA_WAKTU, 0, "pool.ntp.org", "time.google.com");
  mulaiOta();
  mulaiFirebase();
  tLogLevel = millis() - INTERVAL_LOG_LEVEL + 30000UL;  // log level pertama 30 detik setelah menyala
  Serial.println("Sistem pakan ikan siap");
}

// =====================================================================
//  LOOP
// =====================================================================
void loop() {
  if (otaSiap) {
    ArduinoOTA.handle();
    if (otaBerjalan) return;   // saat update, pekerjaan lain berhenti
  }

  // ----- Tugas lokal (tetap jalan walau internet putus) -----
  if (sudahWaktunya(tTombol, 100))   pantauTombol();
  if (sudahWaktunya(tSensor, 1000))  pantauSensor();
  if (sudahWaktunya(tJadwal, 5000))  periksaJadwal();
  if (sudahWaktunya(tLaporan, INTERVAL_LAPORAN)) buatLaporan();
  if (sudahWaktunya(tLogLevel, INTERVAL_LOG_LEVEL)) perluLogLevel = true;
  if (sudahWaktunya(tLogOffline, INTERVAL_LOG_OFFLINE)) {
    bool online = !modeSetup && WiFi.status() == WL_CONNECTED && firebaseDimulai && Firebase.ready();
    if (!online) tambahAntrianLevel();   // offline: level dicatat ke flash tiap jam
  }
  if (sudahWaktunya(tStatus, 5000) && !sedangMemberiPakan) perluKirimStatus = true;
  if (tesRelayAktif && (long)(millis() - tesRelaySampai) >= 0) {
    tesRelayAktif = false;
    if (!sedangMemberiPakan) relayBlower(false);
    Serial.println("Tes relay selesai");
  }

  if (sedangMemberiPakan) {
    sapuArah();
    kelolaKatup();
    if (faseKatup == KATUP_DIAM &&
        millis() - waktuMulai >= (unsigned long)atur.durasiBlowerMs &&
        millis() - tKatupSelesai >= TIUP_SETELAH_TUTUP) {
      berhentiPakan();
    }
  }

  if (perluReboot && !sedangMemberiPakan) rebootSekarang();

  if (modeSetup) { jalankanModeSetup(); return; }

#ifndef MODE_WOKWI
  // WiFi putus: tunggu 5 detik (mungkin hanya gangguan sesaat), lalu langsung
  // pindai dan sambung ke WiFi tersimpan yang tersedia. Diulang tiap 20 detik.
  if (WiFi.status() != WL_CONNECTED) {
    if (tWifiPutus == 0) {
      tWifiPutus = millis();
      tCobaWifi = millis() - 15000UL;   // percobaan pertama 5 detik setelah putus
      Serial.println("WiFi terputus!");
    }
    if (!sedangMemberiPakan && millis() - tCobaWifi >= 20000UL) {
      if (streamDimulai) { Firebase.RTDB.endStream(&fbStream); Firebase.RTDB.removeStreamCallback(&fbStream); streamDimulai = false; }
      if (hubungkanTerbaik(10000)) {
        Serial.printf("Tersambung kembali ke \"%s\"\n", WiFi.SSID().c_str());
        wifiPesan = "Tersambung ke " + WiFi.SSID() + " setelah WiFi sebelumnya putus";
        perluKirimStatus = true;
      }
      tCobaWifi = millis();
    }
    return;   // tanpa WiFi, tugas Firebase dilewati
  }
  tWifiPutus = 0;
#endif

  // ----- Tugas Firebase -----
  if (!firebaseDimulai || !Firebase.ready()) return;

  if (!streamDimulai) {
    if (Firebase.RTDB.beginStream(&fbStream, PATH_KONTROL)) {
      Firebase.RTDB.setStreamCallback(&fbStream, streamCallback, streamTimeoutCallback);
      streamDimulai = true;
      adaPerubahanKontrol = true;
      Serial.println("Terhubung ke Firebase, mendengarkan perintah aplikasi");
    } else {
      Serial.printf("Gagal memulai stream: %s\n", fbStream.errorReason().c_str());
      delay(1000);
      return;
    }
  }

  if (perluKirimStatus) { perluKirimStatus = false; kirimStatus(); }

  if (sedangMemberiPakan) return;

  if (adaPerubahanKontrol && millis() - waktuBacaKontrol > 500) {
    adaPerubahanKontrol = false;
    waktuBacaKontrol = millis();
    bacaKontrol();
  }

#ifndef MODE_WOKWI
  if (perluOtaFirebase) { perluOtaFirebase = false; jalankanOtaFirebase(); return; }
#else
  perluOtaFirebase = false;
#endif
  if (perluSinkronWifi) { prosesSinkronWifi(); return; }
  if (unggahSsid.length() && kontrolPertamaDibaca) unggahWifiDariHotspot();
  if ((antrianPakan.jumlah || antrianLevel.jumlah) && (long)(millis() - tKirimAntrian) >= 0) {
    kirimAntrian();
    if ((long)(millis() - tKirimAntrian) >= 0) tKirimAntrian = millis() + 300UL;   // jeda antar kiriman
  }
  if (perluLogLevel) { perluLogLevel = false; kirimLogLevel(); }
  if (perluKirimLaporan) { perluKirimLaporan = false; kirimLaporan(); }
}
