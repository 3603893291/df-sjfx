"""把 MuMu/真机上弹出来的系统「另存为」面板点掉 —— 配合 test/device/export-toast.js 与 card-save.js。
跑法： python tools/android-tap-save.py [秒数=240] [最多点几次=1] [adb 路径]
为什么要点：那两颗保存按钮走的是 SAF 的 ACTION_CREATE_DOCUMENT，**面板是系统的、不是我们的页面**，
CDP 注不进去（它不在同一个 WebView 里），只能像使用者那样点一下。
★ 只认 mCurrentFocus 里的 documentsui：页面自己的弹窗不归这里管。
"""
import os
import re
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ADB = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("DF_ADB") or os.path.expandvars(
    r"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe")
SERIAL = os.environ.get("DF_SERIAL") or "127.0.0.1:16384"
ENV = dict(os.environ, MSYS_NO_PATHCONV="1")


def sh(*args):
    return subprocess.run([ADB, "-s", SERIAL] + list(args), capture_output=True,
                          text=True, encoding="utf-8", errors="replace", env=ENV).stdout


def focused_package():
    out = sh("shell", "dumpsys", "window")
    m = re.search(r"mCurrentFocus=Window\{\S+ \S+ (\S+)/(\S+?)\}", out)
    return m.group(1) if m else ""


def tap_save():
    """找「保存」那颗（android:id/button1，文本或描述里带 保存/Save），点它的中心。"""
    sh("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    xml = sh("shell", "cat", "/sdcard/ui.xml")
    for node in re.findall(r"<node\b[^>]*?/?>", xml):
        def attr(key):
            m = re.search(key + r'="([^"]*)"', node)
            return m.group(1) if m else ""
        label = attr("text") + attr("content-desc")
        if "保存" in label or "save" in label.lower():
            nums = [int(x) for x in re.findall(r"\d+", attr("bounds"))]
            if len(nums) != 4:
                continue
            x, y = (nums[0] + nums[2]) // 2, (nums[1] + nums[3]) // 2
            sh("shell", "input", "tap", str(x), str(y))
            print("点了：", label.strip() or "(无文本)", "坐标", x, y, flush=True)
            return True
    labeled = []
    for node in re.findall(r"<node\b[^>]*?/?>", xml):
        m = re.search(r'text="([^"]+)"', node) or re.search(r'content-desc="([^"]+)"', node)
        if m:
            labeled.append(m.group(1))
    print("这一屏没找到「保存」，看得见的文字：", labeled[:16], flush=True)
    return False


def main():
    deadline = time.time() + (int(sys.argv[1]) if len(sys.argv) > 1 else 240)
    want = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    hits = 0
    while time.time() < deadline and hits < want:
        if "documentsui" in focused_package():
            time.sleep(1.2)
            if tap_save():
                hits += 1
                time.sleep(1.5)
        else:
            time.sleep(0.5)
    print("共点掉面板", hits, "次", flush=True)
    return 0 if hits >= want else 1


if __name__ == "__main__":
    sys.exit(main())
