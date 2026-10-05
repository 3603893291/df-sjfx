package com.df.battleanalyzer;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 登录窗口。桌面端对应 main.js 的 openLoginWindow()：一个独立窗口 + 一句"在那边登录"。
 *
 * 这一版按使用者的裁定走 **同机授权跳转**（不是扫码）：
 *   手机自己显示二维码自己扫，物理上不成立 —— 所以这里用 WebView 默认的
 *   **手机 UA** 打开 WeGame 战绩页，让页面自己给出「QQ 授权 / 微信授权」那颗按钮，
 *   点下去跳本机应用，确认后再回到这里。UA 一次都不覆盖，就是为了这个。
 *
 * ★ 桌面端每个号一个持久化分区（persist:wegame-slot-N），安卓只有一个 cookie 罐。
 *   所以本机上的"多个账号"在登录态这一层是**共用一个 WeGame 会话**的 ——
 *   切号会重新走这个窗口。这条差异必须写在说明书里，不能装作和桌面一样。
 */
public class LoginActivity extends Activity {

    static final String LOGIN_URL = "https://www.wegame.com.cn/helper/df/score/";
    private WebView web;
    private String slot = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        slot = slotOf(getIntent());

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setBackgroundColor(Color.parseColor("#0e1116"));
        col.addView(bar(), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        web = new WebView(this);
        col.addView(web, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(col);
        /* 这一窗**不做**真全屏：里面是 WeGame 与 QQ/微信 自己的页面，那颗「同意 / 授权」常贴着底边，
         * 藏掉导航栏等于替别人把按钮挡在屏外。所以照旧让开状态栏与导航栏（fit 第二个参数 false）。 */
        SystemBars.fit(col, false);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebViewClient(new Client());
        startFreshSession();
    }

    /** ★ 这颗 activity 在 manifest 里是 singleTop，所以连点两下「打开登录窗口」落到的是**同一个实例**：
     *   换号、再清一遍、重新加载。不这么做就会叠两层，而前面那扇关掉的瞬间推一条 login:window-closed，
     *   把还留在屏幕上的这一扇的轮询停掉 —— 人在里面登录成功，软件也不认（症状与"停在登录页"同一条）。 */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        slot = slotOf(intent);
        startFreshSession();
    }

    private static String slotOf(Intent it) {
        String wanted = it == null ? null : it.getStringExtra("slot");
        return wanted == null ? "" : wanted;
    }

    /** 开一窗 = 全新会话。onCreate 与 onNewIntent 共用这一句，两处不许各写各的。 */
    private void startFreshSession() {
        /* ★ 必须在 loadUrl 之前：这一窗一打开就是全新会话（见 wipeSession 的注释） */
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        wipeSession(web);
        web.loadUrl(LOGIN_URL);
    }

    /**
     * ★ 使用者裁定（2026-09-25）：**只有「打开登录浏览器」这一件事**会把整机的会话痕迹清干净。
     *
     * 为什么是这里：罐子里残留的上一次半死会话，正是 WeGame 页面显示「无角色信息」、
     * 而软件两套账号体系都问不到角色、于是永远停在登录页的温床 —— 强制新会话是唯一能从
     * 我们这一侧切断它的办法（官方那页给不给别的登录入口我们决定不了）。
     *
     * 边界（红线盯着，别处一律不许清）：主界面、同步、切号、导出、启动都不碰这里；
     * 设置页那颗「退出登录」走 DfBridge 的 `login.clearCookies`，那是使用者主动点的、语义就是清，
     * 但它只清 cookie，不做本方法这一整套。minSdk 24，所以 21/19 那几个版本判断都不需要。
     */
    static void wipeSession(WebView web) {
        CookieManager cm = CookieManager.getInstance();
        /* 按官方定义，removeAllCookies 清的是这个状态里的**全部** cookie（会话 cookie 也算在内），
         * 所以不再另发一条 removeSessionCookies —— 那条在 compileSdk 36 的桩里只剩带回调的重载，
         * 而且它想补的那半件事这一发已经做完了。 */
        cm.removeAllCookies(null);
        cm.flush();
        if (web == null) return;
        web.clearCache(true);
        web.clearFormData();
        web.clearHistory();
        web.clearSslPreferences();
        /* DOM/local storage 不在 WebView 上清，在 WebStorage 上（上一版这里写的
         * web.clearLocalStorage() 根本不存在，是 gradle 编译拒绝时才发现的）。
         * 这一发清的是**整机**所有源的存储：WeGame / QQ / 微信 的登录痕迹也在里面。
         * 少掉的一条是 HTTP 认证缓存：它在 WebViewDatabase 上，取实例要另一套入口，
         * 而 WeGame 这条链从来不走 HTTP Basic 认证 —— 不为它多开一条会漏权限的路。 */
        WebStorage.getInstance().deleteAllData();
    }

    private View bar() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackgroundColor(Color.parseColor("#14181f"));
        row.addView(button("← 返回", new Runnable() {
            @Override
            public void run() {
                finish();
            }
        }));
        row.addView(button("刷新", new Runnable() {
            @Override
            public void run() {
                web.reload();
            }
        }));
        TextView tip = new TextView(this);
        tip.setText("选 QQ / 微信 → 在应用里点确认 → 会自动回到这里");
        tip.setTextColor(Color.parseColor("#8b98a9"));
        tip.setTextSize(12f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        lp.leftMargin = 10;
        lp.rightMargin = 10;
        row.addView(tip, lp);
        return row;
    }

    private View button(String label, final Runnable action) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextColor(Color.parseColor("#e6ebf2"));
        t.setTextSize(14f);
        t.setPadding(28, 26, 28, 26);
        t.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                action.run();
            }
        });
        return t;
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        CookieManager.getInstance().flush();
        super.onDestroy();
        if (MainActivity.self != null) {
            try {
                MainActivity.self.event("login:window-closed",
                        new JSONObject().put("slot", slot).toString());
            } catch (Exception e) {
                android.util.Log.w("df-login", "关窗事件没发出去：" + e);
            }
        }
    }

    private class Client extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            return Assets.serve(LoginActivity.this, req);
        }

        /** 授权跳转就发生在这一条：mqqconnect:// weixin:// tencent:// 之类要放它出去，回来后 cookie 落在同一个罐里 */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (u == null) return true;
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            if ("http".equals(scheme) || "https".equals(scheme)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            } catch (Exception e) {
                Toast.makeText(LoginActivity.this,
                        "这台机器上没有装对应的应用（" + scheme + "://）", Toast.LENGTH_LONG).show();
                return true;
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            CookieManager.getInstance().flush();
        }
    }

}
