package com.df.battleanalyzer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 插件的出口通道：宿主替插件发请求，插件自己碰不到网络，也碰不到 WeGame 的 cookie。
 *
 * ★ 这一层只管「线上底线」，不管权限语义 —— 谁能出网、出到哪个域名、有没有逐字确认，
 *   判定在 android/js/plugin-host.js（用的是与桌面同一份 core/plugin.js）。
 *   这里重复的只有桌面 adapters/plugin-net.js 那三条硬规矩，一条都不许松：
 *     1) 必须 https，且只认标准 443 端口；明文 http 只允许 127.0.0.1 / localhost / ::1（自测用）；
 *     2) 目标主机必须在批准的那份名单里（清单写着 "*" 时，地址由使用者在插件页里自己填）；
 *     3) 重定向自己跟、每一跳重新校一遍域名，最多 3 跳 —— 否则一句 302 就把域名名单绕过去了。
 *   cookie / host / content-length / connection / upgrade 这几颗头一律由宿主管：
 *   插件传什么都不采纳，cookie 只用宿主代管的那罐（见 plugin-host.js 的 jar）。
 *
 * 与采集通道（WegameHttp）毫无瓜葛：这里从不读 CookieManager，
 * 所以插件出网带不走手机上登录 WeGame 的凭据 —— 桌面端「一个字节也不替它拼」的同一句承诺。
 */
public final class PluginNet {

    static final int MAX_BYTES = 256 * 1024;
    static final int STREAM_MAX_BYTES = 4 * 1024 * 1024;
    static final int MAX_HOPS = 3;
    static final int DEFAULT_TIMEOUT = 20000;
    private static final String[] LOOPBACK = {"127.0.0.1", "localhost", "[::1]"};
    private static final String[] FORBIDDEN =
            {"cookie", "host", "content-length", "connection", "upgrade"};

    /** 还在跑的流：streamId -> 连接。撤销允许 / 停用 / 卸载都要能立刻掐掉 */
    private static final Map<String, HttpURLConnection> STREAMS =
            new HashMap<String, HttpURLConnection>();
    private static final AtomicInteger SEQ = new AtomicInteger(0);

    private PluginNet() {
    }

    static String newStreamId() {
        return "s" + SEQ.incrementAndGet();
    }

    static boolean isLive(String streamId) {
        synchronized (STREAMS) {
            return STREAMS.containsKey(streamId);
        }
    }

    /** 先占位再起跑：没有这一步，abort 发生在连接建立之前就会漏掉，撤了允许还在吐字 */
    static void claim(String streamId) {
        synchronized (STREAMS) {
            STREAMS.put(streamId, null);
        }
    }

    /* ----------------------------------------------- 校验 */

    /** 与桌面 validate() 同一口径：不合法就回错误话术，合法回 null */
    static String badTarget(String rawUrl, JSONArray allow) {
        if (rawUrl == null || rawUrl.isEmpty()) return "缺少网址";
        URL u;
        try {
            u = new URL(rawUrl);
        } catch (Exception e) {
            return "网址不合法：" + rawUrl;
        }
        String p = u.getProtocol() == null ? "" : u.getProtocol().toLowerCase();
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
        int port = u.getPort();
        if ("https".equals(p)) {
            if (port != -1 && port != 443) return "只允许标准 https 端口";
        } else if ("http".equals(p)) {
            if (!isLoopback(host)) return "明文 http 只允许本机自测，对外必须是 https";
            if (port != -1 && port != 80) return "只允许标准 http 端口";
        } else {
            return "只允许 https（本机自测可用 http://127.0.0.1）";
        }
        if (host.isEmpty()) return "网址里没有主机名";
        if (!allowed(host, allow)) return "这个地址不在你批准的清单里：" + host;
        return null;
    }

    private static boolean isLoopback(String host) {
        for (int i = 0; i < LOOPBACK.length; i++) {
            if (LOOPBACK[i].equalsIgnoreCase(host)) return true;
        }
        return false;
    }

    /** "*" 就是「地址由使用者自己填」—— 与 core/plugin.js 的 hostsAreAny 同义 */
    static boolean allowed(String host, JSONArray allow) {
        if (allow == null || allow.length() == 0) return false;
        for (int i = 0; i < allow.length(); i++) {
            String a = allow.optString(i, "");
            if ("*".equals(a) || a.equalsIgnoreCase(host)) return true;
        }
        return false;
    }

    static Map<String, String> pickHeaders(JSONObject src, String jarHeader) {
        Map<String, String> h = new HashMap<String, String>();
        if (src != null) {
            for (Iterator<String> it = src.keys(); it.hasNext(); ) {
                String k = it.next();
                boolean block = false;
                for (int i = 0; i < FORBIDDEN.length; i++) {
                    if (FORBIDDEN[i].equals(k.toLowerCase())) block = true;
                }
                if (block) continue;
                String v = src.optString(k, "");
                h.put(k, v.length() > 300 ? v.substring(0, 300) : v);
            }
        }
        if (jarHeader != null && !jarHeader.isEmpty()) h.put("cookie", jarHeader);
        return h;
    }

    private static HttpURLConnection open(String url, String method, JSONObject headers,
                                          String jar, String body, int timeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method == null || method.isEmpty()
                ? "GET" : method.toUpperCase());
        conn.setConnectTimeout(12000);
        conn.setReadTimeout(timeoutMs <= 0 ? DEFAULT_TIMEOUT : Math.min(timeoutMs, 120000));
        conn.setInstanceFollowRedirects(false);      // 重定向自己跟，每一跳重新校域名
        conn.setRequestProperty("accept", "*/*");
        conn.setRequestProperty("user-agent", "df-swtwr-android/" + BuildConfig.VERSION_NAME);
        Map<String, String> hs = pickHeaders(headers, jar);
        for (Map.Entry<String, String> en : hs.entrySet()) {
            conn.setRequestProperty(en.getKey(), en.getValue());
        }
        if (body != null && !body.isEmpty()) {
            byte[] b = body.getBytes("UTF-8");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(b.length);
            conn.getOutputStream().write(b);
            conn.getOutputStream().close();
        }
        return conn;
    }

    static String resolve(String base, String loc) throws Exception {
        return new URL(new URL(base), loc).toString();
    }

    /** Set-Cookie 全都要收（同名只有一条有用，见 plugin-host.js 的 jar），一条都不能漏 */
    static JSONArray setCookiesOf(HttpURLConnection conn) {
        List<String> got = new ArrayList<String>();
        Map<String, List<String>> fields = conn.getHeaderFields();
        if (fields != null) {
            for (Map.Entry<String, List<String>> en : fields.entrySet()) {
                String k = en.getKey();
                if (k == null || !k.toLowerCase().startsWith("set-cookie") || en.getValue() == null) continue;
                got.addAll(en.getValue());
            }
        }
        JSONArray arr = new JSONArray();
        for (int i = 0; i < got.size(); i++) arr.put(got.get(i));
        return arr;
    }

    /* ----------------------------------------------- 一次性请求 */

    static String request(String rawUrl, String method, JSONObject headers, String jar,
                          String body, int timeoutMs, JSONArray allow) {
        JSONObject out = new JSONObject();
        HttpURLConnection conn = null;
        try {
            String url = rawUrl;
            int hops = 0;
            while (true) {
                String bad = badTarget(url, allow);
                if (bad != null) return fail(out, bad);
                conn = open(url, method, headers, jar, body, timeoutMs);
                int status = conn.getResponseCode();
                if (status >= 300 && status < 400) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = null;
                    if (loc == null || loc.isEmpty()) return fail(out, "重定向没有给出目标");
                    if (hops >= MAX_HOPS) return fail(out, "重定向超过 " + MAX_HOPS + " 跳");
                    url = resolve(url, loc);
                    hops++;
                    method = "GET";
                    body = null;
                    continue;
                }
                InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                out.put("ok", status >= 200 && status < 300);
                out.put("status", status);
                out.put("contentType", conn.getContentType() == null ? "" : conn.getContentType());
                out.put("text", readAll(is, MAX_BYTES));
                out.put("setCookies", setCookiesOf(conn));
                conn.disconnect();
                return out.toString();
            }
        } catch (Exception e) {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                    // ignore
                }
            }
            return fail(out, e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    /* ----------------------------------------------- 流式（SSE 这类） */

    /** 回包一律走 plugin:evt 那一族事件，形状与桌面 emitTo(id,'net.data'|'net.open'|'net.end') 一致 */
    static void startStream(final MainActivity act, final String streamId,
                            final String rawUrl, final String method, final JSONObject headers,
                            final String jar, final String body, final int timeoutMs,
                            final JSONArray allow) {
        claim(streamId);
        act.pool().execute(new Runnable() {
            @Override
            public void run() {
                hop(act, streamId, rawUrl, method, headers, jar, body, timeoutMs, allow, 0);
            }
        });
    }

    private static void hop(MainActivity act, String streamId, String url, String method,
                            JSONObject headers, String jar, String body, int timeoutMs,
                            JSONArray allow, int hops) {
        HttpURLConnection conn = null;
        StringBuilder held = new StringBuilder();
        boolean stopped = false;
        int status = 0;
        try {
            String bad = badTarget(url, allow);
            if (bad != null) {
                end(act, streamId, bad, 0, false);
                return;
            }
            conn = open(url, method, headers, jar, body, timeoutMs);
            synchronized (STREAMS) {
                if (!STREAMS.containsKey(streamId)) {
                    conn.disconnect();
                    return;                                  // 起跑前就被撤了：一个字节也不发
                }
                STREAMS.put(streamId, conn);
            }
            status = conn.getResponseCode();
            if (status >= 300 && status < 400) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                conn = null;
                if (loc == null || loc.isEmpty()) {
                    end(act, streamId, "重定向没有给出目标", status, false);
                    return;
                }
                if (hops >= MAX_HOPS) {
                    end(act, streamId, "重定向超过 " + MAX_HOPS + " 跳", status, false);
                    return;
                }
                hop(act, streamId, resolve(url, loc), "GET", headers, jar, null,
                        timeoutMs, allow, hops + 1);
                return;
            }
            JSONObject op = new JSONObject();
            op.put("status", status);
            op.put("contentType", conn.getContentType() == null ? "" : conn.getContentType());
            op.put("setCookies", setCookiesOf(conn));
            push(act, streamId, "net.open", op);

            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (is == null) {
                end(act, streamId, "没有响应体", status, false);
                return;
            }
            InputStreamReader rd = new InputStreamReader(is, "UTF-8");
            char[] buf = new char[4096];
            int n;
            long total = 0;
            long lastFlush = System.currentTimeMillis();
            while ((n = rd.read(buf)) > 0) {
                synchronized (STREAMS) {
                    if (!STREAMS.containsKey(streamId)) { stopped = true; break; }
                }
                held.append(buf, 0, n);
                total += n;
                /* 攒一小批再发：SSE 一秒能来几十片，一片一条事件会把 JS 桥淹掉 */
                long now = System.currentTimeMillis();
                if (held.length() >= 3072 || now - lastFlush > 40) {
                    flush(act, streamId, held);
                    lastFlush = now;
                }
                if (total > STREAM_MAX_BYTES) {
                    rd.close();
                    flush(act, streamId, held);
                    end(act, streamId, "响应超过 " + (STREAM_MAX_BYTES / 1024) + " KB 上限，已中断",
                            status, true);
                    return;
                }
            }
            rd.close();
            flush(act, streamId, held);
            end(act, streamId, stopped ? null : (status >= 400 ? "接口回了 " + status : null),
                    status, stopped);
        } catch (Exception e) {
            flush(act, streamId, held);
            end(act, streamId, e.getClass().getSimpleName() + ": " + e.getMessage(), status, false);
        } finally {
            release(streamId);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                    // ignore
                }
            }
        }
    }

    private static void release(String streamId) {
        synchronized (STREAMS) {
            STREAMS.remove(streamId);
        }
    }

    private static void flush(MainActivity act, String streamId, StringBuilder held) {
        if (held.length() == 0) return;
        String s = held.toString();
        held.setLength(0);
        push(act, streamId, "net.data", text(s));
    }

    private static JSONObject text(String s) {
        try {
            return new JSONObject().put("text", s);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void push(MainActivity act, String streamId, String type, JSONObject data) {
        try {
            act.event("plugin:net", new JSONObject().put("streamId", streamId)
                    .put("type", type).put("data", data).toString());
        } catch (Exception e) {
            // ignore
        }
    }

    private static void end(MainActivity act, String streamId, String error, int status,
                            boolean aborted) {
        try {
            JSONObject d = new JSONObject();
            d.put("aborted", aborted);
            if (error != null) d.put("error", error);
            if (status > 0) d.put("status", status);
            push(act, streamId, "net.end", d);
        } catch (Exception e) {
            // ignore
        }
    }

    /** @return 掐掉了几条（0 = 它已经跑完了） */
    static int abort(String streamId) {
        HttpURLConnection conn;
        synchronized (STREAMS) {
            conn = STREAMS.remove(streamId);
        }
        if (conn == null) return 0;
        try {
            conn.disconnect();
        } catch (Exception e) {
            // ignore
        }
        return 1;
    }

    /** 一个插件的号没了（卸载）：把它手上所有流一起掐了 */
    static void abortAll() {
        List<String> ids = new ArrayList<String>();
        synchronized (STREAMS) {
            ids.addAll(STREAMS.keySet());
        }
        for (int i = 0; i < ids.size(); i++) abort(ids.get(i));
    }

    private static String readAll(InputStream is, int cap) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        long total = 0;
        while ((n = is.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
            total += n;
            if (total > cap) {
                is.close();
                throw new Exception("响应超过 " + (cap / 1024) + " KB 上限，已中断");
            }
        }
        is.close();
        return new String(buf.toByteArray(), "UTF-8");
    }

    private static String fail(JSONObject out, String msg) {
        try {
            out.put("ok", false);
            out.put("error", msg);
        } catch (Exception e) {
            // ignore
        }
        return out.toString();
    }
}
