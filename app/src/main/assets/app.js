// =====================================================================
//  Logika aplikasi Pakan Ikan (Firebase Realtime Database)  v2
// =====================================================================
const ROOT = "pakanIkan";
const BATAS_OFFLINE_MS = 20000;
const NAMA_HARI = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]; // bit 0 = Senin
const KUNCI_EMAIL = "pakanIkan.email";
const KUNCI_INGAT = "pakanIkan.ingat";

const $ = (id) => document.getElementById(id);

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
let menungguAlat = false;
let menungguWifi = null;
let peran = null; // "admin" atau "pengguna"

db.ref(".info/serverTimeOffset").on("value", (s) => { selisihJamServer = s.val() || 0; });
const jamServer = () => Date.now() + selisihJamServer;

function formatWaktu(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const dua = (n) => String(n).padStart(2, "0");
  return `${dua(d.getHours())}:${dua(d.getMinutes())}, ${dua(d.getDate())}/${dua(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const PESAN_ERROR = {
  "auth/invalid-email": "Format email salah.",
  "auth/user-not-found": "Akun tidak ditemukan.",
  "auth/wrong-password": "Password salah.",
  "auth/invalid-credential": "Email atau password salah.",
  "auth/invalid-login-credentials": "Email atau password salah.",
  "auth/too-many-requests": "Terlalu banyak percobaan. Tunggu sebentar.",
  "auth/network-request-failed": "Tidak ada koneksi internet.",
  "auth/operation-not-allowed": "Login Email/Password belum diaktifkan di Firebase.",
  "auth/admin-restricted-operation": "Pendaftaran akun dimatikan di Firebase. Aktifkan lagi 'Enable create (sign-up)' di Authentication > Settings > User actions.",
  "auth/email-already-in-use": "Email sudah terdaftar.",
  "auth/weak-password": "Password minimal 6 karakter.",
  "auth/requires-recent-login": "Silakan keluar lalu masuk lagi, kemudian ulangi.",
};
const terjemah = (err) => PESAN_ERROR[err && err.code] || `Gagal (${(err && (err.code || err.message)) || "tidak diketahui"})`;

// =====================================================================
//  LOGIN + INGAT PERANGKAT
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
    // LOCAL = tetap masuk walau aplikasi ditutup. SESSION = keluar saat aplikasi ditutup.
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
  peran = null;
  if (!user) {
    tampilkan("layarLogin");
    return;
  }
  tampilkan("layarMuat");

  // Tentukan hak akses
  const email = (user.email || "").toLowerCase();
  let nama = user.email;
  if (EMAIL_ADMIN_KECIL && email === EMAIL_ADMIN_KECIL) {
    peran = "admin";
    nama = user.email;
  } else {
    try {
      const s = await db.ref(`pengguna/${user.uid}`).once("value");
      if (s.exists()) {
        peran = "pengguna";
        nama = s.val().nama || user.email;
      }
    } catch (err) { /* ditolak Rules = belum diberi akses */ }
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
  pilihTab("tabBeranda");
  mulaiDashboard();
  if (peran === "admin") mulaiAdmin();
});

function dengar(ref, event, fn) {
  ref.on(event, fn, (err) => {
    console.error(err);
    if (err && err.code === "PERMISSION_DENIED") {
      $("pesanPakan").textContent = "Akses ditolak oleh Rules Firebase. Cek email admin di Rules dan config.js.";
    }
  });
  pendengar.push(() => ref.off(event, fn));
}

function lepasSemuaPendengar() {
  pendengar.forEach((lepas) => lepas());
  pendengar = [];
}

// =====================================================================
//  TAB
// =====================================================================
function pilihTab(id) {
  document.querySelectorAll(".isi-tab").forEach((el) => el.classList.toggle("tersembunyi", el.id !== id));
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("aktif", b.dataset.tab === id));
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => pilihTab(b.dataset.tab)));

// =====================================================================
//  BERANDA
// =====================================================================
function mulaiDashboard() {
  buatKartuJadwal();

  dengar(db.ref(`${ROOT}/status`), "value", (s) => {
    statusAlat = s.val() || {};
    updateTerakhirAlat = statusAlat.update || 0;
    tampilkanStatus();
  });

  dengar(db.ref(`${ROOT}/laporan`), "value", (s) => {
    const l = s.val();
    $("teksLaporan").textContent = l && l.pesan ? l.pesan : "Belum ada laporan.";
    $("waktuLaporan").textContent = l && l.waktu ? `Dikirim ${formatWaktu(l.waktu)}` : "";
  });

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

  db.ref(`${ROOT}/kontrol/jadwal`).once("value").then((s) => isiJadwal(s.val() || {})).catch(() => {});
}

function alatOnline() {
  return updateTerakhirAlat > 0 && jamServer() - updateTerakhirAlat < BATAS_OFFLINE_MS;
}

function labelSinyal(rssi) {
  if (typeof rssi !== "number" || rssi === 0) return "-";
  if (rssi >= -60) return `Kuat (${rssi} dBm)`;
  if (rssi >= -72) return `Sedang (${rssi} dBm)`;
  return `Lemah (${rssi} dBm)`;
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

  // WiFi alat
  $("teksWifi").textContent = online ? (st.wifi || "-") : `Offline (terakhir: ${st.wifi || "-"})`;
  $("teksSinyal").textContent = online ? labelSinyal(st.rssi) : "-";
  if (menungguWifi) {
    if ((st.wifiPesan || "") !== menungguWifi.pesanSebelum && st.wifiPesan) {
      $("teksWifiPesan").textContent = st.wifiPesan;
      menungguWifi = null;
    }
  } else if (st.wifiPesan) {
    $("teksWifiPesan").textContent = "Terakhir: " + st.wifiPesan;
  }

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

  if (!online && !updateTerakhirAlat) {
    $("pesanPakan").textContent = "Alat belum pernah terhubung. Pastikan ESP32 menyala dan terhubung WiFi.";
  }
}

setInterval(() => {
  if (!$("layarUtama").classList.contains("tersembunyi")) tampilkanStatus();
}, 2000);

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
//  PENGATURAN ADMIN: WIFI ALAT DAN PENGGUNA
// =====================================================================
function mulaiAdmin() {
  // Isi nama WiFi yang tersimpan
  db.ref("wifiAlat/ssid").once("value").then((s) => {
    if (s.val() && !$("inWifiSsid").value) $("inWifiSsid").value = s.val();
  }).catch(() => {});

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
      btn.addEventListener("click", async () => {
        if (btn.dataset.yakin !== "1") {
          btn.dataset.yakin = "1";
          btn.textContent = "Tekan lagi untuk yakin";
          setTimeout(() => { btn.dataset.yakin = ""; btn.textContent = "Cabut akses"; }, 4000);
          return;
        }
        btn.disabled = true;
        try { await db.ref(`pengguna/${anak.key}`).remove(); }
        catch (err) { btn.disabled = false; btn.textContent = "Gagal"; }
      });

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

$("inLihatPass").addEventListener("change", (e) => {
  $("inWifiPass").type = e.target.checked ? "text" : "password";
});

$("formWifi").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ssid = $("inWifiSsid").value.trim();
  const pass = $("inWifiPass").value;
  const pesan = $("teksWifiPesan");
  if (!ssid) return;
  if (pass && pass.length < 8) {
    pesan.textContent = "Password WiFi biasanya minimal 8 karakter. Periksa lagi.";
    return;
  }
  const versi = Math.floor(jamServer() / 1000);
  menungguWifi = { ssid, pesanSebelum: statusAlat.wifiPesan || "" };
  pesan.textContent = alatOnline()
    ? `Dikirim. Alat sedang mencoba tersambung ke "${ssid}", tunggu sekitar 30 detik...`
    : `Tersimpan. Alat sedang offline, pengaturan dipakai saat alat online lagi.`;
  try {
    await db.ref("wifiAlat").set({ ssid, pass, versi, oleh: auth.currentUser.email });
    await db.ref(`${ROOT}/kontrol/wifiVersi`).set(versi);
    $("inWifiPass").value = "";
  } catch (err) {
    menungguWifi = null;
    pesan.textContent = "Gagal menyimpan: " + err.message;
  }
  setTimeout(() => {
    if (menungguWifi && menungguWifi.ssid === ssid) {
      menungguWifi = null;
      pesan.textContent = "Belum ada jawaban dari alat. Jika alat jadi offline, kemungkinan WiFi baru tersambung tetapi tanpa internet, atau gunakan mode hotspot.";
    }
  }, 60000);
});

$("formTambah").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nama = $("inNamaBaru").value.trim();
  const email = $("inEmailBaru").value.trim().toLowerCase();
  const pass = $("inPassBaru").value;
  const pesan = $("pesanTambah");

  if (email === EMAIL_ADMIN_KECIL) { pesan.textContent = "Itu email admin."; return; }

  pesan.textContent = "Membuat akun...";
  // Aplikasi Firebase kedua dipakai agar admin tidak ikut keluar saat akun baru dibuat
  const app2 = firebase.apps.find((a) => a.name === "pembuatAkun") || firebase.initializeApp(firebaseConfig, "pembuatAkun");
  const auth2 = app2.auth();
  try {
    await auth2.setPersistence(firebase.auth.Auth.Persistence.NONE);
    let uid;
    try {
      const hasil = await auth2.createUserWithEmailAndPassword(email, pass);
      uid = hasil.user.uid;
    } catch (err) {
      if (err.code !== "auth/email-already-in-use") throw err;
      // Akun sudah ada (misal pernah dicabut): coba masuk dengan password yang diberikan
      try {
        const hasil = await auth2.signInWithEmailAndPassword(email, pass);
        uid = hasil.user.uid;
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
