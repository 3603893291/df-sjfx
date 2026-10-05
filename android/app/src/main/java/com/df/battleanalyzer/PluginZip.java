package com.df.battleanalyzer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 插件包的开箱与插件目录的落盘。
 *
 * ★ 为什么开箱在原生做而不是把 zip 字节传给 JS：
 *   桥只能传字符串，一份几十 KB 的包 base64 过来就是几十万字，而且 JS 侧还得再写一台 inflate。
 *   java.util.zip 是系统自带的，用它 inflate 一次就落地一次，字节从不出原生。
 *
 * ★ 但"这个包能不能要"仍然不由这里判定：
 *   条目名安全（core/zip.js 的 isSafeRelPath 同口径，这里逐字对齐）、单文件与总大小上限、
 *   扩展名白名单、清单与权限（core/plugin.js）—— 全部在 JS 侧算完，把**允许的条目名单**和**上限**传进来。
 *   这里只照单执行，外加一道自己的复校：名单里没有的条目一律不落盘，路径不安全的条目一律不写。
 *   换句话说：JS 决定"要不要"，这里保证"翻不出去"。
 */
final class PluginZip {

    static final long MAX_TEXT_BYTES = 4 * 1024 * 1024;

    private PluginZip() {
    }

    /* ----------------------------------------------- 条目名安全 */

    /** 与 core/zip.js 的 isSafeRelPath 同一套：反斜杠、盘符、绝对路径、控制字符、. / .. / ~ / $ 全拒 */
    static boolean isSafeRel(String name) {
        if (name == null || name.isEmpty()) return false;
        if (name.indexOf('\\') >= 0) return false;
        if (name.matches("^[A-Za-z]:.*")) return false;
        if (name.charAt(0) == '/') return false;
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c < 0x20) return false;
        }
        String[] segs = name.split("/");
        for (int i = 0; i < segs.length; i++) {
            String s = segs[i];
            if ("..".equals(s) || ".".equals(s)) return false;
            if (!s.isEmpty() && (s.charAt(0) == '~' || s.charAt(0) == '$')) return false;
        }
        return true;
    }

    /* ----------------------------------------------- 列表 / 审计 */

    /** 只读中央目录：条目名与大小，一个字节都不解 —— 权限确认页要靠这份先画出来 */
    static String list(File zip) {
        JSONObject out = new JSONObject();
        ZipFile zf = null;
        try {
            zf = new ZipFile(zip);
            JSONArray arr = new JSONArray();
            long total = 0;
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                JSONObject o = new JSONObject();
                o.put("name", e.getName());
                o.put("dir", e.isDirectory());
                o.put("size", e.getSize() < 0 ? 0 : e.getSize());
                o.put("compressedSize", e.getCompressedSize() < 0 ? 0 : e.getCompressedSize());
                /* Java 这边解出来只会是普通文件（下面 extract 只会 FileOutputStream），
                 * 符号链接条目落地就是一个装着路径的文本文件 —— 报 false 比缺字段诚实 */
                o.put("symlink", false);
                arr.put(o);
                if (!e.isDirectory()) total += Math.max(0, e.getSize());
            }
            out.put("ok", true);
            out.put("entries", arr);
            out.put("totalSize", total);
            out.put("count", arr.length());
            return out.toString();
        } catch (Exception e) {
            return err(out, "读不了这个 zip：" + describe(e));
        } finally {
            close(zf);
        }
    }

    /** 逐条 inflate 一遍拿真实字节数与哈希（清单声明的大小可以撒谎，解压后的不能）。
     *  specs: [{want: zip 里的真条目名, has: 落盘用的相对路径}] ——
     *  「压掉包外层目录」这条判据只写在 JS 一处，原生不猜名字，只按这张对照表执行。 */
    static String audit(File zip, JSONArray specs, long maxEntry, long maxTotal) {
        JSONObject out = new JSONObject();
        ZipFile zf = null;
        try {
            if (specs == null) return err(out, "没收到条目对照表（参数里的 entries）");
            zf = new ZipFile(zip);
            JSONArray arr = new JSONArray();
            long total = 0;
            for (int i = 0; i < specs.length(); i++) {
                JSONObject s = specs.optJSONObject(i);
                if (s == null) return err(out, "条目对照表不完整");
                String want = s.optString("want", "");
                String has = s.optString("has", "");
                if (!isSafeRel(want)) return err(out, "非法的条目名：" + want);
                if (!isSafeRel(has)) return err(out, "非法的落盘路径：" + has);
                ZipEntry e = zf.getEntry(want);
                if (e == null || e.isDirectory()) return err(out, "包里没有这个条目：" + want);
                byte[] b = readAll(zf.getInputStream(e), maxEntry);
                total += b.length;
                if (total > maxTotal) return err(out, "解压后总大小超过上限");
                arr.put(described(has, b));
            }
            out.put("ok", true);
            out.put("files", arr);
            out.put("totalSize", total);
            return out.toString();
        } catch (Exception e) {
            return err(out, "解包失败：" + describe(e));
        } finally {
            close(zf);
        }
    }

    /**
     * 落盘到 into/ 下：只写对照表里列出的条目，写完把真实哈希回给 JS 与审计结果比对
     * （"确认页上看到的那份内容"与"最后落在盘上的那份内容"必须是同一份）。
     */
    static String extract(File zip, File into, JSONArray specs, long maxEntry, long maxTotal) {
        JSONObject out = new JSONObject();
        ZipFile zf = null;
        List<File> written = new ArrayList<File>();
        try {
            if (specs == null) return err(out, "没收到条目对照表（参数里的 entries）");
            into.getCanonicalPath();                       // 目录本身要能定死，别是个软链
            zf = new ZipFile(zip);
            JSONArray arr = new JSONArray();
            long total = 0;
            for (int i = 0; i < specs.length(); i++) {
                JSONObject s = specs.optJSONObject(i);
                if (s == null) throw new Exception("条目对照表不完整");
                String want = s.optString("want", "");
                String has = s.optString("has", "");
                if (!isSafeRel(want)) throw new Exception("非法的条目名：" + want);
                if (!isSafeRel(has)) throw new Exception("非法的落盘路径：" + has);
                ZipEntry e = zf.getEntry(want);
                if (e == null || e.isDirectory()) throw new Exception("包里没有这个条目：" + want);
                byte[] b = readAll(zf.getInputStream(e), maxEntry);
                total += b.length;
                if (total > maxTotal) throw new Exception("解压后总大小超过上限");
                File f = new File(into, has);
                if (!f.getCanonicalPath().startsWith(into.getCanonicalPath() + File.separator)) {
                    throw new Exception("解包路径越界：" + has);
                }
                File parent = f.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new Exception("建不出目录：" + has);
                }
                FileOutputStream fo = new FileOutputStream(f);
                fo.write(b);
                fo.close();
                written.add(f);
                arr.put(described(has, b));
            }
            out.put("ok", true);
            out.put("files", arr);
            out.put("totalSize", total);
            return out.toString();
        } catch (Exception e) {
            for (int i = 0; i < written.size(); i++) {
                try {
                    written.get(i).delete();
                } catch (Exception ignored) {
                    // ignore
                }
            }
            return err(out, "解包失败，已回滚：" + describe(e));
        } finally {
            close(zf);
        }
    }

    /* ----------------------------------------------- 插件目录 */

    /** 读已装好的插件文件（供页、复核都走这一条），只认登记过的相对路径 */
    static String readFile(File dir, String name, long maxBytes) {
        JSONObject out = new JSONObject();
        try {
            if (!isSafeRel(name)) return err(out, "非法的插件内路径：" + name);
            File f = new File(dir, name);
            if (!f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) {
                return err(out, "路径越界：" + name);
            }
            if (!f.exists()) return err(out, "文件不存在：" + name);
            if (f.length() > maxBytes) return err(out, "文件太大：" + name);
            byte[] b = readAll(new java.io.FileInputStream(f), maxBytes);
            out.put("ok", true);
            out.put("text", new String(b, "UTF-8"));
            out.put("hash", sha16(b));
            return out.toString();
        } catch (Exception e) {
            return err(out, describe(e));
        }
    }

    /** 整目录复核：把盘上现在有什么（名字/大小/哈希）如实报出去。名字一律是包内相对路径。 */
    static String hashDir(File dir) {
        JSONObject out = new JSONObject();
        try {
            String base = dir.getCanonicalPath() + File.separator;
            List<String> names = new ArrayList<String>();
            List<File> files = new ArrayList<File>();
            walk(dir, "", names, files);
            Integer[] order = new Integer[names.size()];
            for (int i = 0; i < order.length; i++) order[i] = i;
            for (int i = 0; i < order.length; i++) {
                for (int j = i + 1; j < order.length; j++) {
                    if (names.get(order[j]).compareTo(names.get(order[i])) < 0) {
                        Integer t = order[i];
                        order[i] = order[j];
                        order[j] = t;
                    }
                }
            }
            JSONArray arr = new JSONArray();
            long total = 0;
            for (int k = 0; k < order.length; k++) {
                int i = order[k];
                String nm = names.get(i);
                File f = files.get(i);
                if (!f.getCanonicalPath().startsWith(base)) continue;      // 双保险：软链指出去的不算
                if (f.length() > MAX_TEXT_BYTES) {
                    arr.put(new JSONObject().put("name", nm).put("size", f.length())
                            .put("hash", "").put("tooBig", true));
                    continue;
                }
                byte[] b = readAll(new java.io.FileInputStream(f), MAX_TEXT_BYTES);
                total += b.length;
                arr.put(described(nm, b));
            }
            out.put("ok", true);
            out.put("files", arr);
            out.put("totalSize", total);
            return out.toString();
        } catch (Exception e) {
            return err(out, describe(e));
        }
    }

    private static void walk(File dir, String rel, List<String> names, List<File> files) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (int i = 0; i < kids.length; i++) {
            String kid = kids[i].getName();
            if (kid.endsWith(".tmp")) continue;                 // 原子写崩了留下的半份，不算插件内容
            String nm = rel.isEmpty() ? kid : rel + "/" + kid;
            if (kids[i].isDirectory()) walk(kids[i], nm, names, files);
            else if (kids[i].isFile()) {
                names.add(nm);
                files.add(kids[i]);
            }
        }
    }

    /** 递归删（卸载插件用）；只允许删 plugins/&lt;id&gt; 这一层之下的东西 */
    static String removeTree(File dir) {
        JSONObject out = new JSONObject();
        try {
            boolean ok = deleteTree(dir);
            out.put("ok", ok || !dir.exists());
            if (!ok && dir.exists()) out.put("error", "有些文件没删掉：" + dir.getName());
            return out.toString();
        } catch (Exception e) {
            return err(out, describe(e));
        }
    }

    private static boolean deleteTree(File f) {
        if (f == null || !f.exists()) return true;
        boolean clean = true;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) {
                for (int i = 0; i < kids.length; i++) clean = deleteTree(kids[i]) && clean;
            }
        }
        return f.delete() && clean;
    }

    /* ----------------------------------------------- 杂项 */

    private static JSONObject described(String name, byte[] b) throws Exception {
        return new JSONObject().put("name", name).put("size", b.length).put("hash", sha16(b));
    }

    /** 与 shell/plugins.js 的 sha16 同一口径：sha256 十六进制取前 16 位 */
    static String sha16(byte[] b) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(b);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < d.length && sb.length() < 16; i++) {
                sb.append(String.format("%02x", d[i]));
            }
            return sb.substring(0, Math.min(16, sb.length()));
        } catch (Exception e) {
            return "";
        }
    }

    static String sha16Text(String s) {
        try {
            return sha16(s.getBytes("UTF-8"));
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] readAll(InputStream is, long cap) throws Exception {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        long total = 0;
        while ((n = is.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
            total += n;
            if (total > cap) {
                is.close();
                throw new Exception("解压后超过单文件上限 " + cap + " 字节");
            }
        }
        is.close();
        return buf.toByteArray();
    }

    private static void close(ZipFile zf) {
        if (zf != null) {
            try {
                zf.close();
            } catch (Exception ignored) {
                // ignore
            }
        }
    }

    private static String describe(Exception e) {
        return e.getClass().getSimpleName() + ": " + e.getMessage();
    }

    private static String err(JSONObject out, String msg) {
        try {
            out.put("ok", false);
            out.put("error", msg);
        } catch (Exception e) {
            // ignore
        }
        return out.toString();
    }
}
