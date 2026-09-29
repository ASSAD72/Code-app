package com.codex.android;

import android.app.Activity; import android.os.Bundle; import android.graphics.Color; import android.webkit.*; import android.view.*;

public class MainActivity extends Activity {
    @Override public void onCreate(Bundle b){super.onCreate(b); getWindow().setStatusBarColor(Color.rgb(11,16,32)); getWindow().setNavigationBarColor(Color.rgb(11,16,32));
        WebView w=new WebView(this); w.setBackgroundColor(Color.rgb(11,16,32)); WebSettings s=w.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setAllowFileAccess(false); s.setAllowContentAccess(false); s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        w.addJavascriptInterface(new CodexBridge(this), "CodeXAndroid"); w.setWebViewClient(new WebViewClient()); w.loadUrl("file:///android_asset/index.html"); setContentView(w); }
}
