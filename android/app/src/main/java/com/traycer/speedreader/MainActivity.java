package com.traycer.speedreader;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String HOME_URL = "https://localhost/";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(ScreenControlPlugin.class);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (handleWebBackNavigation()) {
                    return;
                }
                setEnabled(false);
                try {
                    getOnBackPressedDispatcher().onBackPressed();
                } finally {
                    setEnabled(true);
                }
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (handleWebBackNavigation()) {
            return;
        }
        super.onBackPressed();
    }

    private boolean handleWebBackNavigation() {
        if (bridge == null) {
            return false;
        }
        WebView webView = bridge.getWebView();
        if (webView == null) {
            return false;
        }

        if (webView.canGoBack()) {
            webView.goBack();
            return true;
        }

        String currentUrl = webView.getUrl();
        if (currentUrl == null) {
            return false;
        }

        Uri uri = Uri.parse(currentUrl);
        String path = uri.getPath();
        boolean isHomePath = path == null || path.isEmpty() || "/".equals(path);
        if (!isHomePath) {
            webView.loadUrl(HOME_URL);
            return true;
        }
        return false;
    }
}
