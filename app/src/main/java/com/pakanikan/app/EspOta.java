package com.pakanikan.app;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Pengirim firmware ke ESP32 lewat protokol ArduinoOTA (sama dengan espota.py
 * di Arduino IDE / PlatformIO). Tidak memakai API Android supaya bisa diuji di komputer.
 *
 * Alur:
 *  1. Kirim undangan UDP ke alat: "0 <portTCP> <ukuran> <md5File>"
 *  2. Alat menjawab "OK" atau "AUTH <nonce>".
 *     - nonce 32 karakter: autentikasi lama (MD5), Arduino core ESP32 2.x dan 3.0 sampai 3.2
 *     - nonce 64 karakter: autentikasi baru (PBKDF2-HMAC-SHA256), Arduino core ESP32 terbaru
 *  3. Alat menyambung balik lewat TCP ke HP, firmware dikirim, alat menjawab "OK".
 */
public final class EspOta {
    public interface Listener { void onProgress(int percent, String message); }

    public static final int PORT_BAWAAN = 3232;
    public static final int MAX_BIN = 1966080;   // partisi "Minimal SPIFFS (1.9MB APP with OTA)"

    private EspOta() {}

    /** Hanya alamat jaringan lokal yang diizinkan. */
    public static boolean ipLokal(String ip) {
        if (ip == null || !ip.matches("^\\d{1,3}(\\.\\d{1,3}){3}$")) return false;
        String[] p = ip.split("\\.");
        int[] v = new int[4];
        for (int i = 0; i < 4; i++) { v[i] = Integer.parseInt(p[i]); if (v[i] > 255) return false; }
        if (v[0] == 10) return true;
        if (v[0] == 172 && v[1] >= 16 && v[1] <= 31) return true;
        if (v[0] == 192 && v[1] == 168) return true;
        if (v[0] == 169 && v[1] == 254) return true;
        return v[0] == 127;
    }

    /** File firmware ESP32 selalu diawali byte 0xE9. */
    public static boolean firmwareEsp32(byte[] d) {
        return d != null && d.length > 4096 && d.length <= MAX_BIN && (d[0] & 0xFF) == 0xE9;
    }

    static String hex(byte[] h) {
        StringBuilder sb = new StringBuilder();
        for (byte b : h) sb.append(String.format("%02x", b & 0xFF));
        return sb.toString();
    }

    static String hash(String algoritma, byte[] data) throws IOException {
        try { return hex(MessageDigest.getInstance(algoritma).digest(data)); }
        catch (Exception e) { throw new IOException(algoritma + " tidak tersedia"); }
    }

    static String md5(String s) throws IOException { return hash("MD5", s.getBytes(StandardCharsets.UTF_8)); }
    static String sha256(String s) throws IOException { return hash("SHA-256", s.getBytes(StandardCharsets.UTF_8)); }

    /** PBKDF2-HMAC-SHA256, 1 blok (32 byte). Ditulis manual supaya jalan di Android 7 ke atas. */
    static byte[] pbkdf2Sha256(byte[] password, byte[] salt, int iterasi) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(password, "HmacSHA256"));
            mac.update(salt);
            byte[] u = mac.doFinal(new byte[]{0, 0, 0, 1});
            byte[] hasil = u.clone();
            for (int i = 1; i < iterasi; i++) {
                u = mac.doFinal(u);
                for (int j = 0; j < hasil.length; j++) hasil[j] ^= u[j];
            }
            return hasil;
        } catch (Exception e) {
            throw new IOException("HmacSHA256 tidak tersedia");
        }
    }

    /** Jawaban tantangan password. pakaiMd5Password hanya untuk alat lama yang menyimpan hash MD5. */
    static String jawabTantangan(String nonce, String cnonceTeks, String password, boolean pakaiMd5Password,
                                 String[] cnonceKeluar) throws IOException {
        if (nonce.length() == 32) {
            String cnonce = md5(cnonceTeks);
            cnonceKeluar[0] = cnonce;
            return md5(md5(password) + ":" + nonce + ":" + cnonce);
        }
        String cnonce = sha256(cnonceTeks);
        cnonceKeluar[0] = cnonce;
        String hashPassword = pakaiMd5Password ? md5(password) : sha256(password);
        String salt = nonce + ":" + cnonce;
        String kunci = hex(pbkdf2Sha256(hashPassword.getBytes(StandardCharsets.UTF_8),
                salt.getBytes(StandardCharsets.UTF_8), 10000));
        return sha256(kunci + ":" + nonce + ":" + cnonce);
    }

    private static String teks(byte[] b, int n) { return new String(b, 0, n, StandardCharsets.US_ASCII).trim(); }

    public static void kirim(String ip, int port, String password, byte[] data, Listener l) throws IOException {
        if (!ipLokal(ip)) throw new IOException("Alamat alat harus alamat jaringan lokal, contoh 192.168.43.20");
        if (!firmwareEsp32(data)) throw new IOException("File bukan firmware ESP32 yang valid atau terlalu besar");
        if (password == null) password = "";
        String md5File = hash("MD5", data);
        InetAddress target = InetAddress.getByName(ip);

        ServerSocket server = new ServerSocket(0);          // alat akan menyambung balik ke sini
        DatagramSocket udp = new DatagramSocket();
        Socket conn = null;
        try {
            int portLokal = server.getLocalPort();
            byte[] undangan = ("0 " + portLokal + " " + data.length + " " + md5File + "\n").getBytes(StandardCharsets.US_ASCII);
            l.onProgress(0, "Menghubungi alat " + ip + "...");

            udp.setSoTimeout(3000);
            String jawab = null;
            byte[] buf = new byte[128];
            for (int coba = 0; coba < 5 && jawab == null; coba++) {
                udp.send(new DatagramPacket(undangan, undangan.length, target, port));
                try {
                    DatagramPacket in = new DatagramPacket(buf, buf.length);
                    udp.receive(in);
                    jawab = teks(buf, in.getLength());
                } catch (SocketTimeoutException e) { /* coba lagi */ }
            }
            if (jawab == null) throw new IOException("Alat tidak menjawab. Pastikan alat online dan HP berada di WiFi yang sama dengan alat.");

            if (jawab.startsWith("AUTH")) {
                String[] bagian = jawab.split("\\s+");
                if (bagian.length < 2) throw new IOException("Jawaban alat tidak dikenal");
                String nonce = bagian[1];
                if (nonce.length() != 32 && nonce.length() != 64) throw new IOException("Jenis autentikasi alat tidak dikenal");
                l.onProgress(0, "Memeriksa password OTA...");
                String cnonceTeks = "firmware.bin" + data.length + md5File + ip + System.nanoTime();
                String[] cnonce = new String[1];
                String respon = jawabTantangan(nonce, cnonceTeks, password, false, cnonce);
                byte[] auth = ("200 " + cnonce[0] + " " + respon + "\n").getBytes(StandardCharsets.US_ASCII);
                udp.send(new DatagramPacket(auth, auth.length, target, port));
                udp.setSoTimeout(10000);
                try {
                    DatagramPacket in = new DatagramPacket(buf, buf.length);
                    udp.receive(in);
                    jawab = teks(buf, in.getLength());
                } catch (SocketTimeoutException e) {
                    throw new IOException("Password OTA salah atau alat tidak menjawab");
                }
            }
            if (!jawab.startsWith("OK")) {
                throw new IOException(jawab.toLowerCase().contains("auth") ? "Password OTA salah" : "Alat menolak: " + jawab);
            }

            l.onProgress(1, "Alat siap, mengirim firmware...");
            server.setSoTimeout(20000);
            try { conn = server.accept(); }
            catch (SocketTimeoutException e) { throw new IOException("Alat tidak menyambung balik ke HP. Pastikan HP dan alat di WiFi yang sama."); }
            if (!conn.getInetAddress().equals(target)) throw new IOException("Sambungan datang dari alamat yang tidak dikenal");

            final Socket sock = conn;
            final long[] terakhir = { System.currentTimeMillis() };
            final boolean[] beres = { false };
            Thread pengawas = new Thread(() -> {            // putuskan bila tidak ada kemajuan 20 detik
                while (!beres[0]) {
                    try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                    if (System.currentTimeMillis() - terakhir[0] > 20000) {
                        try { sock.close(); } catch (IOException ignored) { }
                        return;
                    }
                }
            });
            pengawas.setDaemon(true);
            pengawas.start();

            try {
                OutputStream out = sock.getOutputStream();
                InputStream in = sock.getInputStream();
                sock.setSoTimeout(200);
                final int potongan = 1460;
                int terkirim = 0, persenLalu = -1;
                byte[] sisa = new byte[256];
                StringBuilder ekor = new StringBuilder();
                while (terkirim < data.length) {
                    int n = Math.min(potongan, data.length - terkirim);
                    out.write(data, terkirim, n);
                    terkirim += n;
                    terakhir[0] = System.currentTimeMillis();
                    // ESP32 membalas jumlah byte tiap potongan, baca supaya buffer tidak penuh
                    try {
                        int r = in.available();
                        if (r > 0) {
                            r = in.read(sisa, 0, Math.min(r, sisa.length));
                            if (r > 0) ekor.append(new String(sisa, 0, r, StandardCharsets.US_ASCII));
                            if (ekor.length() > 512) ekor.delete(0, ekor.length() - 64);
                        }
                    } catch (IOException ignored) { }
                    int persen = (int) ((long) terkirim * 98 / data.length) + 1;
                    if (persen != persenLalu) {
                        persenLalu = persen;
                        l.onProgress(persen, "Mengirim " + (terkirim / 1024) + " dari " + (data.length / 1024) + " KB");
                    }
                }
                out.flush();
                l.onProgress(99, "Menunggu alat menulis dan memeriksa firmware...");
                sock.setSoTimeout(1000);
                long batas = System.currentTimeMillis() + 60000;
                boolean ok = ekor.indexOf("OK") >= 0;
                while (!ok && System.currentTimeMillis() < batas) {
                    try {
                        int r = in.read(sisa);
                        if (r < 0) break;
                        terakhir[0] = System.currentTimeMillis();
                        ekor.append(new String(sisa, 0, r, StandardCharsets.US_ASCII));
                        ok = ekor.indexOf("OK") >= 0;
                    } catch (SocketTimeoutException e) { terakhir[0] = System.currentTimeMillis(); }
                }
                if (!ok) throw new IOException("Alat tidak mengonfirmasi. Update mungkin gagal, coba lagi.");
            } finally { beres[0] = true; }
            l.onProgress(100, "Selesai. Alat restart dengan firmware baru.");
        } finally {
            try { if (conn != null) conn.close(); } catch (IOException ignored) { }
            try { server.close(); } catch (IOException ignored) { }
            udp.close();
        }
    }
}
