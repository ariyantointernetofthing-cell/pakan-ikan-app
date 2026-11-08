// =====================================================================
//  Logika aplikasi Pakan Ikan (Firebase Realtime Database)
// =====================================================================
const ROOT = "pakanIkan";
const BATAS_OFFLINE_MS = 20000;   // alat dianggap offline jika tidak lapor > 20 detik
const NAMA_HARI = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]; // bit 0 = Senin

const $ = (id) => document.getElementById(id);

function tampilkan(idLayar) {
  ["layarMuat", "layarGagal", "layarLogin", "layarUtama"].forEach((id) => {
    $(id).classList.toggle("tersembunyi", id !== idLayar);
  });
}

// ---------- Cek SDK Firebase berhasil dimuat (butuh internet) ----------
if (typeof firebase === "undefined") {
  tampilkan("layarGagal");
  throw new Error("Firebase SDK gagal dimuat");
}

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

let selisihJamServer = 0;       // ms, koreksi jam HP terhadap jam server
let updateTerakhirAlat = 0;     // ms, kapan alat terakhir mengirim status
let statusAlat = {};
let pendengar = [];             // daftar listener aktif, dilepas saat logout
let menungguAlat = false;

db.ref(".info/serverTimeOffset").on("value", (s) => {
  selisihJamServer = s.val() || 0;
});
const jamServer = () => Date.now() + selisihJamServer;

// ---------- Format waktu ----------
function formatWaktu(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const dua = (n) => String(n).padStart(2, "0");
  return `${dua(d.getHours())}:${dua(d.getMinutes())}, ${dua(d.getDate())}/${dua(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ---------- Login ----------
const PESAN_ERROR = {
  "auth/invalid-email": "Format email salah.",
  "auth/user-not-found": "Akun tidak ditemukan.",
  "auth/wrong-password": "Password salah.",
  "auth/invalid-credential": "Email atau password salah.",
  "auth/invalid-login-credentials": "Email atau password salah.",
  "auth/too-many-requests": "Terlalu banyak percobaan. Tunggu sebentar.",
  "auth/network-request-failed": "Tidak ada koneksi internet.",
  "auth/operation-not-allowed": "Login Email/Password belum diaktifkan di Firebase.",
  "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "apiKey di config.js salah.",
};

$("formLogin").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pesanLogin").textContent = "";
  $("btnLogin").disabled = true;
  $("btnLogin").textContent = "Memproses...";
  try {
    await auth.signInWithEmailAndPassword($("inEmail").value.trim(), $("inPassword").value);
  } catch (err) {
    $("pesanLogin").textContent = PESAN_ERROR[err.code] || `Gagal masuk (${err.code || err.message})`;
  } finally {
    $("btnLogin").disabled = false;
    $("btnLogin").textContent = "Masuk";
  }
});

$("btnKeluar").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged((user) => {
  lepasSemuaPendengar();
  if (user) {
    tampilkan("layarUtama");
    mulaiDashboard();
  } else {
    tampilkan("layarLogin");
  }
});

function dengar(ref, event, fn) {
  ref.on(event, fn, (err) => {
    console.error(err);
    if (err && err.code === "PERMISSION_DENIED") {
      $("pesanPakan").textContent = "Akses ditolak. Cek Rules database dan email akun (PANDUAN langkah 1.5).";
    }
  });
  pendengar.push(() => ref.off(event, fn));
}

function lepasSemuaPendengar() {
  pendengar.forEach((lepas) => lepas());
  pendengar = [];
}

// ---------- Dashboard ----------
function mulaiDashboard() {
  buatKartuJadwal();

  // Status alat
  dengar(db.ref(`${ROOT}/status`), "value", (s) => {
    statusAlat = s.val() || {};
    updateTerakhirAlat = statusAlat.update || 0;
    tampilkanStatus();
  });

  // Laporan berkala
  dengar(db.ref(`${ROOT}/laporan`), "value", (s) => {
    const l = s.val();
    $("teksLaporan").textContent = l && l.pesan ? l.pesan : "Belum ada laporan.";
    $("waktuLaporan").textContent = l && l.waktu ? `Dikirim ${formatWaktu(l.waktu)}` : "";
  });

  // Riwayat 10 terakhir
  dengar(db.ref(`${ROOT}/riwayat`).limitToLast(10), "value", (s) => {
    const ul = $("daftarRiwayat");
    ul.innerHTML = "";
    const data = [];
    s.forEach((anak) => { data.push(anak.val()); });
    if (data.length === 0) {
      const li = document.createElement("li");
      li.className = "redup";
      li.textContent = "Belum ada riwayat.";
      ul.appendChild(li);
      return;
    }
    data.reverse().forEach((r) => {
      const li = document.createElement("li");
      const kiri = document.createElement("span");
      const kanan = document.createElement("span");
      kiri.textContent = formatWaktu(r.waktu);
      kanan.textContent = r.sumber || "-";
      kanan.className = "redup";
      li.append(kiri, kanan);
      ul.appendChild(li);
    });
  });

  // Isi jadwal sekali saat dibuka
  db.ref(`${ROOT}/kontrol/jadwal`).once("value").then((s) => isiJadwal(s.val() || {}));
}

function alatOnline() {
  return updateTerakhirAlat > 0 && jamServer() - updateTerakhirAlat < BATAS_OFFLINE_MS;
}

function tampilkanStatus() {
  const st = statusAlat;
  const online = alatOnline();

  const badge = $("badgeKoneksi");
  badge.textContent = online ? "● Alat online" : "● Alat offline";
  badge.className = "badge " + (online ? "online" : "offline");

  const level = typeof st.level === "number" ? st.level : -1;
  const cincin = $("cincinLevel");
  cincin.style.setProperty("--persen", level >= 0 ? level : 0);
  cincin.style.setProperty("--warna",
    level < 0 ? "#CFDCE0" : level <= 20 ? "var(--merah)" : level <= 50 ? "var(--kuning)" : "var(--toska)");
  $("teksLevel").textContent = level >= 0 ? `${level}%` : "--%";

  $("teksJarak").textContent =
    typeof st.jarak === "number" && st.jarak >= 0 ? `Jarak sensor: ${st.jarak} cm` : "Jarak sensor: belum terbaca";
  $("teksStatus").textContent = online ? (st.statusPakan || "-") : "Alat tidak terhubung";
  $("teksTerakhir").textContent = st.terakhir || "-";

  const btn = $("btnPakan");
  if (st.sedangMemberi && online) {
    btn.disabled = true;
    btn.textContent = "SEDANG MEMBERI PAKAN...";
    $("pesanPakan").textContent = "";
    menungguAlat = false;
  } else if (menungguAlat) {
    btn.disabled = true;
    btn.textContent = "MENUNGGU ALAT...";
  } else {
    btn.disabled = false;
    btn.textContent = "BERI PAKAN SEKARANG";
  }

  if (!online && level < 0 && !updateTerakhirAlat) {
    $("pesanPakan").textContent = "Alat belum pernah terhubung. Pastikan ESP32 menyala dan terhubung WiFi.";
  }
}

// Cek online/offline tiap 2 detik walau tidak ada data baru
setInterval(() => {
  if (!$("layarUtama").classList.contains("tersembunyi")) tampilkanStatus();
}, 2000);

// ---------- Tombol beri pakan ----------
$("btnPakan").addEventListener("click", async () => {
  if (!alatOnline()) {
    $("pesanPakan").textContent = "Alat sedang offline. Perintah tidak dikirim.";
    return;
  }
  menungguAlat = true;
  tampilkanStatus();
  $("pesanPakan").textContent = "Perintah terkirim, menunggu alat...";
  try {
    await db.ref(`${ROOT}/kontrol`).update({
      beriPakan: true,
      waktuPerintah: Math.floor(jamServer() / 1000),
    });
  } catch (err) {
    menungguAlat = false;
    $("pesanPakan").textContent = "Gagal mengirim perintah: " + err.message;
  }
  // Jika dalam 10 detik alat tidak merespons
  setTimeout(() => {
    if (menungguAlat) {
      menungguAlat = false;
      $("pesanPakan").textContent = "Alat tidak merespons. Cek koneksi ESP32.";
      tampilkanStatus();
    }
  }, 10000);
});

// ---------- Jadwal ----------
function buatKartuJadwal() {
  const wadah = $("daftarJadwal");
  if (wadah.children.length) return;
  const tpl = $("templateJadwal");

  for (let i = 1; i <= 3; i++) {
    const kartu = tpl.content.firstElementChild.cloneNode(true);
    kartu.dataset.no = i;
    kartu.querySelector(".judul-jadwal").textContent = `Jadwal ${i}`;

    const hari = kartu.querySelector(".hari");
    NAMA_HARI.forEach((nama, bit) => {
      const lbl = document.createElement("label");
      lbl.innerHTML = `<input type="checkbox" data-bit="${bit}" checked><span>${nama}</span>`;
      hari.appendChild(lbl);
    });

    kartu.querySelector(".jSimpan").addEventListener("click", () => simpanJadwal(kartu));
    kartu.querySelector(".jAktif").addEventListener("change", () => simpanJadwal(kartu));
    wadah.appendChild(kartu);
  }
}

function isiJadwal(data) {
  document.querySelectorAll(".jadwal").forEach((kartu) => {
    const j = data[`j${kartu.dataset.no}`];
    if (!j) return;
    const dua = (n) => String(n).padStart(2, "0");
    kartu.querySelector(".jAktif").checked = !!j.aktif;
    kartu.querySelector(".jWaktu").value = `${dua(j.jam || 0)}:${dua(j.menit || 0)}`;
    const mask = j.hari || 127;
    kartu.querySelectorAll(".hari input").forEach((cb) => {
      cb.checked = (mask & (1 << Number(cb.dataset.bit))) !== 0;
    });
  });
}

async function simpanJadwal(kartu) {
  const no = kartu.dataset.no;
  const pesan = kartu.querySelector(".jPesan");
  const waktu = kartu.querySelector(".jWaktu").value || "00:00";
  const [jam, menit] = waktu.split(":").map(Number);

  let hari = 0;
  kartu.querySelectorAll(".hari input").forEach((cb) => {
    if (cb.checked) hari |= 1 << Number(cb.dataset.bit);
  });
  if (hari === 0) {
    hari = 127;
    kartu.querySelectorAll(".hari input").forEach((cb) => (cb.checked = true));
  }

  const aktif = kartu.querySelector(".jAktif").checked;
  pesan.textContent = "Menyimpan...";
  try {
    await db.ref(`${ROOT}/kontrol/jadwal/j${no}`).set({ aktif, jam, menit, hari });
    pesan.textContent = aktif ? `Aktif pukul ${waktu}` : "Tersimpan (nonaktif)";
  } catch (err) {
    pesan.textContent = "Gagal: " + err.message;
  }
}
