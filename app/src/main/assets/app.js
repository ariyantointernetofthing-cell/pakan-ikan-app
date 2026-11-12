// =====================================================================
//  Logika aplikasi Pakan Ikan (Firebase Realtime Database)  v3.5
// =====================================================================
const ROOT = "pakanIkan";
const BATAS_OFFLINE_MS = 20000;
const NAMA_HARI = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]; // bit 0 = Senin
const NAMA_HARI_JS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"]; // getDay()
const KUNCI_EMAIL = "pakanIkan.email";
const KUNCI_INGAT = "pakanIkan.ingat";
const SIMPAN_RIWAYAT_HARI = 60;   // data riwayat lebih tua dari ini dihapus otomatis oleh admin

const $ = (id) => document.getElementById(id);
// Tulis teks hanya jika berubah (mengurangi kerja browser, aplikasi lebih ringan)
const teks = (id, nilai) => { const el = $(id); if (el && el.textContent !== nilai) el.textContent = nilai; };
const dua = (n) => String(n).padStart(2, "0");

function tampilkan(idLayar) {
  ["layarMuat", "layarGagal", "layarLogin", "layarUtama"].forEach((id) => {
    $(id).classList.toggle("tersembunyi", id !== idLayar);
  });
}
function simpanLokal(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function bacaLokal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

if (typeof firebase === "undefined") {
  tampilkan("layarGagal");
  throw new Error("Firebase SDK gagal dimuat");
}

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();
const EMAIL_ADMIN_KECIL = String(typeof EMAIL_ADMIN !== "undefined" ? EMAIL_ADMIN : "").trim().toLowerCase();

let selisihJamServer = 0;
let updateTerakhirAlat = 0;
let statusAlat = {};
let pendengar = [];
let pendengarRiwayat = [];
let menungguAlat = false;
let peran = null;
let dataJadwal = {};
let rentangJam = 24;
let animasiSampai = 0;     // animasi ikan makan tetap jalan sampai waktu ini (ms)
let pengaturanAlat = {};   // salinan /kontrol/pengaturan untuk lama animasi
let daftarWifiApp = [];    // daftar WiFi dari /wifiAlat/daftar
let pesanWifiLokal = "";   // pesan terakhir dari aksi tambah/hapus WiFi

db.ref(".info/serverTimeOffset").on("value", (s) => { selisihJamServer = s.val() || 0; });
const jamServer = () => Date.now() + selisihJamServer;
const detikServer = () => Math.floor(jamServer() / 1000);

const NAMA_BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const NAMA_HARI_PANJANG = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const NAMA_BULAN_PANJANG = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

// Contoh: "Jum, 13 Nov 2026 · 07:00"
function formatWaktu(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  return `${NAMA_HARI_JS[d.getDay()]}, ${d.getDate()} ${NAMA_BULAN[d.getMonth()]} ${d.getFullYear()} · ${dua(d.getHours())}:${dua(d.getMinutes())}`;
}

function zonaWaktu() {
  const off = -new Date().getTimezoneOffset() / 60;
  if (off === 7) return "WIB";
  if (off === 8) return "WITA";
  if (off === 9) return "WIT";
  return "UTC" + (off >= 0 ? "+" : "") + off;
}

function lamaWaktu(detik) {
  if (typeof detik !== "number" || detik < 0) return "-";
  if (detik < 60) return `${Math.floor(detik)} dtk`;
  const m = Math.floor(detik / 60), j = Math.floor(m / 60), h = Math.floor(j / 24);
  if (h > 0) return `${h}h ${j % 24}j`;
  if (j > 0) return `${j}j ${m % 60}m`;
  return `${m} mnt`;
}

// ---------- Jam dan tanggal di bagian atas ----------
function perbaruiJam() {
  const d = new Date(jamServer());
  teks("jamSekarang", `${dua(d.getHours())}:${dua(d.getMinutes())}`);
  teks("detikSekarang", `:${dua(d.getSeconds())}`);
  teks("zonaWaktu", zonaWaktu());
  teks("tanggalSekarang", `${NAMA_HARI_PANJANG[d.getDay()]}, ${d.getDate()} ${NAMA_BULAN_PANJANG[d.getMonth()]} ${d.getFullYear()}`);
}
setInterval(perbaruiJam, 1000);

const PESAN_ERROR = {
  "auth/invalid-email": "Format email salah.",
  "auth/user-not-found": "Akun tidak ditemukan.",
  "auth/wrong-password": "Password salah.",
  "auth/invalid-credential": "Email atau password salah.",
  "auth/invalid-login-credentials": "Email atau password salah.",
  "auth/too-many-requests": "Terlalu banyak percobaan. Tunggu sebentar.",
  "auth/network-request-failed": "Tidak ada koneksi internet.",
  "auth/operation-not-allowed": "Login Email/Password belum diaktifkan di Firebase.",
  "auth/admin-restricted-operation": "Pendaftaran akun dimatikan di Firebase. Aktifkan lagi 'Enable create (sign-up)'.",
  "auth/email-already-in-use": "Email sudah terdaftar.",
  "auth/weak-password": "Password minimal 6 karakter.",
  "auth/requires-recent-login": "Silakan keluar lalu masuk lagi, kemudian ulangi.",
};
const terjemah = (err) => PESAN_ERROR[err && err.code] || `Gagal (${(err && (err.code || err.message)) || "tidak diketahui"})`;

// Tombol dua kali tekan untuk aksi berbahaya
function tombolYakin(btn, teksAsli, aksi) {
  if (btn.dataset.yakin !== "1") {
    btn.dataset.yakin = "1";
    btn.textContent = "Tekan lagi untuk yakin";
    setTimeout(() => { btn.dataset.yakin = ""; btn.textContent = teksAsli; }, 4000);
    return;
  }
  btn.dataset.yakin = "";
  btn.textContent = teksAsli;
  aksi();
}

// =====================================================================
//  LOGIN
// =====================================================================
(function isiLoginTersimpan() {
  const email = bacaLokal(KUNCI_EMAIL);
  if (email) $("inEmail").value = email;
  const ingat = bacaLokal(KUNCI_INGAT);
  if (ingat !== null) $("inIngat").checked = ingat === "1";
})();

$("formLogin").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pesanLogin").textContent = "";
  $("btnLogin").disabled = true;
  $("btnLogin").textContent = "Memproses...";
  const ingat = $("inIngat").checked;
  const email = $("inEmail").value.trim();
  try {
    await auth.setPersistence(ingat ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION);
    await auth.signInWithEmailAndPassword(email, $("inPassword").value);
    simpanLokal(KUNCI_INGAT, ingat ? "1" : "0");
    simpanLokal(KUNCI_EMAIL, ingat ? email : "");
    $("inPassword").value = "";
  } catch (err) {
    $("pesanLogin").textContent = terjemah(err);
  } finally {
    $("btnLogin").disabled = false;
    $("btnLogin").textContent = "Masuk";
  }
});

$("btnKeluar").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (user) => {
  lepasSemuaPendengar();
  lepasPendengarRiwayat();
  peran = null;
  if (!user) { tampilkan("layarLogin"); return; }
  tampilkan("layarMuat");

  const email = (user.email || "").toLowerCase();
  let nama = user.email;
  if (EMAIL_ADMIN_KECIL && email === EMAIL_ADMIN_KECIL) {
    peran = "admin";
  } else {
    try {
      const s = await db.ref(`pengguna/${user.uid}`).once("value");
      if (s.exists()) { peran = "pengguna"; nama = s.val().nama || user.email; }
    } catch (err) { /* ditolak Rules */ }
  }

  if (!peran) {
    await auth.signOut();
    tampilkan("layarLogin");
    $("pesanLogin").textContent = "Akun ini belum diberi akses. Minta admin menambahkan kamu di menu Pengaturan.";
    return;
  }

  $("namaPengguna").textContent = nama;
  $("peranPengguna").textContent = peran === "admin" ? "Admin" : "Pengguna";
  $("teksEmailSaya").textContent = user.email;
  document.querySelectorAll(".hanya-admin").forEach((el) => el.classList.toggle("tersembunyi", peran !== "admin"));

  tampilkan("layarUtama");
  perbaruiJam();
  pilihTab("tabBeranda");
  mulaiDashboard();
  if (peran === "admin") mulaiAdmin();
});

function dengar(ref, event, fn, daftar = pendengar) {
  ref.on(event, fn, (err) => {
    console.error(err);
    if (err && err.code === "PERMISSION_DENIED") {
      $("pesanPakan").textContent = "Akses ditolak oleh Rules Firebase. Pasang Rules versi terbaru.";
    }
  });
  daftar.push(() => ref.off(event, fn));
}
function lepasSemuaPendengar() { pendengar.forEach((f) => f()); pendengar = []; }
function lepasPendengarRiwayat() { pendengarRiwayat.forEach((f) => f()); pendengarRiwayat = []; }

// =====================================================================
//  TAB
// =====================================================================
let riwayatSudahDimuat = false;
// Jeda animasi akuarium saat tidak terlihat (tab lain, digulir keluar layar, aplikasi di latar)
let akuariumTerlihat = true;
function aturJedaAkuarium() {
  const tampil = akuariumTerlihat && !document.hidden && !$("tabBeranda").classList.contains("tersembunyi");
  $("akuarium").classList.toggle("jeda", !tampil);
}
if ("IntersectionObserver" in window) {
  new IntersectionObserver((e) => { akuariumTerlihat = e[0].isIntersecting; aturJedaAkuarium(); }).observe($("akuarium"));
}
document.addEventListener("visibilitychange", aturJedaAkuarium);

function pilihTab(id) {
  document.querySelectorAll(".isi-tab").forEach((el) => el.classList.toggle("tersembunyi", el.id !== id));
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("aktif", b.dataset.tab === id));
  window.scrollTo(0, 0);
  if (id === "tabRiwayat" && !riwayatSudahDimuat) { riwayatSudahDimuat = true; muatRiwayat(); }
  aturJedaAkuarium();
}
document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => pilihTab(b.dataset.tab)));

// =====================================================================
//  BERANDA
// =====================================================================
function mulaiDashboard() {
  riwayatSudahDimuat = false;

  dengar(db.ref(`${ROOT}/status`), "value", (s) => {
    statusAlat = s.val() || {};
    updateTerakhirAlat = statusAlat.update || 0;
    tampilkanStatus();
  });

  // Setiap pemberian pakan baru (tombol aplikasi, jadwal, atau tombol fisik)
  // memicu animasi ikan menyambar pakan
  dengar(db.ref(`${ROOT}/riwayat`).limitToLast(1), "child_added", (s) => {
    const r = s.val() || {};
    if (r.waktu && jamServer() - r.waktu < 20000) {
      const lama = Math.max(6000, (pengaturanAlat.durasiBlowerMs || 4000) + 2000);
      animasiSampai = Math.max(animasiSampai, Date.now() + lama);
      tampilkanStatus();
    }
  });

  dengar(db.ref(`${ROOT}/laporan`), "value", (s) => {
    const l = s.val();
    $("teksLaporan").textContent = l && l.pesan ? l.pesan : "Belum ada laporan.";
    $("waktuLaporan").textContent = l && l.waktu ? `Dikirim ${formatWaktu(l.waktu)}` : "";
  });

  dengar(db.ref(`${ROOT}/kontrol/jadwal`), "value", (s) => {
    dataJadwal = s.val() || {};
    tampilkanJadwal();
    tampilkanJadwalBerikut();
  });
}

function alatOnline() {
  return updateTerakhirAlat > 0 && jamServer() - updateTerakhirAlat < BATAS_OFFLINE_MS;
}

function kualitasSinyal(rssi) {
  if (typeof rssi !== "number" || rssi === 0) return { label: "-", bar: 0 };
  if (rssi >= -55) return { label: "Sangat kuat", bar: 4 };
  if (rssi >= -60) return { label: "Kuat", bar: 3 };
  if (rssi >= -72) return { label: "Sedang", bar: 2 };
  return { label: "Lemah", bar: 1 };
}

function tampilkanStatus() {
  const st = statusAlat;
  const online = alatOnline();

  const badge = $("badgeKoneksi");
  badge.textContent = online ? "● Alat online" : "● Alat offline";
  if (badge.className !== "badge " + (online ? "online" : "offline")) badge.className = "badge " + (online ? "online" : "offline");

  const q = online ? kualitasSinyal(st.rssi) : { label: "-", bar: 0 };
  const barSinyal = document.querySelector("#badgeSinyal .bar-sinyal");
  if (barSinyal.className !== "bar-sinyal s" + q.bar) barSinyal.className = "bar-sinyal s" + q.bar;
  teks("teksSinyalKepala", online && st.rssi ? `${st.rssi} dBm` : "-");

  const level = typeof st.level === "number" ? st.level : -1;
  const cincin = $("cincinLevel");
  const kunciCincin = level + "";
  if (cincin.dataset.level !== kunciCincin) {
    cincin.dataset.level = kunciCincin;
    cincin.style.setProperty("--persen", level >= 0 ? level : 0);
    cincin.style.setProperty("--warna",
      level < 0 ? "rgba(255,255,255,.15)" : level <= 20 ? "var(--merah)" : level <= 50 ? "var(--kuning)" : "var(--toska)");
  }
  teks("teksLevel", level >= 0 ? `${level}%` : "--%");

  const jarakAda = typeof st.jarak === "number" && st.jarak >= 0;
  teks("teksJarak", jarakAda ? `Jarak sensor: ${st.jarak} cm` : "Jarak sensor: belum terbaca");
  teks("kalJarakSekarang", jarakAda ? `${st.jarak} cm` : "-- cm");
  teks("teksStatus", online ? (st.statusPakan || "-") : "Alat tidak terhubung");
  teks("teksTerakhir", st.terakhir || "-");
  teks("teksFirmware", st.firmware ? `v${st.firmware}` : "v2 atau lebih lama");
  teks("teksIpAlat", st.ip && st.ip !== "0.0.0.0" ? st.ip : "-");
  if (!ipOtaDiubah && st.ip && st.ip !== "0.0.0.0" && $("inIpOta").value !== st.ip) $("inIpOta").value = st.ip;

  teks("teksWifi", online ? (st.wifi || "-") : `Offline (terakhir: ${st.wifi || "-"})`);
  teks("teksSinyal", online && st.rssi ? `${q.label} (${st.rssi} dBm)` : "-");
  tampilkanDaftarWifi();

  // Info kecil
  teks("miniSinyal", online ? q.label : "-");
  teks("miniUptime", online && typeof st.uptime === "number" ? lamaWaktu(st.uptime) : "-");
  teks("miniUpdate", updateTerakhirAlat ? `${lamaWaktu((jamServer() - updateTerakhirAlat) / 1000)} lalu` : "-");

  // Akuarium: ikan makan saat alat memberi pakan
  const makan = (st.sedangMemberi && online) || Date.now() < animasiSampai;
  if ($("akuarium").classList.contains("makan") !== makan) $("akuarium").classList.toggle("makan", makan);
  teks("labelAkuarium", makan ? "Pakan sedang keluar..." : online ? "Ikan sedang berenang" : "Alat offline");

  const btn = $("btnPakan");
  if (st.sedangMemberi && online) {
    btn.disabled = true;
    btn.textContent = "SEDANG MEMBERI PAKAN...";
    teks("pesanPakan", "");
    menungguAlat = false;
  } else if (menungguAlat) {
    btn.disabled = true;
    btn.textContent = "MENUNGGU ALAT...";
  } else {
    btn.disabled = false;
    btn.textContent = "BERI PAKAN SEKARANG";
  }
  if (!online && !updateTerakhirAlat) {
    teks("pesanPakan", "Alat belum pernah terhubung. Pastikan ESP32 menyala dan terhubung WiFi.");
  }
}

setInterval(() => {
  if (!$("layarUtama").classList.contains("tersembunyi")) tampilkanStatus();
}, 1000);
setInterval(() => { if (Object.keys(dataJadwal || {}).length) tampilkanJadwalBerikut(); }, 15000);

async function kirimBeriPakan(elPesan) {
  if (!alatOnline()) { elPesan.textContent = "Alat sedang offline. Perintah tidak dikirim."; return; }
  menungguAlat = true;
  animasiSampai = Date.now() + 6000;
  tampilkanStatus();
  elPesan.textContent = "Perintah terkirim, menunggu alat...";
  try {
    await db.ref(`${ROOT}/kontrol`).update({ beriPakan: true, waktuPerintah: detikServer() });
  } catch (err) {
    menungguAlat = false;
    elPesan.textContent = "Gagal mengirim perintah: " + err.message;
  }
  setTimeout(() => {
    if (menungguAlat) {
      menungguAlat = false;
      elPesan.textContent = "Alat tidak merespons. Cek koneksi ESP32.";
      tampilkanStatus();
    }
  }, 10000);
}
$("btnPakan").addEventListener("click", () => kirimBeriPakan($("pesanPakan")));

// =====================================================================
//  JADWAL (jumlah bebas)
// =====================================================================
function buatPilihanHari(wadah, mask) {
  wadah.innerHTML = "";
  NAMA_HARI.forEach((nama, bit) => {
    const lbl = document.createElement("label");
    lbl.innerHTML = `<input type="checkbox" data-bit="${bit}"><span>${nama}</span>`;
    lbl.querySelector("input").checked = (mask & (1 << bit)) !== 0;
    wadah.appendChild(lbl);
  });
}
function bacaPilihanHari(wadah) {
  let h = 0;
  wadah.querySelectorAll("input").forEach((cb) => { if (cb.checked) h |= 1 << Number(cb.dataset.bit); });
  if (h === 0) { h = 127; wadah.querySelectorAll("input").forEach((cb) => (cb.checked = true)); }
  return h;
}

function urutanJadwal(data) {
  return Object.entries(data)
    .filter(([, j]) => j && typeof j === "object")
    .sort(([, a], [, b]) => ((a.jam || 0) * 60 + (a.menit || 0)) - ((b.jam || 0) * 60 + (b.menit || 0)));
}

function buatRingkas(data) {
  return urutanJadwal(data)
    .map(([, j]) => `${j.aktif ? 1 : 0},${j.jam || 0},${j.menit || 0},${j.hari || 127}`)
    .join(";");
}

function tampilkanJadwal() {
  const wadah = $("daftarJadwal");
  wadah.innerHTML = "";
  const daftar = urutanJadwal(dataJadwal);
  if (daftar.length === 0) {
    wadah.innerHTML = `<div class="kartu redup">Belum ada jadwal. Tekan "+ Tambah jadwal".</div>`;
    return;
  }
  const tpl = $("templateJadwal");
  daftar.forEach(([kunci, j], idx) => {
    const kartu = tpl.content.firstElementChild.cloneNode(true);
    kartu.dataset.kunci = kunci;
    kartu.querySelector(".judul-jadwal").textContent = `Jadwal ${idx + 1}`;
    kartu.querySelector(".jAktif").checked = !!j.aktif;
    kartu.classList.toggle("mati", !j.aktif);
    kartu.querySelector(".jWaktu").value = `${dua(j.jam || 0)}:${dua(j.menit || 0)}`;
    buatPilihanHari(kartu.querySelector(".hari"), j.hari || 127);
    kartu.querySelector(".jSimpan").addEventListener("click", () => simpanJadwal(kartu));
    kartu.querySelector(".jAktif").addEventListener("change", () => simpanJadwal(kartu));
    const hapus = kartu.querySelector(".jHapus");
    hapus.addEventListener("click", () => tombolYakin(hapus, "Hapus", () => hapusJadwal(kunci)));
    wadah.appendChild(kartu);
  });
}

// Cari pemberian pakan terjadwal berikutnya (7 hari ke depan)
function tampilkanJadwalBerikut() {
  const aktif = Object.values(dataJadwal || {}).filter((j) => j && j.aktif);
  const el = $("jadwalBerikut");
  if (!aktif.length) { el.classList.add("tersembunyi"); return; }
  const kini = new Date(jamServer());
  let terdekat = null;
  for (let tambahHari = 0; tambahHari <= 7 && !terdekat; tambahHari++) {
    const hari = new Date(kini.getFullYear(), kini.getMonth(), kini.getDate() + tambahHari);
    const bit = (hari.getDay() + 6) % 7;  // Senin = 0
    aktif.forEach((j) => {
      if (!((j.hari || 127) & (1 << bit))) return;
      const t = new Date(hari.getFullYear(), hari.getMonth(), hari.getDate(), j.jam || 0, j.menit || 0);
      if (t > kini && (!terdekat || t < terdekat)) terdekat = t;
    });
  }
  if (!terdekat) { el.classList.add("tersembunyi"); return; }
  const selisih = Math.round((terdekat - kini) / 60000);
  const hariIni = terdekat.toDateString() === kini.toDateString();
  const label = hariIni ? "hari ini" : NAMA_HARI_PANJANG[terdekat.getDay()];
  $("teksJadwalBerikut").textContent =
    `${label} ${dua(terdekat.getHours())}:${dua(terdekat.getMinutes())} (${lamaWaktu(selisih * 60)} lagi)`;
  el.classList.remove("tersembunyi");
}

async function tulisJadwal(kunci, nilai) {
  const baru = Object.assign({}, dataJadwal);
  if (nilai === null) delete baru[kunci]; else baru[kunci] = nilai;
  await db.ref(`${ROOT}/kontrol`).update({
    [`jadwal/${kunci}`]: nilai,
    jadwalRingkas: buatRingkas(baru),
  });
}

async function simpanJadwal(kartu) {
  const pesan = kartu.querySelector(".jPesan");
  const waktu = kartu.querySelector(".jWaktu").value || "00:00";
  const [jam, menit] = waktu.split(":").map(Number);
  const hari = bacaPilihanHari(kartu.querySelector(".hari"));
  const aktif = kartu.querySelector(".jAktif").checked;
  pesan.textContent = "Menyimpan...";
  try {
    await tulisJadwal(kartu.dataset.kunci, { aktif, jam, menit, hari });
  } catch (err) {
    pesan.textContent = "Gagal: " + err.message;
  }
}

async function hapusJadwal(kunci) {
  try { await tulisJadwal(kunci, null); } catch (err) { $("pesanPakan").textContent = "Gagal menghapus jadwal: " + err.message; }
}

$("btnTambahJadwal").addEventListener("click", async () => {
  const kunci = db.ref(`${ROOT}/kontrol/jadwal`).push().key;
  try {
    await tulisJadwal(kunci, { aktif: false, jam: 12, menit: 0, hari: 127 });
    setTimeout(() => {
      const el = document.querySelector(`.jadwal[data-kunci="${kunci}"]`);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.querySelector(".jPesan").textContent = "Jadwal baru: atur jam, aktifkan, lalu Simpan."; }
    }, 300);
  } catch (err) {
    $("pesanPakan").textContent = "Gagal menambah jadwal: " + err.message;
  }
});

// =====================================================================
//  RIWAYAT (grafik dan daftar)
// =====================================================================
document.querySelectorAll(".rentang-btn").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".rentang-btn").forEach((x) => x.classList.toggle("aktif", x === b));
  rentangJam = Number(b.dataset.jam);
  muatRiwayat();
}));

function muatRiwayat() {
  lepasPendengarRiwayat();
  const mulai = jamServer() - rentangJam * 3600 * 1000;
  ["grafikPakan", "grafikLevel", "grafikSinyal"].forEach((id) => ($(id).innerHTML = `<div class="kosong">Memuat...</div>`));

  dengar(db.ref(`${ROOT}/riwayat`).orderByChild("waktu").startAt(mulai), "value", (s) => {
    const data = [];
    s.forEach((a) => { const v = a.val(); if (v && v.waktu) data.push(v); });
    tampilkanRiwayatPakan(data, mulai);
  }, pendengarRiwayat);

  dengar(db.ref(`${ROOT}/riwayatLevel`).orderByChild("waktu").startAt(mulai), "value", (s) => {
    const data = [];
    s.forEach((a) => { const v = a.val(); if (v && v.waktu) data.push(v); });
    tampilkanRiwayatLevel(data, mulai);
  }, pendengarRiwayat);
}

function labelEmber(ms, perJam) {
  const d = new Date(ms);
  if (perJam) return dua(d.getHours());
  return `${NAMA_HARI_JS[d.getDay()]} ${d.getDate()}`;
}

function tampilkanRiwayatPakan(data, mulai) {
  const perJam = rentangJam <= 24;
  const lebar = perJam ? 3600e3 : 86400e3;
  // Ember (bucket) dimulai dari awal jam / awal hari lokal
  const awal = new Date(mulai);
  if (perJam) awal.setMinutes(0, 0, 0); else awal.setHours(0, 0, 0, 0);
  const jumlahEmber = perJam ? 25 : Math.round(rentangJam / 24) + 1;
  const ember = Array.from({ length: jumlahEmber }, (_, i) => ({ t: awal.getTime() + i * lebar, n: 0 }));
  data.forEach((r) => {
    const i = Math.floor((r.waktu - awal.getTime()) / lebar);
    if (i >= 0 && i < ember.length) ember[i].n++;
  });

  $("rkPakanTotal").textContent = `${data.length}x`;
  $("rkPakanRata").textContent = `${(data.length / Math.max(rentangJam / 24, 1)).toFixed(1)}x`;

  if (data.length === 0) {
    $("grafikPakan").innerHTML = `<div class="kosong">Belum ada pemberian pakan di rentang ini.</div>`;
  } else {
    $("grafikPakan").innerHTML = grafikBatang(ember.map((e) => labelEmber(e.t, perJam)), ember.map((e) => e.n));
  }

  const ul = $("daftarRiwayat");
  ul.innerHTML = "";
  const urut = data.slice().sort((a, b) => b.waktu - a.waktu);
  if (urut.length === 0) { ul.innerHTML = `<li class="redup">Belum ada riwayat.</li>`; return; }
  urut.slice(0, 100).forEach((r) => {
    const li = document.createElement("li");
    const kiri = document.createElement("span");
    const kanan = document.createElement("span");
    kiri.textContent = formatWaktu(r.waktu);
    kanan.textContent = (r.sumber || "-") + (typeof r.level === "number" && r.level >= 0 ? ` · sisa ${r.level}%` : "");
    kanan.className = "redup";
    li.append(kiri, kanan);
    ul.appendChild(li);
  });
  if (urut.length > 100) {
    const li = document.createElement("li");
    li.className = "redup kecil";
    li.textContent = `dan ${urut.length - 100} lainnya`;
    ul.appendChild(li);
  }
}

function tampilkanRiwayatLevel(data, mulai) {
  data.sort((a, b) => a.waktu - b.waktu);
  const sampai = jamServer();
  const level = data.filter((r) => typeof r.level === "number" && r.level >= 0);

  if (level.length) {
    const nilai = level.map((r) => r.level);
    $("rkLevelSekarang").textContent = `${nilai[nilai.length - 1]}%`;
    $("rkLevelMin").textContent = `${Math.min(...nilai)}%`;
    $("rkLevelMax").textContent = `${Math.max(...nilai)}%`;
    $("grafikLevel").innerHTML = grafikGaris(level.map((r) => ({ t: r.waktu, v: r.level })), mulai, sampai,
      { min: 0, max: 100, satuan: "%", warna: "#3FD6CF", isi: true });
  } else {
    ["rkLevelSekarang", "rkLevelMin", "rkLevelMax"].forEach((id) => ($(id).textContent = "-"));
    $("grafikLevel").innerHTML = `<div class="kosong">Belum ada catatan isi wadah di rentang ini.</div>`;
  }

  const sinyal = data.filter((r) => typeof r.rssi === "number" && r.rssi < 0);
  if (sinyal.length) {
    const nilai = sinyal.map((r) => r.rssi);
    const bawah = Math.min(-90, Math.floor(Math.min(...nilai) / 10) * 10);
    $("grafikSinyal").innerHTML = grafikGaris(sinyal.map((r) => ({ t: r.waktu, v: r.rssi })), mulai, sampai,
      { min: bawah, max: -30, satuan: " dBm", warna: "#FFD45C", isi: false, garisBantu: [-60, -72] });
  } else {
    $("grafikSinyal").innerHTML = `<div class="kosong">Belum ada catatan sinyal di rentang ini.</div>`;
  }

  const ul = $("daftarLevel");
  ul.innerHTML = "";
  const urut = data.slice().reverse();
  if (urut.length === 0) { ul.innerHTML = `<li class="redup">Belum ada catatan.</li>`; return; }
  urut.slice(0, 60).forEach((r) => {
    const li = document.createElement("li");
    const kiri = document.createElement("span");
    const kanan = document.createElement("span");
    kiri.textContent = formatWaktu(r.waktu);
    const bagian = [];
    if (typeof r.level === "number") bagian.push(`${r.level}%`);
    if (typeof r.jarak === "number") bagian.push(`${r.jarak} cm`);
    if (typeof r.rssi === "number") bagian.push(`${r.rssi} dBm`);
    kanan.textContent = bagian.join(" · ");
    kanan.className = "redup";
    li.append(kiri, kanan);
    ul.appendChild(li);
  });
}

// ---------- Grafik SVG sederhana ----------
function grafikBatang(label, nilai) {
  const W = 340, H = 170, kiri = 26, bawah = 22, atas = 10;
  const maks = Math.max(1, ...nilai);
  const lebarBatang = (W - kiri - 4) / nilai.length;
  const tinggi = H - bawah - atas;
  const langkahLabel = Math.ceil(nilai.length / 8);
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui" font-size="9">`;
  (maks >= 4 ? [0, 0.5, 1] : [0, 1]).forEach((f) => {
    const y = atas + tinggi * (1 - f);
    svg += `<line x1="${kiri}" x2="${W}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.08)"/>`;
    svg += `<text x="${kiri - 4}" y="${y + 3}" text-anchor="end" fill="#8DB2BE">${Math.round(maks * f)}</text>`;
  });
  nilai.forEach((n, i) => {
    const h = (n / maks) * tinggi;
    const x = kiri + i * lebarBatang + 1;
    if (n > 0) svg += `<rect x="${x}" y="${atas + tinggi - h}" width="${Math.max(lebarBatang - 2, 1)}" height="${h}" rx="2" fill="#3FD6CF"><title>${label[i]}: ${n}x</title></rect>`;
    if (i % langkahLabel === 0) svg += `<text x="${x + lebarBatang / 2}" y="${H - 6}" text-anchor="middle" fill="#8DB2BE">${label[i]}</text>`;
  });
  return svg + `</svg>`;
}

function grafikGaris(titik, tMin, tMax, o) {
  const W = 340, H = 170, kiri = 34, bawah = 22, atas = 10, kanan = 6;
  const lebar = W - kiri - kanan, tinggi = H - bawah - atas;
  const x = (t) => kiri + ((t - tMin) / Math.max(tMax - tMin, 1)) * lebar;
  const y = (v) => atas + (1 - (Math.min(Math.max(v, o.min), o.max) - o.min) / (o.max - o.min)) * tinggi;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui" font-size="9">`;
  [0, 0.5, 1].forEach((f) => {
    const v = o.min + (o.max - o.min) * f;
    svg += `<line x1="${kiri}" x2="${W - kanan}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,.08)"/>`;
    svg += `<text x="${kiri - 4}" y="${y(v) + 3}" text-anchor="end" fill="#8DB2BE">${Math.round(v)}${o.satuan.trim() === "%" ? "%" : ""}</text>`;
  });
  (o.garisBantu || []).forEach((v) => {
    svg += `<line x1="${kiri}" x2="${W - kanan}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,107,107,.6)" stroke-dasharray="4 3"/>`;
  });
  [0, 0.5, 1].forEach((f) => {
    const t = tMin + (tMax - tMin) * f;
    const d = new Date(t);
    const teks = rentangJam <= 24 ? `${dua(d.getHours())}:${dua(d.getMinutes())}` : `${d.getDate()}/${d.getMonth() + 1}`;
    svg += `<text x="${x(t)}" y="${H - 6}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}" fill="#8DB2BE">${teks}</text>`;
  });
  // Pisahkan garis jika ada jeda data lebih dari 1 jam (alat mati)
  const potongan = [];
  let kini = [];
  titik.forEach((p, i) => {
    if (i > 0 && p.t - titik[i - 1].t > 3600e3) { potongan.push(kini); kini = []; }
    kini.push(p);
  });
  if (kini.length) potongan.push(kini);
  potongan.forEach((pot) => {
    const d = pot.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    if (o.isi && pot.length > 1) {
      svg += `<path d="${d} L${x(pot[pot.length - 1].t).toFixed(1)},${y(o.min)} L${x(pot[0].t).toFixed(1)},${y(o.min)} Z" fill="${o.warna}" opacity=".15"/>`;
    }
    svg += `<path d="${d}" fill="none" stroke="${o.warna}" stroke-width="2" stroke-linejoin="round"/>`;
    if (pot.length === 1) svg += `<circle cx="${x(pot[0].t)}" cy="${y(pot[0].v)}" r="2.5" fill="${o.warna}"/>`;
  });
  const akhir = titik[titik.length - 1];
  svg += `<circle cx="${x(akhir.t)}" cy="${y(akhir.v)}" r="3.5" fill="${o.warna}"><title>${akhir.v}${o.satuan}</title></circle>`;
  return svg + `</svg>`;
}

// =====================================================================
//  PENGATURAN: AKUN SAYA
// =====================================================================
$("formPassword").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pesan = $("pesanPassword");
  const user = auth.currentUser;
  if (!user) return;
  pesan.textContent = "Menyimpan...";
  try {
    const kredensial = firebase.auth.EmailAuthProvider.credential(user.email, $("inPassLama").value);
    await user.reauthenticateWithCredential(kredensial);
    await user.updatePassword($("inPassBaruSaya").value);
    $("inPassLama").value = "";
    $("inPassBaruSaya").value = "";
    pesan.textContent = "Password berhasil diganti.";
  } catch (err) {
    pesan.textContent = err.code === "auth/invalid-credential" || err.code === "auth/wrong-password"
      ? "Password lama salah." : terjemah(err);
  }
});

// =====================================================================
//  PENGATURAN ADMIN
// =====================================================================
const PENGATURAN_BAWAAN = {
  sudutBuka: 90, sudutTutup: 0, kecepatan: 10, durasiBukaMs: 1000,
  durasiBlowerMs: 4000, arahMin: 45, arahMax: 135, arahKecepatan: 7,
  penuhMm: 30, kosongMm: 250, reboot: { aktif: false, jam: 3, menit: 0, hari: 127 },
};

function mulaiAdmin() {
  // Pengaturan alat
  db.ref(`${ROOT}/kontrol/pengaturan`).once("value").then((s) => isiPengaturan(Object.assign({}, PENGATURAN_BAWAAN, s.val() || {})));
  dengar(db.ref(`${ROOT}/kontrol/pengaturan`), "value", (s) => { pengaturanAlat = s.val() || {}; });

  // Daftar WiFi
  dengar(db.ref("wifiAlat/daftar"), "value", (s) => {
    const v = s.val();
    daftarWifiApp = (Array.isArray(v) ? v : Object.values(v || {})).filter((w) => w && w.ssid);
    tampilkanDaftarWifi();
  });

  // Ringkasan jadwal untuk alat (sekali, jika belum ada atau jadwal lama j1/j2/j3)
  db.ref(`${ROOT}/kontrol`).once("value").then((s) => {
    const k = s.val() || {};
    const ringkas = buatRingkas(k.jadwal || {});
    if (k.jadwalRingkas !== ringkas) db.ref(`${ROOT}/kontrol/jadwalRingkas`).set(ringkas);
  }).catch(() => {});

  // Bersihkan riwayat lama
  bersihkanRiwayatLama("riwayat");
  bersihkanRiwayatLama("riwayatLevel");

  // Daftar pengguna
  dengar(db.ref("pengguna"), "value", (s) => {
    const ul = $("daftarPengguna");
    ul.innerHTML = "";
    const liAdmin = document.createElement("li");
    liAdmin.className = "pengguna";
    liAdmin.innerHTML = `<div class="teks"><div><b>Admin (pemilik)</b></div><div class="redup kecil"></div></div>`;
    liAdmin.querySelector(".redup").textContent = EMAIL_ADMIN_KECIL;
    ul.appendChild(liAdmin);

    s.forEach((anak) => {
      const p = anak.val() || {};
      const li = document.createElement("li");
      li.className = "pengguna";
      const teks = document.createElement("div");
      teks.className = "teks";
      const b = document.createElement("div");
      b.innerHTML = "<b></b>";
      b.querySelector("b").textContent = p.nama || "(tanpa nama)";
      const em = document.createElement("div");
      em.className = "redup kecil";
      em.textContent = p.email || anak.key;
      teks.append(b, em);
      const btn = document.createElement("button");
      btn.className = "tombol cabut";
      btn.textContent = "Cabut akses";
      btn.addEventListener("click", () => tombolYakin(btn, "Cabut akses", async () => {
        btn.disabled = true;
        try { await db.ref(`pengguna/${anak.key}`).remove(); } catch (err) { btn.disabled = false; }
      }));
      li.append(teks, btn);
      ul.appendChild(li);
    });
    if (!s.exists()) {
      const li = document.createElement("li");
      li.className = "redup kecil";
      li.textContent = "Belum ada pengguna lain.";
      ul.appendChild(li);
    }
  });
}

async function bersihkanRiwayatLama(nama) {
  try {
    const batas = jamServer() - SIMPAN_RIWAYAT_HARI * 86400e3;
    const s = await db.ref(`${ROOT}/${nama}`).orderByChild("waktu").endAt(batas).limitToFirst(500).once("value");
    if (!s.exists()) return;
    const hapus = {};
    s.forEach((a) => { hapus[a.key] = null; });
    await db.ref(`${ROOT}/${nama}`).update(hapus);
  } catch (e) { /* abaikan */ }
}

function isiPengaturan(p) {
  $("inSudutBuka").value = p.sudutBuka;
  $("inSudutTutup").value = p.sudutTutup;
  $("inKecepatan").value = p.kecepatan;
  $("inDurasi").value = (p.durasiBukaMs / 1000).toFixed(1);
  $("inPenuh").value = (p.penuhMm / 10).toFixed(1);
  $("inHabis").value = (p.kosongMm / 10).toFixed(1);
  const rb = Object.assign({}, PENGATURAN_BAWAAN.reboot, p.reboot || {});
  $("inRbAktif").checked = !!rb.aktif;
  $("inRbWaktu").value = `${dua(rb.jam)}:${dua(rb.menit)}`;
  buatPilihanHari($("hariReboot"), rb.hari || 127);
  $("inDurasiBlower").value = (p.durasiBlowerMs / 1000).toFixed(1);
  $("inArahMin").value = p.arahMin;
  $("inArahMax").value = p.arahMax;
  $("inArahKecepatan").value = p.arahKecepatan;
  perbaruiLabelKatup();
}

function perbaruiLabelKatup() {
  $("vSudutBuka").textContent = $("inSudutBuka").value;
  $("vSudutTutup").textContent = $("inSudutTutup").value;
  $("vKecepatan").textContent = $("inKecepatan").value;
  $("vDurasi").textContent = Number($("inDurasi").value).toFixed(1);
  $("vDurasiBlower").textContent = Number($("inDurasiBlower").value).toFixed(1);
  $("vArahMin").textContent = $("inArahMin").value;
  $("vArahMax").textContent = $("inArahMax").value;
  $("vArahKecepatan").textContent = $("inArahKecepatan").value;
}
["inSudutBuka", "inSudutTutup", "inKecepatan", "inDurasi", "inDurasiBlower", "inArahMin", "inArahMax", "inArahKecepatan"]
  .forEach((id) => $(id).addEventListener("input", perbaruiLabelKatup));

$("formBlower").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pesanBlower").textContent = "Menyimpan...";
  try {
    await db.ref(`${ROOT}/kontrol/pengaturan`).update({ durasiBlowerMs: Math.round(Number($("inDurasiBlower").value) * 1000) });
    $("pesanBlower").textContent = alatOnline() ? "Tersimpan dan dikirim ke alat." : "Tersimpan. Dipakai saat alat online.";
  } catch (err) { $("pesanBlower").textContent = "Gagal: " + err.message; }
});

$("formPengarah").addEventListener("submit", async (e) => {
  e.preventDefault();
  let kiri = Number($("inArahMin").value), kanan = Number($("inArahMax").value);
  if (kiri > kanan) { [kiri, kanan] = [kanan, kiri]; $("inArahMin").value = kiri; $("inArahMax").value = kanan; perbaruiLabelKatup(); }
  $("pesanPengarah").textContent = "Menyimpan...";
  try {
    await db.ref(`${ROOT}/kontrol/pengaturan`).update({ arahMin: kiri, arahMax: kanan, arahKecepatan: Number($("inArahKecepatan").value) });
    $("pesanPengarah").textContent = alatOnline() ? "Tersimpan dan dikirim ke alat." : "Tersimpan. Dipakai saat alat online.";
  } catch (err) { $("pesanPengarah").textContent = "Gagal: " + err.message; }
});
$("btnTesPengarah").addEventListener("click", () => kirimBeriPakan($("pesanPengarah")));

$("formKatup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const buka = Number($("inSudutBuka").value);
  const tutup = Number($("inSudutTutup").value);
  if (buka === tutup) { $("pesanKatup").textContent = "Sudut buka dan tutup tidak boleh sama."; return; }
  $("pesanKatup").textContent = "Menyimpan...";
  try {
    await db.ref(`${ROOT}/kontrol/pengaturan`).update({
      sudutBuka: buka,
      sudutTutup: tutup,
      kecepatan: Number($("inKecepatan").value),
      durasiBukaMs: Math.round(Number($("inDurasi").value) * 1000),
    });
    $("pesanKatup").textContent = alatOnline() ? "Tersimpan dan dikirim ke alat." : "Tersimpan. Dipakai saat alat online.";
  } catch (err) { $("pesanKatup").textContent = "Gagal: " + err.message; }
});
$("btnTesKatup").addEventListener("click", () => kirimBeriPakan($("pesanKatup")));

document.querySelectorAll("[data-isi]").forEach((b) => b.addEventListener("click", () => {
  const j = statusAlat.jarak;
  if (!alatOnline() || typeof j !== "number" || j < 0) {
    $("pesanKalibrasi").textContent = "Jarak sensor belum terbaca. Pastikan alat online.";
    return;
  }
  $(b.dataset.isi).value = j.toFixed(1);
  $("pesanKalibrasi").textContent = "Jarak dipakai. Jangan lupa tekan Simpan kalibrasi.";
}));

$("formKalibrasi").addEventListener("submit", async (e) => {
  e.preventDefault();
  const penuh = Number($("inPenuh").value);
  const habis = Number($("inHabis").value);
  if (!(habis - penuh >= 1)) {
    $("pesanKalibrasi").textContent = "Titik HABIS harus lebih jauh (angka lebih besar) minimal 1 cm dari titik PENUH.";
    return;
  }
  $("pesanKalibrasi").textContent = "Menyimpan...";
  try {
    await db.ref(`${ROOT}/kontrol/pengaturan`).update({ penuhMm: Math.round(penuh * 10), kosongMm: Math.round(habis * 10) });
    $("pesanKalibrasi").textContent = "Kalibrasi tersimpan. Alat menyimpannya di memori ESP32.";
  } catch (err) { $("pesanKalibrasi").textContent = "Gagal: " + err.message; }
});

$("formReboot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const [jam, menit] = ($("inRbWaktu").value || "03:00").split(":").map(Number);
  $("pesanReboot").textContent = "Menyimpan...";
  try {
    await db.ref(`${ROOT}/kontrol/pengaturan/reboot`).set({
      aktif: $("inRbAktif").checked, jam, menit, hari: bacaPilihanHari($("hariReboot")),
    });
    $("pesanReboot").textContent = $("inRbAktif").checked ? `Alat akan restart otomatis pukul ${dua(jam)}:${dua(menit)}.` : "Restart terjadwal dimatikan.";
  } catch (err) { $("pesanReboot").textContent = "Gagal: " + err.message; }
});

$("btnRebootSekarang").addEventListener("click", (e) => tombolYakin(e.target, "Restart alat sekarang", async () => {
  if (!alatOnline()) { $("pesanReboot").textContent = "Alat sedang offline."; return; }
  try {
    await db.ref(`${ROOT}/kontrol/rebootSekarang`).set(detikServer());
    $("pesanReboot").textContent = "Perintah restart dikirim. Alat kembali online dalam sekitar 30 detik.";
  } catch (err) { $("pesanReboot").textContent = "Gagal: " + err.message; }
}));

// ---------- Update firmware lewat WiFi (OTA) ----------
const KUNCI_PASS_OTA = "pakanIkan.otaPass";
const adaOta = () => typeof window.PakanOta !== "undefined";
let ipOtaDiubah = false;
let otaBerjalan = false;

(function () {
  const p = bacaLokal(KUNCI_PASS_OTA);
  if (p) $("inPassOta").value = p;
})();
$("inIpOta").addEventListener("input", () => { ipOtaDiubah = true; });

$("btnPilihBin").addEventListener("click", () => {
  if (!adaOta()) { $("pesanOta").textContent = "Update hanya bisa dari aplikasi Android Pakan Ikan."; return; }
  window.PakanOta.pilihFile();
});

$("btnKirimOta").addEventListener("click", () => {
  if (!adaOta()) { $("pesanOta").textContent = "Update hanya bisa dari aplikasi Android Pakan Ikan."; return; }
  if (otaBerjalan) return;
  const ip = $("inIpOta").value.trim();
  const pass = $("inPassOta").value;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { $("pesanOta").textContent = "Isi alamat IP alat, contoh 192.168.43.20."; return; }
  if (!pass) { $("pesanOta").textContent = "Isi password OTA."; return; }
  simpanLokal(KUNCI_PASS_OTA, pass);
  otaBerjalan = true;
  $("btnKirimOta").disabled = true;
  $("btnPilihBin").disabled = true;
  $("barOta").style.width = "0%";
  $("pesanOta").textContent = alatOnline() ? "Memulai..." : "Alat terlihat offline di Firebase, tetap dicoba lewat jaringan lokal...";
  window.PakanOta.kirim(ip, pass);
});

// Dipanggil oleh kode Android (MainActivity.java)
window.otaKabar = function (jenis, pesan, persen) {
  if (jenis === "file") {
    $("teksBin").textContent = "File: " + pesan;
    $("pesanOta").textContent = "File siap. Isi password lalu tekan Kirim ke alat.";
    return;
  }
  $("barOta").style.width = `${persen || 0}%`;
  $("pesanOta").textContent = jenis === "error" ? "Gagal: " + pesan : pesan;
  if (jenis === "selesai" || jenis === "error" || jenis === "info") {
    otaBerjalan = false;
    $("btnKirimOta").disabled = false;
    $("btnPilihBin").disabled = false;
  }
};

// ---------- WiFi alat ----------
$("inLihatPass").addEventListener("change", (e) => {
  $("inWifiPass").type = e.target.checked ? "text" : "password";
});

function tampilkanDaftarWifi() {
  const ul = $("daftarWifi");
  if (!ul || peran !== "admin") return;
  const st = statusAlat;
  const online = alatOnline();
  $("teksWifiPesan").textContent = pesanWifiLokal || st.wifiPesan || "";
  const diAlat = String(st.wifiTersimpan || "").split("|").filter(Boolean);
  const tanda = JSON.stringify([daftarWifiApp.map((w) => w.ssid), diAlat, st.wifi, online, st.wifiBawaan]);
  if (ul.dataset.tanda === tanda) return;   // tidak berubah, tidak perlu digambar ulang
  ul.dataset.tanda = tanda;
  ul.innerHTML = "";

  const baris = (ssid, catatan, bisaHapus, idx) => {
    const li = document.createElement("li");
    li.className = "wifi-item";
    const teks = document.createElement("div");
    teks.className = "teks";
    const nama = document.createElement("div");
    nama.innerHTML = "<b></b>";
    nama.querySelector("b").textContent = "📶 " + ssid;
    if (online && st.wifi === ssid) nama.insertAdjacentHTML("beforeend", ` <span class="tanda hijau">Tersambung</span>`);
    const ket = document.createElement("div");
    ket.className = "redup kecil";
    ket.textContent = catatan;
    teks.append(nama, ket);
    li.appendChild(teks);
    if (bisaHapus) {
      const btn = document.createElement("button");
      btn.className = "tombol hapus";
      btn.textContent = "Hapus";
      btn.addEventListener("click", () => tombolYakin(btn, "Hapus", () => hapusWifi(idx)));
      li.appendChild(btn);
    }
    ul.appendChild(li);
  };

  daftarWifiApp.forEach((w, i) => {
    const sinkron = diAlat.includes(w.ssid);
    baris(w.ssid, sinkron ? "Tersimpan di alat" : "Menunggu alat online untuk menyimpan", true, i);
  });
  if (st.wifiBawaan) baris(st.wifiBawaan, "WiFi bawaan dari kode ESP32 (selalu dicoba)", false, -1);
  if (!daftarWifiApp.length && !st.wifiBawaan) ul.innerHTML = `<li class="redup">Belum ada WiFi tambahan.</li>`;
  $("jumlahWifi").textContent = `${daftarWifiApp.length} dari 8`;
}

async function simpanDaftarWifi(daftarBaru, pesanBerhasil) {
  const versi = detikServer();
  await db.ref("wifiAlat").update({ daftar: daftarBaru, versi, oleh: auth.currentUser.email });
  await db.ref(`${ROOT}/kontrol/wifiVersi`).set(versi);
  pesanWifiLokal = alatOnline() ? pesanBerhasil : pesanBerhasil + " Dikirim ke alat saat online.";
  setTimeout(() => { pesanWifiLokal = ""; }, 8000);
  tampilkanDaftarWifi();
}

async function hapusWifi(idx) {
  const w = daftarWifiApp[idx];
  if (!w) return;
  const baru = daftarWifiApp.filter((_, i) => i !== idx).map((x) => ({ ssid: x.ssid, pass: x.pass || "" }));
  try {
    let pesan = `WiFi "${w.ssid}" dihapus.`;
    if (statusAlat.wifi === w.ssid) pesan += " Alat tetap tersambung ke WiFi ini sampai putus atau restart.";
    await simpanDaftarWifi(baru, pesan);
  } catch (err) { pesanWifiLokal = "Gagal menghapus: " + err.message; tampilkanDaftarWifi(); }
}

$("formWifi").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ssid = $("inWifiSsid").value.trim();
  const pass = $("inWifiPass").value;
  const pesan = (t) => { pesanWifiLokal = t; tampilkanDaftarWifi(); };
  if (!ssid) return;
  if (pass && pass.length < 8) { pesan("Password WiFi minimal 8 karakter. Periksa lagi."); return; }
  if (ssid === statusAlat.wifiBawaan) { pesan("Itu WiFi bawaan, sudah selalu dicoba."); return; }
  const ada = daftarWifiApp.findIndex((w) => w.ssid === ssid);
  if (ada < 0 && daftarWifiApp.length >= 8) { pesan("Daftar penuh (8 WiFi). Hapus salah satu dulu."); return; }
  const baru = daftarWifiApp.map((x) => ({ ssid: x.ssid, pass: x.pass || "" }));
  if (ada >= 0) baru[ada] = { ssid, pass }; else baru.unshift({ ssid, pass });
  try {
    await simpanDaftarWifi(baru, ada >= 0 ? `Password WiFi "${ssid}" diperbarui.` : `WiFi "${ssid}" ditambahkan.`);
    $("inWifiSsid").value = "";
    $("inWifiPass").value = "";
  } catch (err) { pesan("Gagal menyimpan: " + err.message); }
});

// ---------- Pengguna ----------
$("formTambah").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nama = $("inNamaBaru").value.trim();
  const email = $("inEmailBaru").value.trim().toLowerCase();
  const pass = $("inPassBaru").value;
  const pesan = $("pesanTambah");
  if (email === EMAIL_ADMIN_KECIL) { pesan.textContent = "Itu email admin."; return; }

  pesan.textContent = "Membuat akun...";
  const app2 = firebase.apps.find((a) => a.name === "pembuatAkun") || firebase.initializeApp(firebaseConfig, "pembuatAkun");
  const auth2 = app2.auth();
  try {
    await auth2.setPersistence(firebase.auth.Auth.Persistence.NONE);
    let uid;
    try {
      uid = (await auth2.createUserWithEmailAndPassword(email, pass)).user.uid;
    } catch (err) {
      if (err.code !== "auth/email-already-in-use") throw err;
      try {
        uid = (await auth2.signInWithEmailAndPassword(email, pass)).user.uid;
      } catch (err2) {
        throw { code: "custom", message: "Email ini sudah terdaftar dengan password lain. Hapus akunnya di Firebase Console > Authentication > Users, lalu tambahkan lagi." };
      }
    }
    await auth2.signOut();
    await db.ref(`pengguna/${uid}`).set({
      nama, email, dibuat: firebase.database.ServerValue.TIMESTAMP, olehAdmin: auth.currentUser.email,
    });
    $("inNamaBaru").value = "";
    $("inEmailBaru").value = "";
    $("inPassBaru").value = "";
    pesan.textContent = `Berhasil. ${nama} bisa login dengan ${email}.`;
  } catch (err) {
    try { await auth2.signOut(); } catch (e2) {}
    pesan.textContent = err.code === "custom" ? err.message : terjemah(err);
  }
});

// =====================================================================
//  EKSPOR CSV
//  Pemisah ";" dan desimal koma supaya rapi di Excel berbahasa Indonesia.
// =====================================================================
const PEMISAH = ";";
function selCsv(v) {
  if (v === null || v === undefined) return "";
  let t = typeof v === "number" ? String(v).replace(".", ",") : String(v);
  if (/[;"\n\r]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
  return t;
}
const barisCsv = (kolom) => kolom.map(selCsv).join(PEMISAH);
function kolomWaktu(ms) {
  const d = new Date(ms);
  return [`${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())}`,
          `${dua(d.getHours())}:${dua(d.getMinutes())}:${dua(d.getSeconds())}`,
          NAMA_HARI_PANJANG[d.getDay()]];
}
function namaHariMask(mask) {
  mask = mask || 127;
  if (mask === 127) return "Setiap hari";
  return NAMA_HARI.filter((_, b) => mask & (1 << b)).join(", ");
}

async function ambilRiwayat(nama, jam) {
  let q = db.ref(`${ROOT}/${nama}`).orderByChild("waktu");
  if (jam > 0) q = q.startAt(jamServer() - jam * 3600e3);
  const s = await q.once("value");
  const data = [];
  s.forEach((a) => { const v = a.val(); if (v && v.waktu) data.push(v); });
  return data.sort((a, b) => a.waktu - b.waktu);
}

function bagianPakan(data) {
  const out = [barisCsv(["Tanggal", "Jam", "Hari", "Sumber", "Sisa pakan (%)"])];
  data.forEach((r) => out.push(barisCsv([...kolomWaktu(r.waktu), r.sumber || "-",
    typeof r.level === "number" && r.level >= 0 ? r.level : ""])));
  return out;
}

function bagianLevel(data) {
  const out = [barisCsv(["Tanggal", "Jam", "Hari", "Isi wadah (%)", "Jarak sensor (cm)", "Sinyal WiFi (dBm)"])];
  data.forEach((r) => out.push(barisCsv([...kolomWaktu(r.waktu),
    typeof r.level === "number" ? r.level : "", typeof r.jarak === "number" ? r.jarak : "",
    typeof r.rssi === "number" ? r.rssi : ""])));
  return out;
}

function bagianJadwal(jadwal) {
  const out = [barisCsv(["No", "Jam", "Aktif", "Hari"])];
  urutanJadwal(jadwal || {}).forEach(([, j], i) => out.push(barisCsv([i + 1,
    `${dua(j.jam || 0)}:${dua(j.menit || 0)}`, j.aktif ? "Ya" : "Tidak", namaHariMask(j.hari)])));
  return out;
}

function bagianAlat(st, p, laporan) {
  p = Object.assign({}, PENGATURAN_BAWAAN, p || {});
  const rb = Object.assign({}, PENGATURAN_BAWAAN.reboot, p.reboot || {});
  const online = alatOnline();
  const baris = [
    ["Status", "Koneksi alat", online ? "Online" : "Offline"],
    ["Status", "Status pakan", st.statusPakan || "-"],
    ["Status", "Sisa pakan (%)", typeof st.level === "number" && st.level >= 0 ? st.level : ""],
    ["Status", "Jarak sensor (cm)", typeof st.jarak === "number" && st.jarak >= 0 ? st.jarak : ""],
    ["Status", "Terakhir diberi pakan", st.terakhir || "-"],
    ["Status", "Data terakhir masuk", updateTerakhirAlat ? kolomWaktu(updateTerakhirAlat).slice(0, 2).join(" ") : "-"],
    ["Status", "Lama alat menyala", typeof st.uptime === "number" ? lamaWaktu(st.uptime) : "-"],
    ["Status", "Versi firmware", st.firmware ? "v" + st.firmware : "-"],
    ["Status", "Alamat IP", st.ip || "-"],
    ["Status", "WiFi tersambung", st.wifi || "-"],
    ["Status", "Sinyal WiFi (dBm)", typeof st.rssi === "number" ? st.rssi : ""],
    ["Katup", "Sudut buka (derajat)", p.sudutBuka],
    ["Katup", "Sudut tutup (derajat)", p.sudutTutup],
    ["Katup", "Kecepatan (1-10)", p.kecepatan],
    ["Katup", "Lama terbuka (detik)", p.durasiBukaMs / 1000],
    ["Blower", "Lama menyala (detik)", p.durasiBlowerMs / 1000],
    ["Pengarah", "Batas kiri (derajat)", p.arahMin],
    ["Pengarah", "Batas kanan (derajat)", p.arahMax],
    ["Pengarah", "Kecepatan sapu (1-10)", p.arahKecepatan],
    ["Kalibrasi", "Titik penuh (cm)", p.penuhMm / 10],
    ["Kalibrasi", "Titik habis (cm)", p.kosongMm / 10],
    ["Restart otomatis", "Aktif", rb.aktif ? "Ya" : "Tidak"],
    ["Restart otomatis", "Jam", `${dua(rb.jam)}:${dua(rb.menit)}`],
    ["Restart otomatis", "Hari", namaHariMask(rb.hari)],
  ];
  if (peran === "admin") {
    daftarWifiApp.forEach((w, i) => baris.push(["WiFi tersimpan", `WiFi ${i + 1}`, w.ssid]));
    if (st.wifiBawaan) baris.push(["WiFi tersimpan", "WiFi bawaan", st.wifiBawaan]);
  }
  if (laporan && laporan.pesan) {
    baris.push(["Laporan terakhir", laporan.waktu ? kolomWaktu(laporan.waktu).slice(0, 2).join(" ") : "-", laporan.pesan]);
  }
  return [barisCsv(["Bagian", "Nama", "Nilai"]), ...baris.map(barisCsv)];
}

function bagianPengguna(pengguna) {
  const out = [barisCsv(["Nama", "Email", "Peran", "Ditambahkan"])];
  out.push(barisCsv(["Admin (pemilik)", EMAIL_ADMIN_KECIL, "Admin", "-"]));
  Object.values(pengguna || {}).forEach((p) => out.push(barisCsv([p.nama || "-", p.email || "-", "Pengguna",
    p.dibuat ? kolomWaktu(p.dibuat).slice(0, 2).join(" ") : "-"])));
  return out;
}

async function buatCsv(jenis, jam) {
  const labelRentang = jam > 0 ? (jam === 24 ? "24 jam terakhir" : `${jam / 24} hari terakhir`) : "Semua data";
  const kepala = [barisCsv(["Pakan Ikan Otomatis", "Diekspor", kolomWaktu(jamServer()).join(" "), zonaWaktu()]),
                  barisCsv(["Oleh", auth.currentUser ? auth.currentUser.email : "-", "Rentang riwayat", labelRentang]), ""];
  const judul = (t) => [barisCsv([`=== ${t} ===`])];
  const ambil = async (path) => { try { return (await db.ref(path).once("value")).val(); } catch (e) { return null; } };

  if (jenis === "pakan") return [...kepala, ...bagianPakan(await ambilRiwayat("riwayat", jam))];
  if (jenis === "level") return [...kepala, ...bagianLevel(await ambilRiwayat("riwayatLevel", jam))];
  if (jenis === "jadwal") return [...kepala, ...bagianJadwal(await ambil(`${ROOT}/kontrol/jadwal`))];
  if (jenis === "alat") return [...kepala, ...bagianAlat(statusAlat, await ambil(`${ROOT}/kontrol/pengaturan`), await ambil(`${ROOT}/laporan`))];
  if (jenis === "pengguna") return [...kepala, ...bagianPengguna(await ambil("pengguna"))];

  // Semua informasi dalam satu file, dipisah judul bagian
  const [pakan, level, jadwal, pengaturan, laporan] = await Promise.all([
    ambilRiwayat("riwayat", jam), ambilRiwayat("riwayatLevel", jam),
    ambil(`${ROOT}/kontrol/jadwal`), ambil(`${ROOT}/kontrol/pengaturan`), ambil(`${ROOT}/laporan`)]);
  const hasil = [...kepala,
    ...judul("STATUS DAN PENGATURAN ALAT"), ...bagianAlat(statusAlat, pengaturan, laporan), "",
    ...judul("JADWAL"), ...bagianJadwal(jadwal), "",
    ...judul(`RIWAYAT PEMBERIAN PAKAN (${pakan.length} data)`), ...bagianPakan(pakan), "",
    ...judul(`RIWAYAT ISI WADAH DAN SINYAL (${level.length} data)`), ...bagianLevel(level)];
  if (peran === "admin") hasil.push("", ...judul("PENGGUNA"), ...bagianPengguna(await ambil("pengguna")));
  return hasil;
}

$("btnCsv").addEventListener("click", async () => {
  const jenis = $("csvJenis").value;
  const jam = Number($("csvRentang").value);
  const btn = $("btnCsv");
  btn.disabled = true;
  $("pesanCsv").textContent = "Menyiapkan data...";
  try {
    const isi = (await buatCsv(jenis, jam)).join("\r\n") + "\r\n";
    const d = new Date(jamServer());
    const nama = `pakan-ikan_${jenis}_${d.getFullYear()}${dua(d.getMonth() + 1)}${dua(d.getDate())}-${dua(d.getHours())}${dua(d.getMinutes())}.csv`;
    if (window.PakanOta && typeof window.PakanOta.simpanCsv === "function") {
      $("pesanCsv").textContent = "Pilih tempat menyimpan file...";
      window.PakanOta.simpanCsv(nama, isi);
    } else {
      // Browser biasa: unduh langsung
      const blob = new Blob(["\ufeff" + isi], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = nama;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      $("pesanCsv").textContent = "CSV diunduh: " + nama;
      btn.disabled = false;
    }
  } catch (err) {
    $("pesanCsv").textContent = "Gagal membuat CSV: " + err.message;
    btn.disabled = false;
  }
});

// Dipanggil oleh kode Android setelah file disimpan
window.csvKabar = function (berhasil, pesan) {
  $("pesanCsv").textContent = berhasil ? "✓ " + pesan : pesan;
  $("btnCsv").disabled = false;
};
