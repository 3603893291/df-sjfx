package com.df.battleanalyzer;

import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 采集通道：只往 WeGame 那一个前缀发 POST，cookie 从 WebView 的 CookieManager 取。
 *
 * ★ 两道硬规矩，都是桌面端已有的语义：
 *   1) 路径必须是 /api/v1/wegame.pallas.dfm.DfmBattle/&lt;字母数字下划线&gt;，
 *      JS 说往哪儿发不算数 —— 这条通道去不了别的站（别的站属于插件那道闸门，#34）。
 *   2) 永不把 cookie 的值回给页面：只回 {ok,text}，text 是接口原文。
 */
public final class WegameHttp {

    static final String ORIGIN = "https://www.wegame.com.cn";
    static final String PREFIX = "/api/v1/wegame.pallas.dfm.DfmBattle/";
    /** 照抄桌面 shell/adapters/net.js 那串：接口那边认的是它 */
    static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private static final int MAX_BYTES = 4 * 1024 * 1024;

    private WegameHttp() {
    }

    static String post(String pathname, String body) {
        JSONObject out = new JSONObject();
        HttpURLConnection conn = null;
        try {
            if (pathname == null) throw new Exception("缺少路径");
            String clean = pathname.replace("\\", "/");
            if (!clean.startsWith(PREFIX)) throw new Exception("采集通道只认 WeGame 战绩接口前缀");
            String name = clean.substring(PREFIX.length()).replaceAll("[^A-Za-z0-9_]", "");
            if (name.isEmpty()) throw new Exception("接口名为空");

            conn = (HttpURLConnection) new URL(ORIGIN + PREFIX + name).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("content-type", "application/json");
            conn.setRequestProperty("accept", "application/json, text/plain, */*");
            conn.setRequestProperty("origin", ORIGIN);
            conn.setRequestProperty("referer", ORIGIN + "/helper/df/score/");
            conn.setRequestProperty("user-agent", UA);
            String cookie = CookieManager.getInstance().getCookie(ORIGIN);
            conn.setRequestProperty("cookie", cookie == null ? "" : cookie);

            OutputStream os = conn.getOutputStream();
            os.write((body == null || body.isEmpty() ? "{}" : body).getBytes("UTF-8"));
            os.close();

            int status = conn.getResponseCode();
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(is);
            out.put("ok", status == 200);
            out.put("httpStatus", status);
            out.put("text", text.length() > MAX_BYTES ? text.substring(0, MAX_BYTES) : text);
            if (status >= 300 && status < 400) {
                out.put("error", "接口把请求重定向了（多半是登录态过期）");
                out.put("notLogin", true);
            }
        } catch (Exception e) {
            try {
                out.put("ok", false);
                out.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            } catch (Exception ignored) {
                // ignore
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
        return out.toString();
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        long total = 0;
        while ((n = is.read(chunk)) > 0 && total < MAX_BYTES) {
            buf.write(chunk, 0, n);
            total += n;
        }
        is.close();
        return new String(buf.toByteArray(), "UTF-8");
    }
}
