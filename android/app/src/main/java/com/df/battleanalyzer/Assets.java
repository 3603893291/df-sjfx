package com.df.battleanalyzer;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 把 assets/app/ 伺服成一个真的 https origin（https://dfapp.local/…）。
 *
 * 为什么不用 file:///android_asset：
 *   WebView 对 file:// 世界不给 localStorage / 也不给 worker，插件沙箱那层的
 *   srcdoc + sandbox 行为也会跟着变。用「假 https + 本地伺服」这一手，
 *   页面看到的是一个正常的源，桌面端那套 js 一行都不用改。
 *
 * ★ 伺服范围只认这一个 host，别的一律 return null 交还给网络，
 *   所以 wegame.com.cn 的正常登录流程不会被这条拦住。
 */
final class Assets {

    static final String HOST = "dfapp.local";
    static final String BASE = "https://" + HOST + "/";
    static final String START_URL = BASE + "app/ui/index.html";

    private Assets() {
    }

    static WebResourceResponse serve(Context ctx, WebResourceRequest req) {
        Uri u = req.getUrl();
        if (u == null || !HOST.equals(u.getHost())) return null;
        String p = u.getPath() == null ? "/" : u.getPath();
        if ("/".equals(p)) p = "/app/ui/index.html";
        if (p.contains("..")) return null;
        /* URL 路径与 assets/ 下的相对路径一一对应（装配脚本就是按这个镜像摆文件的） */
        InputStream is;
        try {
            is = ctx.getAssets().open(p.substring(1));
        } catch (Exception e) {
            return null;
        }
        WebResourceResponse res = new WebResourceResponse(mime(p), "utf-8", is);
        Map<String, String> head = new HashMap<String, String>();
        head.put("Cache-Control", "no-store");
        res.setResponseHeaders(head);
        return res;
    }

    static WebResourceResponse text(String contentType, String body) {
        return new WebResourceResponse(contentType, "utf-8",
                new ByteArrayInputStream(body.getBytes()));
    }

    private static String mime(String p) {
        String n = p.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }
}
