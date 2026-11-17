package com.pakanikan.app;

import android.util.Base64;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Aplikasi ini "bingkai" WebView. Tampilan dan logika ada di folder assets.
 * Update firmware ESP32 lewat WiFi (ArduinoOTA) ditulis di sini (kelas EspOta)
 * karena JavaScript di WebView tidak bisa membuka socket UDP/TCP.
 * JavaScript memanggilnya lewat objek window.PakanOta.
 * Ekspor CSV juga lewat sini (simpanCsv) karena WebView tidak bisa mengunduh file sendiri.
 */
public class MainActivity extends Activity {

    private static final int KODE_PILIH_FILE = 42;
    private static final int KODE_SIMPAN_CSV = 43;

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private volatile byte[] firmware;
    private volatile boolean sibuk = false;
    private volatile String csvTertunda;   // isi CSV yang menunggu dipilih lokasi simpannya

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        setContentView(web);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });

        web.addJavascriptInterface(new JembatanOta(), "PakanOta");

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        if (web != null) {
            web.removeJavascriptInterface("PakanOta");
            web.destroy();
        }
        super.onDestroy();
    }

    /** Kirim kabar ke JavaScript: window.otaKabar(jenis, pesan, persen) */
    private void kabar(String jenis, String pesan, int persen) {
        final String js = "window.otaKabar && window.otaKabar(" + JSONObject.quote(jenis) + "," +
                JSONObject.quote(pesan == null ? "" : pesan) + "," + persen + ")";
        handler.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    // =================================================================
    //  Jembatan JavaScript <-> Android
    // =================================================================
    private class JembatanOta {
        @JavascriptInterface
        public boolean tersedia() { return true; }

        /** Isi file .bin yang dipilih dalam bentuk base64, untuk update lewat Firebase. */
        @JavascriptInterface
        public String ambilBase64() {
            final byte[] d = firmware;
            return d == null ? "" : Base64.encodeToString(d, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public void pilihFile() {
            handler.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(i, KODE_PILIH_FILE);
            });
        }

        @JavascriptInterface
        public void simpanCsv(final String namaFile, final String isi) {
            csvTertunda = isi;
            handler.post(() -> {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("text/csv");
                i.putExtra(Intent.EXTRA_TITLE, namaFile == null || namaFile.isEmpty() ? "pakan-ikan.csv" : namaFile);
                startActivityForResult(i, KODE_SIMPAN_CSV);
            });
        }

        @JavascriptInterface
        public void kirim(final String ip, final String password) {
            if (sibuk) { kabar("error", "Pengiriman sebelumnya masih berjalan.", 0); return; }
            final byte[] data = firmware;
            if (data == null) { kabar("error", "Pilih file .bin dulu.", 0); return; }
            sibuk = true;
            handler.post(() -> web.setKeepScreenOn(true));
            io.execute(() -> {
                try {
                    EspOta.kirim(ip == null ? "" : ip.trim(), EspOta.PORT_BAWAAN, password, data,
                            (persen, pesan) -> kabar("progres", pesan, persen));
                    kabar("selesai", "Update berhasil. Alat restart, tunggu sekitar 30 detik sampai online lagi.", 100);
                } catch (Exception e) {
                    kabar("error", e.getMessage() == null ? "Gagal mengirim firmware" : e.getMessage(), 0);
                } finally {
                    sibuk = false;
                    handler.post(() -> web.setKeepScreenOn(false));
                }
            });
        }
    }

    /** Kirim hasil simpan CSV ke JavaScript: window.csvKabar(berhasil, pesan) */
    private void kabarCsv(boolean berhasil, String pesan) {
        final String js = "window.csvKabar && window.csvKabar(" + berhasil + "," + JSONObject.quote(pesan) + ")";
        handler.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    private void tulisCsv(final Uri uri) {
        final String isi = csvTertunda;
        csvTertunda = null;
        if (isi == null) { kabarCsv(false, "Tidak ada data untuk disimpan."); return; }
        io.execute(() -> {
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IOException("File tidak bisa dibuat");
                out.write(new byte[]{(byte) 0xEF, (byte) 0xBB, (byte) 0xBF});   // BOM supaya Excel membaca UTF-8
                out.write(isi.getBytes(StandardCharsets.UTF_8));
                out.flush();
                kabarCsv(true, "CSV tersimpan: " + namaFile(uri));
            } catch (Exception e) {
                kabarCsv(false, e.getMessage() == null ? "Gagal menyimpan CSV" : e.getMessage());
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == KODE_SIMPAN_CSV) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) tulisCsv(data.getData());
            else { csvTertunda = null; kabarCsv(false, "Penyimpanan dibatalkan."); }
            return;
        }
        if (requestCode != KODE_PILIH_FILE) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            kabar("info", "Tidak ada file yang dipilih.", 0);
            return;
        }
        final Uri uri = data.getData();
        io.execute(() -> {
            try {
                byte[] d = bacaFile(uri);
                if (!EspOta.firmwareEsp32(d)) {
                    throw new IOException("File ini bukan firmware ESP32. Pakai file .bin hasil Export Compiled Binary " +
                            "(bukan yang berakhiran merged, bootloader, atau partitions).");
                }
                firmware = d;
                kabar("file", namaFile(uri) + " (" + (d.length / 1024) + " KB)", 0);
            } catch (Exception e) {
                firmware = null;
                kabar("error", e.getMessage() == null ? "Gagal membaca file" : e.getMessage(), 0);
            }
        });
    }

    private byte[] bacaFile(Uri uri) throws IOException {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("File tidak bisa dibuka");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n, total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > EspOta.MAX_BIN) throw new IOException("File terlalu besar untuk partisi OTA ESP32 (maks 1,9 MB)");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    private String namaFile(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return c.getString(idx);
            }
        } catch (Exception ignored) { }
        String p = uri.getLastPathSegment();
        return p == null ? "firmware.bin" : p;
    }
}
