package com.df.battleanalyzer;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 页面上唯一的那一个洞：window.AndroidBridge.call(channel, argsJson, replyId)。
 *
 * 桌面端对应物是 shell/preload.js + shell/main.js 里的一堆 ipcMain.handle。
 * 这里刻意做成"一张表 + 每行一句注释"，因为审计的问题永远是同一句：
 * **页面上那个 JS 到底能不能借原生办它想办的事？** 通道越少越好答。
 *
 * ★ 三条规矩：
 *   1) 文件名一律消毒（只留 [A-Za-z0-9._-]，不许 ..）—— 私有目录之外写不出去；
 *   2) 出网只有三条通道，每一条的去处都由 Java 侧钉死，JS 说往哪儿发都不算数：
 *        采集 → WegameHttp（前缀钉死 www.wegame.com.cn，带 cookie）
 *        插件 → PluginNet（域名 = 用户为该插件批准的那份清单，逐跳重校，cookie 各自一罐）
 *        字典 → cfg.mapNames（只去 MAP_HOST 这一台 CDN：GET、无 cookie、无 body，见 dispatch）
 *   3) 任何"看起来成功了"的返回都必须真的成功，做不到就回错误文案（备份/复制卡片两条明说）。
 */
public class DfBridge {

    static final int PICK_FILE = 4100;
    /** 「另存为」：导出数据包与战绩卡片都走系统创建文档，由使用者当场指定去处（对齐桌面的 save dialog） */
    static final int SAVE_FILE = 4101;
    /** 数据包导入用的临时落点（选来的文件先整个存下来，JS 再决定要不要） */
    static final String PICK_BUNDLE = "import-bundle.json";
    static final String PICK_PLUGIN = "import-plugin.zip";
    /* 官方地图名配置表那台 CDN。★ 这一份与 core/mapConfig.js 的 HOST 必须逐字相同 ——
     * 口径的唯一出处是 JS 那一份（两端共用），这里钉的是第二道锁：
     * 就算有人把 JS 那份改了，Java 也不会跟着去别的站。
     * test/android-shim.test.js 里有一条静态红线盯着这两处相等。 */
    static final String MAP_HOST = "jsonschema.qpic.cn";
    /* 在线更新那台（也是"这台机器第一次报"那一发去的地方）。★ 与 core/update.js 的 HOST 逐字相同，
     * 同样是第二道锁：JS 那份改了，这里不跟着去别的站。android-shim.test.js 盯着两处相等。 */
    static final String UPDATE_HOST = "app.dpx1.icu";
    private static final int PLUGIN_ID_MAX = 40;

    private final MainActivity act;
    private final String token;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    /* ★ 这几枚是**跨线程**的：通道调用在 WebView 的 JS 桥线程上写它们，而 onActivityResult
     *   在 UI 线程清它们 ⇒ 不加 volatile，下面"一次只挂一发"那道闸门会读到旧值，
     *   第二发照样把第一发的字节顶掉（2026-09-25 在 MuMu 上连着点两颗导出按钮实测到过）。 */
    private volatile int pendingPick = -1;
    private volatile String pendingPickInto = "";
    /* 「另存为」同理：字节先在内存里攥着（导出数据包 ≤ 几 MB、卡片一张 PNG），
     * 使用者在系统面板上选定去处之后才落盘、才回页面。 */
    private volatile int pendingSave = -1;
    private volatile byte[] pendingSaveBytes = null;
    private volatile String pendingSaveName = "";

    DfBridge(MainActivity a, String bridgeToken) {
        act = a;
        token = bridgeToken == null ? "" : bridgeToken;
    }

    ExecutorService pool() {
        return pool;
    }

    private File dir() {
        File d = act.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (d == null) d = act.getFilesDir();
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** 私有目录下的数据文件：db 与 accounts.json 都在这儿，卸载即清 */
    private File dataFile(String raw) {
        String name = raw == null ? "" : raw.replaceAll("[^A-Za-z0-9._-]", "_");
        if (name.isEmpty() || name.startsWith("..")) name = "unnamed.json";
        if (name.length() > 120) name = substring(name, 120);
        return new File(act.getFilesDir(), name);
    }

    /** 插件目录：files/plugins/&lt;id&gt;/。id 与相对目录名都要消毒，跳不出去这个根。 */
    private File pluginRoot() {
        File d = new File(act.getFilesDir(), "plugins");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private File pluginDir(String rawId) {
        String id = rawId == null ? "" : rawId.replaceAll("[^a-z0-9._-]", "");
        if (id.isEmpty() || id.startsWith("..") || id.length() > PLUGIN_ID_MAX) id = "bad";
        File d = new File(pluginRoot(), id);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private static String substring(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    @JavascriptInterface
    public void call(final String channel, final String argsJson, final int id, final String tok) {
        /* ★ 令牌不对就一个字也不回：这一条不是防误触，是防同 WebView 里的沙箱 iframe 直连原生。
         *   addJavascriptInterface 注入的对象子框也看得见，而插件页正是这样一个子框；
         *   没有这道闸，装进来的插件可以绕过宿主所有权限判定，一把 fs.read 走你的战绩库。 */
        if (token.isEmpty() || !token.equals(tok)) {
            act.reply(id, err("没有桥令牌：这一帧不是宿主主页面，原生通道不受理"));
            return;
        }
        pool.execute(new Runnable() {
            @Override
            public void run() {
                String reply;
                try {
                    reply = dispatch(channel, argsJson == null ? "{}" : argsJson, id);
                } catch (Exception e) {
                    reply = err(e.getClass().getSimpleName() + ": " + e.getMessage());
                }
                if (reply != null) act.reply(id, reply);
            }
        });
    }

    /** 返回 null 表示这一条不立即回执（等 Activity 结果，比如选文件） */
    private String dispatch(String channel, String argsJson, int id) throws Exception {
        JSONObject a = new JSONObject(argsJson);
        if ("fs.read".equals(channel)) {
            File f = dataFile(a.optString("name"));
            /* ★ 三种结果必须回三种话：「没有这个文件」和「这个文件读不出来」合成同一条的话，
             *   JS 那侧只看 !text，读失败就成了"这台机器还没有数据"，随后任何一次保存
             *   把还有救的库原地盖掉（使用者报的"明明存上去了，第二次打开却没数据，只能重装"）。 */
            if (!f.exists()) return "{\"text\":null,\"missing\":true}";
            try {
                return new JSONObject().put("text", read(f)).put("missing", false).toString();
            } catch (Exception e) {
                return err("读不出 " + f.getName() + "：" + e);
            }
        }
        if ("fs.write".equals(channel)) {
            File f = dataFile(a.optString("name"));
            File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
            write(tmp, a.optString("text"));
            if (tmp.exists() && !tmp.renameTo(f)) {
                write(f, a.optString("text"));
                tmp.delete();
            }
            return "{\"ok\":true}";
        }
        if ("fs.remove".equals(channel)) {
            File f = dataFile(a.optString("name"));
            return "{\"ok\":" + (!f.exists() || f.delete()) + "}";
        }
        if ("net.post".equals(channel)) {
            return WegameHttp.post(a.optString("pathname"), a.optString("body"));
        }
        if ("login.open".equals(channel)) {
            final String slot = a.optString("slot", "");
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent it = new Intent(act, LoginActivity.class);
                    it.putExtra("slot", slot);
                    act.startActivity(it);
                }
            });
            /* cleared:true —— LoginActivity.onCreate 在 loadUrl 之前一定先 wipeSession() 过一遍，
             * 这一窗是全新会话。界面据此把那句话如实说出来（桌面没有这一步，不许跟着喊）。 */
            return new JSONObject().put("ok", true).put("slot", slot).put("cleared", true).toString();
        }
        if ("login.clearCookies".equals(channel)) {
            /* 这一条只有设置页「退出登录」在喊：使用者主动点的，语义就是清。
             * 它只清 cookie；开登录窗那一整套（缓存 / localStorage / 表单 / 历史）在 LoginActivity.wipeSession。 */
            CookieManager cm = CookieManager.getInstance();
            if (Build.VERSION.SDK_INT >= 21) cm.removeAllCookies(null);
            cm.flush();
            return "{\"ok\":true}";
        }
        if ("app.info".equals(channel)) {
            JSONObject o = new JSONObject();
            o.put("version", BuildConfig.VERSION_NAME);
            o.put("platform", "android " + Build.VERSION.SDK_INT);
            o.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            o.put("dataDir", act.getFilesDir().getAbsolutePath());
            o.put("exportDir", dir().getAbsolutePath());
            return o.toString();
        }
        if ("export.save".equals(channel)) {
            /* ★ 桌面这一发是 dialog.showSaveDialogSync —— 每次导出都由使用者当场指定去处。
             *   手机上同一件事就是 SAF 的「创建文档」：以前写死到应用私有 Download，
             *   Android 11 之后那个目录在文件管理器里根本点不到（他报的原话就是"保存的文件
             *   用户可以指定保存到哪里"）。 */
            return askSaveAs(id, safeName(a.optString("name")), "application/json",
                    a.optString("text").getBytes("UTF-8"));
        }
        if ("card.save".equals(channel)) {
            return askSaveAs(id, safeName(a.optString("name", "战绩卡片.png")), "image/png",
                    Base64.decode(stripDataUrl(a.optString("b64")), Base64.DEFAULT));
        }
        if ("card.copy".equals(channel)) {
            /* 复制图片到剪贴板要 content:// uri（得挂 FileProvider）。这一版没做，就如实说，
             * 不能悄悄返回 ok —— 桌面上那颗按钮是有反应的。 */
            return "{\"ok\":false,\"error\":\"安卓版暂时只能「保存卡片」到文件，复制未实现\"}";
        }
        if ("file.pick".equals(channel)) {
            pendingPick = id;
            /* saveAs：二进制（插件包）不能当文本读 —— 整份落到私有目录，后面交给 zip.* 开 */
            String into = a.optString("saveAs", "");
            pendingPickInto = into.isEmpty() ? "" : dataFile(into).getName();
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    it.addCategory(Intent.CATEGORY_OPENABLE);
                    it.setType("*/*");
                    try {
                        act.startActivityForResult(it, PICK_FILE);
                    } catch (Exception e) {
                        pendingPick = -1;
                        pendingPickInto = "";
                        act.reply(id, err("这台机器上没有文件选择器"));
                    }
                }
            });
            return null;
        }
        if ("open.url".equals(channel)) {
            final String url = a.optString("url", "");
            if (url.startsWith("https://") || url.startsWith("http://")) {
                act.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                        } catch (Exception e) {
                            toast("没有能打开这个链接的应用");
                        }
                    }
                });
            }
            return "{\"ok\":true}";
        }
        if ("clipboard".equals(channel)) {
            final String text = a.optString("text", "");
            ClipboardManager cb = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cb != null) cb.setPrimaryClip(ClipData.newPlainText("df", text));
            return "{\"ok\":true}";
        }
        if ("toast".equals(channel)) {
            toast(a.optString("text", ""));
            return "{\"ok\":true}";
        }
        /* ---------------- 插件层：只执行判定完的结果，上限与名单都由 JS 传进来 ----------------
         * ★ 这些通道没有任何一条认识"权限"这个概念：谁能装、能读什么、能发到哪儿，
         *   全部在 android/js/plugin-host.js（与桌面同一份 core/plugin.js）算完，
         *   算完才把「允许的条目名单 + 上限」交给这里落地。 */
        if ("zip.list".equals(channel)) {
            return PluginZip.list(dataFile(a.optString("name")));
        }
        if ("zip.audit".equals(channel)) {
            return PluginZip.audit(dataFile(a.optString("name")), a.optJSONArray("entries"),
                    a.optLong("maxEntry", 2 * 1024 * 1024), a.optLong("maxTotal", 8 * 1024 * 1024));
        }
        if ("zip.extract".equals(channel)) {
            return PluginZip.extract(dataFile(a.optString("name")), pluginDir(a.optString("into")),
                    a.optJSONArray("entries"),
                    a.optLong("maxEntry", 2 * 1024 * 1024), a.optLong("maxTotal", 8 * 1024 * 1024));
        }
        if ("zip.read".equals(channel)) {
            /* 只读包里的一个条目（清单、入口 html、脚本）：借 extract 解到临时目录，读完就清。
             * 不另开第二条 inflate 的路径 —— 上限与消毒都还是 PluginZip 那一套。
             * ★ 这里要的是一条 {want,has} 对照表，不是光一个名字：extract 只认对照表，
             *   传字符串数组它会当场判「条目对照表不完整」（2026-09-24 MuMu 上真炸过）。 */
            String nm = a.optString("entry");
            File tmp = pluginDir("peek");
            File z = dataFile(a.optString("name"));
            String out = PluginZip.extract(z, tmp, specsOf(nm, nm),
                    PluginZip.MAX_TEXT_BYTES, PluginZip.MAX_TEXT_BYTES);
            if (new File(tmp, nm).exists()) {
                out = PluginZip.readFile(tmp, nm, PluginZip.MAX_TEXT_BYTES);
            }
            PluginZip.removeTree(tmp);
            return out;
        }
        if ("plugin.read".equals(channel)) {
            return PluginZip.readFile(pluginDir(a.optString("id")), a.optString("name"),
                    PluginZip.MAX_TEXT_BYTES);
        }
        if ("plugin.hashDir".equals(channel)) {
            return PluginZip.hashDir(pluginDir(a.optString("id")));
        }
        if ("plugin.renameDir".equals(channel)) {
            File from = pluginDir(a.optString("from"));
            File to = pluginDir(a.optString("to"));
            PluginZip.removeTree(to);
            boolean ok = from.renameTo(to);
            if (!ok) {
                /* 同分区改名失败就把内容搬过去：目标是插件目录，不越界 */
                ok = moveInto(from, to) && PluginZip.removeTree(from).startsWith("{\"ok\":true");
            }
            return "{\"ok\":" + ok + "}";
        }
        if ("plugin.removeDir".equals(channel)) {
            return PluginZip.removeTree(pluginDir(a.optString("id")));
        }
        if ("hash.text".equals(channel)) {
            return new JSONObject().put("ok", true)
                    .put("hash", PluginZip.sha16Text(a.optString("text"))).toString();
        }
        if ("plugin.net".equals(channel)) {
            return PluginNet.request(a.optString("url"), a.optString("method", "GET"),
                    a.optJSONObject("headers"), a.optString("jar", ""), a.optString("body", null),
                    a.optInt("timeout", 0), a.optJSONArray("allow"));
        }
        if ("plugin.stream".equals(channel)) {
            String sid = a.optString("streamId", "");
            if (sid.isEmpty()) sid = PluginNet.newStreamId();
            String bad = PluginNet.badTarget(a.optString("url"), a.optJSONArray("allow"));
            if (bad != null) {
                return new JSONObject().put("ok", false).put("error", bad).toString();
            }
            PluginNet.startStream(act, sid, a.optString("url"), a.optString("method", "POST"),
                    a.optJSONObject("headers"), a.optString("jar", ""), a.optString("body", null),
                    a.optInt("timeout", 0), a.optJSONArray("allow"));
            return new JSONObject().put("ok", true).put("streamId", sid).toString();
        }
        if ("plugin.abort".equals(channel)) {
            return new JSONObject().put("ok", true)
                    .put("killed", PluginNet.abort(a.optString("streamId"))).toString();
        }
        if ("cfg.mapNames".equals(channel)) {
            /* ★ 宿主自己的一发：取官方公开的「地图编号 → 地名」配置表。
             * 走的是 PluginNet 那一层地板（https + 标准端口 + 逐跳重校 + 256KB 上限 + 超时），
             * 但去处在这里钉死，不跟插件那份"用户批准的清单"走：
             *   ① URL 必须以 https://MAP_HOST/ 开头 —— http、别的 host、host:端口 全在这一句外头；
             *   ② allow 只有一条；③ 方法写死 GET、没有 body、jar 传空串 ⇒ 带不出任何 cookie，
             *      WeGame 的登录态压根不在这条路上（它在 WegameHttp 那边自己取）。 */
            String url = a.optString("url", "");
            if (!url.startsWith("https://" + MAP_HOST + "/")) {
                return err("地图名只允许从官方配置表那一个地址取");
            }
            return PluginNet.request(url, "GET", new JSONObject(), "", null, 15000, namesOf(MAP_HOST));
        }
        if ("cfg.update".equals(channel)) {
            /* 宿主自己的另一发：问那台服务器"有没有新版"，第一次顺带把装机数 +1。
             * 与 cfg.mapNames 同一套地板与同一套钉子（GET、无 body、jar 传空串 ⇒ 带不出任何 cookie，
             * WeGame 的登录态压根不在这条路上）；去处只认 UPDATE_HOST 这一个 host。
             * ★ 参数的形状（只有 app/platform/v/sec）由 core/update.js 管，这里钉的是"能到哪儿"。 */
            String url = a.optString("url", "");
            if (!url.startsWith("https://" + UPDATE_HOST + "/")) {
                return err("在线更新只允许问这一台服务器");
            }
            return PluginNet.request(url, "GET", new JSONObject(), "", null, 10000, namesOf(UPDATE_HOST));
        }
        return err("未知通道 " + channel);
    }

    private static JSONArray namesOf(String one) {
        JSONArray arr = new JSONArray();
        arr.put(one);
        return arr;
    }

    /** 一条 {want,has} 的对照表 —— PluginZip.audit / extract 只认这个形状（不是名字数组）。
     *  namesOf 那条服务的是 PluginNet 的域名清单，两者语义不同，别混用。 */
    private static JSONArray specsOf(String want, String has) {
        JSONArray arr = new JSONArray();
        try {
            arr.put(new JSONObject().put("want", want).put("has", has));
        } catch (Exception ignored) {
            // JSONObject.put(String) 不会抛；留着是为了编译期不骗自己"处理过了"
        }
        return arr;
    }

    /** renameTo 在个别机型上会因为目标已存在而失败：搬内容过去，别把一次装插件说成失败 */
    private static boolean moveInto(File from, File to) {
        try {
            File[] kids = from.listFiles();
            if (!to.exists() && !to.mkdirs()) return false;
            boolean ok = true;
            if (kids != null) {
                for (int i = 0; i < kids.length; i++) {
                    File dst = new File(to, kids[i].getName());
                    ok = (kids[i].isDirectory() ? (dst.exists() || dst.mkdirs())
                            : kids[i].renameTo(dst)) && ok;
                }
            }
            return ok;
        } catch (Exception e) {
            return false;
        }
    }

    /* ----------------------------------------------- 另存为（导出数据包 / 战绩卡片）
     * 桌面对应物是 dialog.showSaveDialogSync：每次保存都由使用者指定去处。
     * 这里用 SAF 的 ACTION_CREATE_DOCUMENT —— 不需要任何存储权限，写不进就是写不进，
     * 比"替你猜一个目录"诚实。 */

    /** 返回 null = 不立即回执，等 onActivityResult（与 file.pick 同一条约定） */
    private String askSaveAs(int id, String name, String mime, byte[] bytes) {
        /* ★ 这一发只有一枚槽：面板还开着又来一发，就把上一发的字节顶掉了 —— 上一发永远等不到回执。
         *   不去拒收新的一发（页面那颗 15 分钟表可能早就替使用者放弃了旧面板，拒收等于把人死锁在这里），
         *   而是**明说**上一发没成：新的照常弹面板，旧的当场回一句错误。 */
        if (pendingSave >= 0 && pendingSave != id) {
            act.reply(pendingSave, err("这一次的保存被后面那次顶掉了，文件没写成 —— 请重新导出一次"));
        }
        pendingSave = id;
        pendingSaveBytes = bytes;
        pendingSaveName = name;
        final String fname = name, fmime = mime;
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Intent it = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                it.addCategory(Intent.CATEGORY_OPENABLE);
                it.setType(fmime);
                it.putExtra(Intent.EXTRA_TITLE, fname);
                Uri init = lastSaveUri();
                /* ★ 这个常量在 DocumentsContract 上，不在 Intent 上（API 26+）：
                 *   开在他上次存过的那个位置，别每次都在根目录重挑一遍 */
                if (init != null && Build.VERSION.SDK_INT >= 26) {
                    it.putExtra(DocumentsContract.EXTRA_INITIAL_URI, init);
                }
                try {
                    act.startActivityForResult(it, SAVE_FILE);
                } catch (Exception e) {
                    /* 没有另存为面板（个别精简 ROM）：退回应用目录，但**明说**这次没让他挑 */
                    pendingSave = -1;
                    act.reply(id, writeIntoAppDir(fname, bytes));
                }
            }
        });
        return null;
    }

    private void finishSaveAs(int resultCode, Intent data) {
        final int id = pendingSave;
        final byte[] bytes = pendingSaveBytes;
        final String name = pendingSaveName;
        pendingSave = -1;
        pendingSaveBytes = null;
        pendingSaveName = "";
        if (id < 0) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            act.reply(id, "{\"ok\":false,\"cancelled\":true}");
            return;
        }
        Uri u = data.getData();
        rememberSaveUri(u);
        try {
            ContentResolver cr = act.getContentResolver();
            java.io.OutputStream os = cr.openOutputStream(u, "w");
            if (os == null) {
                act.reply(id, err("这个位置写不进去（系统拒绝了这次保存）"));
                return;
            }
            os.write(bytes);
            os.close();
            String shown = displayName(u, name);
            act.reply(id, new JSONObject().put("ok", true).put("path", shown).toString());
            toast("已保存到 " + shown);
        } catch (Exception e) {
            act.reply(id, err("写入失败：" + (e.getClass().getSimpleName() + ": " + e.getMessage())));
        }
    }

    /** 退回的那条路：写进应用自己的目录，并在返回里说清"这一次没能让你选位置" */
    private String writeIntoAppDir(String name, byte[] bytes) {
        try {
            File f = new File(dir(), safeName(name));
            FileOutputStream fo = new FileOutputStream(f);
            fo.write(bytes);
            fo.close();
            scan(f);
            return new JSONObject().put("ok", true).put("path", f.getAbsolutePath())
                    .put("note", "这台机器上没有「另存为」面板，这一次存进了应用目录")
                    .toString();
        } catch (Exception e) {
            return err("保存失败：" + (e.getClass().getSimpleName() + ": " + e.getMessage()));
        }
    }

    /** content:// 上拿真实显示名（SAF 允许它改名字，别拿我们建议的那个糊弄过去） */
    private String displayName(Uri u, String fallback) {
        Cursor c = null;
        try {
            c = act.getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME},
                    null, null, null);
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
            // 查不到就用建议名，不值得为一次 toast 崩
        } finally {
            if (c != null) {
                try {
                    c.close();
                } catch (Exception ignored) {
                    // close 失败不影响正事
                }
            }
        }
        return fallback;
    }

    private Uri lastSaveUri() {
        try {
            String s = act.getSharedPreferences("df", Context.MODE_PRIVATE).getString("lastSaveUri", "");
            return s.isEmpty() ? null : Uri.parse(s);
        } catch (Exception e) {
            return null;
        }
    }

    private void rememberSaveUri(Uri u) {
        try {
            act.getSharedPreferences("df", Context.MODE_PRIVATE).edit()
                    .putString("lastSaveUri", u.toString()).apply();
        } catch (Exception ignored) {
            // 记不住下次的位置不算错
        }
    }

    /** 选文件回来：文本模式直接读给页面（数据包导入）；saveAs 模式整份落到私有目录（插件包） */
    void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == SAVE_FILE) {
            finishSaveAs(resultCode, data);
            return;
        }
        int id = pendingPick;
        String into = pendingPickInto;
        pendingPick = -1;
        pendingPickInto = "";
        if (requestCode != PICK_FILE || id < 0) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            act.reply(id, "{\"ok\":false,\"cancelled\":true}");
            return;
        }
        Uri u = data.getData();
        try {
            ContentResolver cr = act.getContentResolver();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            InputStream is = cr.openInputStream(u);
            byte[] chunk = new byte[8192];
            int n;
            long total = 0;
            long cap = into.isEmpty() ? 64L * 1024 * 1024 : 16L * 1024 * 1024;
            while (is != null && (n = is.read(chunk)) > 0) {
                buf.write(chunk, 0, n);
                total += n;
                if (total > cap) {
                    is.close();
                    act.reply(id, err(into.isEmpty() ? "文件太大（超过 64 MB）" : "插件包超过 16 MB，不接受"));
                    return;
                }
            }
            if (is != null) is.close();
            String name = u.getLastPathSegment();
            byte[] bytes = buf.toByteArray();
            if (into.isEmpty()) {
                act.reply(id, new JSONObject().put("ok", true)
                        .put("name", name == null ? "数据包.json" : name)
                        .put("text", new String(bytes, "UTF-8")).toString());
            } else {
                File f = dataFile(into);
                FileOutputStream fo = new FileOutputStream(f);
                fo.write(bytes);
                fo.close();
                act.reply(id, new JSONObject().put("ok", true)
                        .put("name", name == null ? f.getName() : name)
                        .put("saved", f.getName())
                        .put("size", f.length()).toString());
            }
        } catch (Exception e) {
            act.reply(id, err("读不了这个文件：" + e.getMessage()));
        }
    }

    private String safeName(String raw) {
        String n = raw == null ? "file" : raw.replaceAll("[/\\\\:*?\"<>|]", "_");
        if (n.startsWith("..") || n.isEmpty()) n = "file";
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }

    private String stripDataUrl(String b64) {
        int i = b64 == null ? -1 : b64.indexOf(',');
        return i >= 0 ? b64.substring(i + 1) : (b64 == null ? "" : b64);
    }

    private void scan(File f) {
        try {
            android.media.MediaScannerConnection.scanFile(act,
                    new String[]{f.getAbsolutePath()}, null, null);
        } catch (Exception e) {
            // ignore
        }
    }

    private void toast(final String s) {
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(act, s, Toast.LENGTH_LONG).show();
            }
        });
    }

    private static String err(String msg) {
        try {
            return new JSONObject().put("ok", false).put("error", msg).toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"原生调用失败\"}";
        }
    }

    private static String read(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return new String(buf.toByteArray(), "UTF-8");
        } finally {
            /* 中途抛异常也不能把句柄漏掉：漏一次，下一次"读不出来"就更近一步 */
            in.close();
        }
    }

    private static void write(File f, String text) throws Exception {
        FileOutputStream out = new FileOutputStream(f);
        out.write((text == null ? "" : text).getBytes("UTF-8"));
        out.close();
    }
}
