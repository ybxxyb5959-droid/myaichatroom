package io.github.ybxxyb5959.chatroom.owner;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private WebView web;
    private Uri owner;
    private TextView status;
    private boolean loadFailed;
    private boolean ownerAddress(Uri uri) {
        return "https".equals(uri.getScheme()) && uri.getHost() != null
            && uri.getHost().matches("[a-zA-Z0-9.-]+\\.ts\\.net") && uri.getPort() == 8444
            && uri.getUserInfo() == null;
    }
    private boolean sameOwner(Uri uri) {
        return owner != null && ownerAddress(uri) && owner.getHost().equals(uri.getHost());
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(this);
        status.setText("PC와 서버, 휴대폰 Tailscale이 켜져 있어야 합니다. PC의 내 휴대폰 연결에서 방장 전용 :8444 HTTPS QR 링크를 붙여넣으세요. 친구 공개 :8443 주소는 방장 접속용으로 사용할 수 없습니다.");
        layout.addView(status);
        EditText address = new EditText(this); address.setSingleLine(true); address.setHint("https://내PC.ts.net:8444/join#...");
        address.setText(getPreferences(MODE_PRIVATE).getString("origin", "")); layout.addView(address);
        Button connect = new Button(this); connect.setText("방장 PC에 연결"); layout.addView(connect);
        web = new WebView(this); layout.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setUserAgentString(settings.getUserAgentString() + " AIChatroomOwner/1");
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { loadFailed = false; }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("aichatroom-share".equals(uri.getScheme())) {
                    if (request.isForMainFrame() && view.getUrl() != null && sameOwner(Uri.parse(view.getUrl()))) share(uri);
                    return true;
                }
                if (sameOwner(uri)) return false;
                if (request.isForMainFrame() && request.hasGesture() && "https".equals(uri.getScheme()))
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (!loadFailed) status.setText("PC 서버에 연결됨 · 친구 링크는 앱의 공유 버튼으로 전송하세요.");
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { loadFailed = true; status.setText("PC에 연결할 수 없습니다. PC 서버와 Tailscale을 확인한 뒤 다시 연결하세요."); }
            }
        });
        connect.setOnClickListener(v -> {
            Uri uri = Uri.parse(address.getText().toString().trim());
            if (!ownerAddress(uri)) { status.setText("방장 전용 https://PC.ts.net:8444 주소만 연결할 수 있습니다."); return; }
            owner = uri;
            String origin = "https://" + uri.getHost() + ":8444";
            getPreferences(MODE_PRIVATE).edit().putString("origin", origin).apply();
            web.loadUrl(uri.toString());
            address.setText(origin); // Do not retain invite tokens in the address field.
        });
    }
    private void share(Uri request) {
        String value = request.getQueryParameter("url");
        if (value == null || value.length() > 2000) return;
        Uri link = Uri.parse(value);
        if (!"https".equals(link.getScheme()) || !owner.getHost().equals(link.getHost())
            || link.getPort() != 8443 || link.getUserInfo() != null || !"/join".equals(link.getPath())) return;
        Uri fragment = Uri.parse("https://local/?" + link.getFragment());
        if (!"guest".equals(fragment.getQueryParameter("role"))) return;
        Intent send = new Intent(Intent.ACTION_SEND); send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, value);
        startActivity(Intent.createChooser(send, "친구에게 AI 단톡방 링크 공유"));
    }
    @Override protected void onPause() { CookieManager.getInstance().flush(); web.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
