package com.pakanikan.app;

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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Aplikasi ini "bingkai" WebView. Tampilan dan logika ada di folder assets.
 * Update firmware ESP32 lewat WiFi (ArduinoOTA) ditulis di sini (kelas EspOta)
 * karena JavaScript di WebView tidak bisa membuka socket UDP/TCP.
 * JavaScript memanggilnya lewat objek window.PakanOta.
 */
public class MainActivity extends Activity {

    private static final int KODE_PILIH_FILE = 42;

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private volatile byte[] firmware;
    private volatile boolean sibuk = false;

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

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
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
