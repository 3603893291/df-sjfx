package com.df.battleanalyzer;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.os.Build;
import android.view.DisplayCutout;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;

/**
 * 系统栏：真全屏 + 挖孔让开。
 *
 * ★ 为什么从"适配"改成"全屏"（2026-09-24 他当场拍的）：
 *   上一版只做"把状态栏缺口以 padding 还给页面"，他手机上还是回「顶部被挡住了」——
 *   那条路依赖系统把 insets 正确派发到 WebView，而这一环在各家 ROM 上表现不一致，
 *   本机没有设备，我改不动也验不了。全屏不依赖任何派发：**那条栏根本不显示，挡无可挡。**
 *   代价是看不到时间/电量；从顶部或底部滑一下会临时出来、几秒后自动收回（sticky）。
 *
 * ★ 但挖孔还是要让：全屏不等于把内容塞进摄像头孔里。
 *   所以 fit(root, true) 只按 displayCutout 补 padding，状态栏与导航栏的高度一概不计。
 *   桌面那套 ui/ 一行都不用改 —— 安卓侧唯一动版式的还是这一份。
 */
final class SystemBars {

    /* 与 ui/css/theme.css 的 --bg-sidebar 同值：临时唤出的那条栏底色要跟页面自己一致 */
    static final int BG_LIGHT = 0xFFF6F6F8;
    static final int BG_DARK = 0xFF1C1C1E;

    private SystemBars() {
    }

    static boolean isNight(Activity act) {
        int mode = act.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    /** 隐藏状态栏与导航栏；边缘滑动临时唤出。返回键与返回手势在隐藏状态下照样有效。 */
    @SuppressWarnings("deprecation")
    static void immersive(final Activity act) {
        Window w = act.getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getDecorView().getWindowInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            return;
        }
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        w.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    /**
     * 把缺口以 padding 加到根视图上（它就是 WebView 或包住它的那层）。
     *
     * @param onlyCutout true = 只让挖孔（真全屏这一档用）；false = 状态栏与导航栏一起让开
     */
    static void fit(final View root, final boolean onlyCutout) {
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets in) {
                int left = 0, top = 0, right = 0, bottom = 0;
                if (Build.VERSION.SDK_INT >= 30) {
                    int type = onlyCutout
                            ? WindowInsets.Type.displayCutout()
                            : (WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    Insets bars = in.getInsets(type);
                    left = bars.left;
                    top = bars.top;
                    right = bars.right;
                    bottom = bars.bottom;
                } else {
                    if (!onlyCutout) {
                        left = in.getSystemWindowInsetLeft();
                        top = in.getSystemWindowInsetTop();
                        right = in.getSystemWindowInsetRight();
                        bottom = in.getSystemWindowInsetBottom();
                    }
                    if (Build.VERSION.SDK_INT >= 28) {
                        DisplayCutout cut = in.getDisplayCutout();
                        if (cut != null) {
                            left = Math.max(left, cut.getSafeInsetLeft());
                            top = Math.max(top, cut.getSafeInsetTop());
                            right = Math.max(right, cut.getSafeInsetRight());
                            bottom = Math.max(bottom, cut.getSafeInsetBottom());
                        }
                    }
                }
                v.setPadding(left, top, right, bottom);
                return in;
            }
        });
        root.requestApplyInsets();
    }

    /**
     * 露出来的那条带的底色与图标深浅（light=true 表示带是浅的、图标就该是深的）。
     */
    @SuppressWarnings("deprecation")
    static void paint(Activity act, View root, boolean light) {
        int bg = light ? BG_LIGHT : BG_DARK;
        root.setBackgroundColor(bg);
        Window w = act.getWindow();
        w.setStatusBarColor(bg);
        w.setNavigationBarColor(bg);
        View decor = w.getDecorView();
        if (Build.VERSION.SDK_INT >= 31) {
            WindowInsetsController c = decor.getWindowInsetsController();
            int bits = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (c != null) c.setSystemBarsAppearance(light ? bits : 0, bits);
        } else if (Build.VERSION.SDK_INT >= 23) {
            int bit = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            int f = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(light ? (f | bit) : (f & ~bit));
        }
    }
}
