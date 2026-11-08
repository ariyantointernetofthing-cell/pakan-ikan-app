package com.pakanikan.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
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
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * Aplikasi ini "bingkai" WebView. Tampilan dan logika ada di folder assets.
 * Bagian Bluetooth (update firmware ESP32) ditulis di sini karena WebView
 * tidak bisa memakai Bluetooth sendiri. JavaScript memanggilnya lewat
 * objek window.PakanBle.
 */
@SuppressLint("MissingPermission")
public class MainActivity extends Activity {

    private static final UUID UUID_SERVICE = UUID.fromString("6e1a0001-7c3b-4f2a-9d1e-5a4b3c2d1e0f");
    private static final UUID UUID_KONTROL = UUID.fromString("6e1a0002-7c3b-4f2a-9d1e-5a4b3c2d1e0f");
    private static final UUID UUID_DATA    = UUID.fromString("6e1a0003-7c3b-4f2a-9d1e-5a4b3c2d1e0f");
    private static final UUID UUID_CCCD    = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final String NAMA_ALAT = "PakanIkan-OTA";

    private static final int KODE_IZIN = 41;
    private static final int KODE_PILIH_FILE = 42;

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());

    // Status update Bluetooth
    private byte[] firmware;
    private String namaFile = "";
    private int offset = 0;
    private int ukuranPotongan = 180;
    private int persenTerakhir = -1;
    private boolean sedangUpdate = false;
    private boolean selesai = false;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic charKontrol;
    private BluetoothGattCharacteristic charData;
    private BluetoothLeScanner pemindai;

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

        web.addJavascriptInterface(new JembatanBle(), "PakanBle");

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
        tutupKoneksi();
        super.onDestroy();
    }

    // =================================================================
    //  Jembatan JavaScript <-> Android
    // =================================================================
    private class JembatanBle {
        @JavascriptInterface
        public void mulaiUpdate() {
            handler.post(MainActivity.this::langkahIzin);
        }

        @JavascriptInterface
        public void batal() {
            handler.post(() -> {
                if (sedangUpdate && charKontrol != null) tulis(charKontrol, "ABORT".getBytes(StandardCharsets.UTF_8), true);
                gagal("Dibatalkan.");
            });
        }

        @JavascriptInterface
        public boolean tersedia() {
            return true;
        }
    }

    /** Kirim kabar ke JavaScript: window.otaKabar(jenis, pesan, persen) */
    private void kabar(String jenis, String pesan, int persen) {
        final String js = "window.otaKabar && window.otaKabar(" + JSONObject.quote(jenis) + "," +
                JSONObject.quote(pesan) + "," + persen + ")";
        handler.post(() -> web.evaluateJavascript(js, null));
    }

    // =================================================================
    //  Langkah 1: izin Bluetooth
    // =================================================================
    private String[] izinDibutuhkan() {
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT};
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    private void langkahIzin() {
        if (sedangUpdate) {
            kabar("info", "Update sedang berjalan.", Math.max(persenTerakhir, 0));
            return;
        }
        List<String> kurang = new ArrayList<>();
        for (String p : izinDibutuhkan()) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) kurang.add(p);
        }
        if (!kurang.isEmpty()) {
            requestPermissions(kurang.toArray(new String[0]), KODE_IZIN);
            return;
        }
        langkahCekBluetooth();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != KODE_IZIN) return;
        for (int r : grantResults) {
            if (r != PackageManager.PERMISSION_GRANTED) {
                kabar("error", "Izin Bluetooth ditolak. Izinkan di Pengaturan HP > Aplikasi > Pakan Ikan > Izin.", 0);
                return;
            }
        }
        langkahCekBluetooth();
    }

    private void langkahCekBluetooth() {
        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null) {
            kabar("error", "HP ini tidak punya Bluetooth.", 0);
            return;
        }
        if (!adapter.isEnabled()) {
            kabar("error", "Bluetooth HP masih mati. Nyalakan Bluetooth lalu coba lagi.", 0);
            return;
        }
        // Langkah 2: pilih file firmware
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(i, KODE_PILIH_FILE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != KODE_PILIH_FILE) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            kabar("info", "Tidak ada file yang dipilih.", 0);
            return;
        }
        Uri uri = data.getData();
        try {
            namaFile = ambilNamaFile(uri);
            firmware = bacaSemua(uri);
        } catch (Exception e) {
            kabar("error", "Gagal membaca file: " + e.getMessage(), 0);
            return;
        }
        if (firmware == null || firmware.length < 1024 || (firmware[0] & 0xFF) != 0xE9) {
            kabar("error", "File \"" + namaFile + "\" bukan firmware ESP32 (.bin). Pilih file hasil Export Compiled Binary.", 0);
            return;
        }
        langkahPindai();
    }

    private String ambilNamaFile(Uri uri) {
        String nama = "firmware.bin";
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) nama = c.getString(idx);
            }
        } catch (Exception ignored) { }
        return nama;
    }

    private byte[] bacaSemua(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    // =================================================================
    //  Langkah 3: cari alat lewat Bluetooth
    // =================================================================
    private final ScanCallback cbPindai = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            if (!sedangUpdate || gatt != null) return;
            // Cocokkan nama alat atau UUID layanan update
            boolean cocok = false;
            if (result.getScanRecord() != null) {
                String nama = result.getScanRecord().getDeviceName();
                if (NAMA_ALAT.equals(nama)) cocok = true;
                List<ParcelUuid> uuids = result.getScanRecord().getServiceUuids();
                if (uuids != null && uuids.contains(new ParcelUuid(UUID_SERVICE))) cocok = true;
            }
            if (!cocok) return;
            BluetoothDevice dev = result.getDevice();
            hentikanPindai();
            kabar("info", "Alat ditemukan, menyambung...", 0);
            gatt = dev.connectGatt(MainActivity.this, false, cbGatt, BluetoothDevice.TRANSPORT_LE);
        }

        @Override
        public void onScanFailed(int errorCode) {
            gagal("Gagal mencari Bluetooth (kode " + errorCode + "). Pastikan Lokasi HP menyala.");
        }
    };

    private void langkahPindai() {
        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        pemindai = bm.getAdapter().getBluetoothLeScanner();
        if (pemindai == null) {
            kabar("error", "Bluetooth belum siap. Coba lagi.", 0);
            return;
        }
        sedangUpdate = true;
        selesai = false;
        offset = 0;
        persenTerakhir = -1;
        kabar("info", "File " + namaFile + " (" + (firmware.length / 1024) + " KB). Mencari alat \"" + NAMA_ALAT + "\"...", 0);

        ScanSettings set = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        pemindai.startScan(Collections.<ScanFilter>emptyList(), set, cbPindai);

        handler.postDelayed(() -> {
            if (sedangUpdate && gatt == null) {
                gagal("Alat tidak ditemukan. Pastikan alat dalam mode update (LED menyala tetap) dan berada dekat HP.");
            }
        }, 20000);
    }

    private void hentikanPindai() {
        try { if (pemindai != null) pemindai.stopScan(cbPindai); } catch (Exception ignored) { }
    }

    // =================================================================
    //  Langkah 4: kirim firmware
    // =================================================================
    private final BluetoothGattCallback cbGatt = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                kabar("info", "Tersambung. Menyiapkan...", 0);
                handler.post(() -> g.requestMtu(517));
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                if (selesai) {
                    tutupKoneksi();
                } else if (sedangUpdate) {
                    gagal("Sambungan Bluetooth terputus (status " + status + "). Coba lagi dengan HP lebih dekat ke alat.");
                }
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            ukuranPotongan = Math.max(20, Math.min(mtu - 3, 500));
            handler.post(g::discoverServices);
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            BluetoothGattService svc = g.getService(UUID_SERVICE);
            if (svc == null) {
                gagal("Layanan update tidak ditemukan di alat. Pastikan firmware alat versi 3 atau lebih baru.");
                return;
            }
            charKontrol = svc.getCharacteristic(UUID_KONTROL);
            charData = svc.getCharacteristic(UUID_DATA);
            if (charKontrol == null || charData == null) {
                gagal("Karakteristik update tidak lengkap.");
                return;
            }
            g.setCharacteristicNotification(charKontrol, true);
            BluetoothGattDescriptor cccd = charKontrol.getDescriptor(UUID_CCCD);
            if (cccd == null) {
                gagal("Notifikasi alat tidak tersedia.");
                return;
            }
            byte[] nyala = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
            if (Build.VERSION.SDK_INT >= 33) {
                g.writeDescriptor(cccd, nyala);
            } else {
                cccd.setValue(nyala);
                g.writeDescriptor(cccd);
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            String perintah = "START:" + firmware.length;
            tulis(charKontrol, perintah.getBytes(StandardCharsets.UTF_8), true);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (!sedangUpdate || !UUID_DATA.equals(c.getUuid())) return;
            if (status != BluetoothGatt.GATT_SUCCESS) {
                gagal("Gagal mengirim data (status " + status + ").");
                return;
            }
            kirimPotongan();
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            terimaKabarAlat(value);
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            if (Build.VERSION.SDK_INT >= 33) return; // sudah ditangani versi baru di atas
            terimaKabarAlat(c.getValue());
        }
    };

    private void terimaKabarAlat(byte[] value) {
        if (value == null) return;
        String pesan = new String(value, StandardCharsets.UTF_8);
        if (pesan.equals("READY")) {
            kabar("progres", "Mengirim firmware...", 0);
            kirimPotongan();
        } else if (pesan.equals("DONE")) {
            selesai = true;
            sedangUpdate = false;
            kabar("selesai", "Update berhasil. Alat sedang restart dengan firmware baru.", 100);
            handler.postDelayed(this::tutupKoneksi, 1500);
        } else if (pesan.startsWith("ERR:")) {
            gagal(pesan.substring(4));
        }
    }

    private void kirimPotongan() {
        if (!sedangUpdate) return;
        if (offset >= firmware.length) {
            kabar("progres", "Memeriksa firmware di alat...", 100);
            tulis(charKontrol, "END".getBytes(StandardCharsets.UTF_8), true);
            return;
        }
        int n = Math.min(ukuranPotongan, firmware.length - offset);
        byte[] potong = new byte[n];
        System.arraycopy(firmware, offset, potong, 0, n);
        offset += n;

        int persen = (int) ((long) offset * 100 / firmware.length);
        if (persen != persenTerakhir) {
            persenTerakhir = persen;
            kabar("progres", "Mengirim firmware... " + (offset / 1024) + " / " + (firmware.length / 1024) + " KB", persen);
        }
        if (!tulis(charData, potong, true)) {
            // Antrian Bluetooth penuh: coba lagi sebentar lagi
            offset -= n;
            handler.postDelayed(this::kirimPotongan, 30);
        }
    }

    private boolean tulis(BluetoothGattCharacteristic c, byte[] nilai, boolean pakaiRespon) {
        if (gatt == null || c == null) return false;
        int tipe = pakaiRespon ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                               : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
        if (Build.VERSION.SDK_INT >= 33) {
            return gatt.writeCharacteristic(c, nilai, tipe) == BluetoothStatusCodes.SUCCESS;
        }
        c.setWriteType(tipe);
        c.setValue(nilai);
        return gatt.writeCharacteristic(c);
    }

    private void gagal(String pesan) {
        boolean tadinyaJalan = sedangUpdate;
        sedangUpdate = false;
        hentikanPindai();
        tutupKoneksi();
        if (tadinyaJalan || !selesai) kabar("error", pesan, Math.max(persenTerakhir, 0));
    }

    private void tutupKoneksi() {
        try {
            if (gatt != null) {
                gatt.disconnect();
                gatt.close();
            }
        } catch (Exception ignored) { }
        gatt = null;
        charKontrol = null;
        charData = null;
    }
}
