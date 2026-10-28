package com.bluelot.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends Activity {
    private static final String SITE = "https://chargers.kitu.io/api/site/8";
    private static final String PREFS = "bluelot";
    private static final String PINS = "pins";

    private WebView webView;
    private SharedPreferences prefs;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicInteger generation = new AtomicInteger();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0C1110"));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.addJavascriptInterface(new Bridge(), "BlueLotNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return true;
                String scheme = uri.getScheme();
                if (scheme == null) return true;
                if ("mailto".equals(scheme)) {
                    Intent mail = new Intent(Intent.ACTION_SENDTO, uri);
                    try {
                        startActivity(mail);
                    } catch (ActivityNotFoundException ignored) {
                        /* no mail app */
                    }
                    return true;
                }
                if (!"https".equals(scheme) && !"http".equals(scheme)) return true;
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                try {
                    startActivity(intent);
                } catch (ActivityNotFoundException ignored) {
                    return true;
                }
                return true;
            }
        });

        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){return !!(window.blueLotBack&&window.blueLotBack());})()",
                result -> {
                    if (!"true".equals(result)) finish();
                });
    }

    @Override
    protected void onDestroy() {
        generation.incrementAndGet();
        executor.shutdownNow();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void deliver(final int gen, final String body) {
        if (webView == null || gen != generation.get()) return;
        final String arg = body == null ? "null" : JSONObject.quote(body);
        webView.post(() -> {
            if (webView == null || gen != generation.get() || isFinishing()) return;
            webView.evaluateJavascript("window.onSitePayload&&window.onSitePayload(" + arg + ")", null);
        });
    }

    private String download() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(SITE).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "BlueLot/1.0 Android");
            int code = conn.getResponseCode();
            if (code != 200) return null;
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) {
                bos.write(buf, 0, n);
                if (bos.size() > 2_000_000) return null;
            }
            return bos.toString("UTF-8");
        } catch (Exception ignored) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private final class Bridge {
        @JavascriptInterface
        public void refresh() {
            final int gen = generation.incrementAndGet();
            executor.execute(() -> deliver(gen, download()));
        }

        @JavascriptInterface
        public String getPins() {
            return prefs.getString(PINS, "[]");
        }

        @JavascriptInterface
        public void setPins(String json) {
            if (json == null || json.length() > 8000) return;
            prefs.edit().putString(PINS, json).apply();
        }
    }
}
