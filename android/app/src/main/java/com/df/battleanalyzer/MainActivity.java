package com.df.battleanalyzer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/**
 * 主窗口：整个软件就是这一个 WebView，加载的是 assets/app/ui/index.html
 * （伺服成 https://dfapp.local/…，见 Assets 的注释）。
 *
 * 页面里跑的是桌面端**同一份** core/ 与 ui/ —— 判定、分析、界面都不重写；
 * 只有一层新东西：window.df 由 android/js/df-android.js 实现，它往下够到的
 * 就是下面这一个洞（DfBridge）。除此之外原生什么都不懂。
 */
public class MainActivity extends Activity {

    static MainActivity self;

    private WebView web;
    private DfBridge bridge;
    private String bridgeToken = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        self = this;

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        /* 混全内容一律不许：假 https 源里掺一条 http 资源就等于把页面交出去 */
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        /* ★ 只有"可调试构建"才开远程调试：这台机器现在能用 adb + CDP 把页面当回归目标驱动
         *   （MuMu 上真跑一遍导入插件、装包、地图名那一发）。判据用 FLAG_DEBUGGABLE 而不是 BuildConfig，
         *   因为它跟着包体走 —— release 签名构建里这道门自动是关的，别人拿不到原生洞。 */
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        /* ★ 桥令牌：随首页 URL 只进主框。
         *   插件页是同 WebView 里的 null 源沙箱帧，而 addJavascriptInterface 注入的对象
         *   在子框里也看得见 —— 没有这道闸，插件可以绕过宿主所有权限判定直接 fs.read 战绩库。
         *   沙箱帧读不到父框的 location（跨源），于是它手上永远没有这颗令牌。
         *   Activity 重建时令牌必须一起恢复：restoreState 带回来的是那条带着旧令牌的 URL。 */
        if (savedInstanceState != null && savedInstanceState.getString("bridgeToken") != null) {
            bridgeToken = savedInstanceState.getString("bridgeToken");
        } else {
            bridgeToken = newToken();
        }
        bridge = new DfBridge(this, bridgeToken);
        web.addJavascriptInterface(bridge, "AndroidBridge");
        web.setWebViewClient(new Shell());
        /* ★ 真全屏（他 2026-09-24 拍的）：那条栏根本不显示，挡无可挡 —— 上一版靠 insets 让开，
         *   而 insets 能不能派发到 WebView 在几家 ROM 上表现不一致，本机没设备改不动也验不了。 */
        SystemBars.immersive(this);
        setContentView(web);
        /* 只让挖孔：全屏不等于把顶部那颗筛选栏塞进摄像头孔里。
         * 状态栏/导航栏的高度一概不计 —— 它们已经隐藏了，计了就是凭空多出一条带子。 */
        SystemBars.fit(web, true);
        SystemBars.paint(this, web, !SystemBars.isNight(this));

        if (savedInstanceState == null) {
            web.loadUrl(Assets.START_URL + "?bt=" + bridgeToken);
        } else web.restoreState(savedInstanceState);
    }

    /** 128 位随机；崩了重来就换一颗，同一颗绝不用两次 */
    private static String newToken() {
        byte[] b = new byte[16];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < b.length; i++) sb.append(String.format("%02x", b[i]));
        return sb.toString();
    }

    java.util.concurrent.ExecutorService pool() {
        return bridge == null ? null : bridge.pool();
    }

    /** uiMode 在 configChanges 里 → 深浅色切换不会重建 Activity，颜色得自己重刷一遍。 */
    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        SystemBars.paint(this, web, !SystemBars.isNight(this));
        web.requestApplyInsets();
    }

    /** 跳出去授权（QQ / 微信）再回来，系统会把那两条栏显示回来 —— 拿回焦点这一刻重贴一次全屏。 */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) SystemBars.immersive(this);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString("bridgeToken", bridgeToken);
        web.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        bridge.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /* ----------------------------------------------- 页面 ↔ 原生 */

    void reply(int id, String json) {
        eval("window.__reply && window.__reply(" + id + "," + JSONObject.quote(json) + ");");
    }

    /** 对应桌面端 main.js 的 emit(channel, payload) */
    void event(final String name, String payloadJson) {
        if (payloadJson == null || payloadJson.isEmpty()) payloadJson = "{}";
        /* JSON 允许字符串里裸带 U+2028/U+2029，而 JS 字符串字面量在 ES2019 之前不认 ——
         * 玩家昵称里有一个就会把注入的这一行截断。花名是外部输入，这里先转义再说。 */
        payloadJson = payloadJson.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        final String js = "window.__nativeEvent && window.__nativeEvent("
                + JSONObject.quote(name) + "," + payloadJson + ");";
        eval(js);
    }

    private void eval(final String js) {
        if (web == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(js, null);
            }
        });
    }

    /* ----------------------------------------------- 伺服与跳转 */

    private class Shell extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            return Assets.serve(MainActivity.this, req);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            String scheme = u == null || u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            if ("https".equals(scheme)) {
                /* 我们自己的假源留在页面里；其余 https 交给系统浏览器 ——
                 * 主窗口不该变成别人的网页容器 */
                return !Assets.HOST.equals(u.getHost()) && launchExternal(u.toString());
            }
            if ("http".equals(scheme)) return launchExternal(u.toString());
            return true;    // 其余 scheme 一律不放行（主窗口没有理由跳 mqq:// 之类）
        }
    }

    private boolean launchExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            // 没有对应应用：留在原地比崩掉好
        }
        return true;
    }
}
