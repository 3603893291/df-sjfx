#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""界面回归检查：各页面滚轮滚动是否正常

回归背景：曾在侧边栏与内容区之间插入 .main-col 容器后，内容区失去高度约束，
叠加 body 的 overflow:hidden，导致所有页面滚轮无法滚动。

用法：
  1. 另开终端启动预览服务：node test/preview-server.js
  2. 运行：python test/ui-regression.py
需要 playwright（python）。
"""
import json
from playwright.sync_api import sync_playwright

views = [("overview", "总览"), ("winrate", "胜率"), ("matches", "战局"),
         ("detail", "单场详情"), ("maps", "地图分析"), ("classes", "兵种表现"),
         ("encounters", "对手队友"), ("rhythm", "状态与节律"),
         ("sandbox", "地图沙盘"),
         # v1.5.0：侧栏那颗 #navPlugin 在导入插件前是 display:none，
         # 但 JS 的 .click() 照样触发，所以这一项测的是「空状态页不撑破滚动」。
         # v1.7.0：原来的 ("ai", "AI 分析") 已随内置 AI 一起删除 —— 那一页现在是插件页。
         ("plugin", "扩展页面"),
         ("settings", "设置"), ("about", "关于")]

# 地图沙盘 / 关于 / 扩展页面是整页高度（.view-full + body.bare-view），本来就不需要滚动
NO_SCROLL = {"地图沙盘", "关于", "扩展页面"}

errors = []
report = {}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1400, "height": 760})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://127.0.0.1:8770/", wait_until="networkidle")
    page.wait_for_timeout(2500)

    for key, name in views:
        page.evaluate(f"document.querySelector('.nav-item[data-view=\"{key}\"]').click()")
        page.wait_for_timeout(900)

        metrics = page.evaluate("""() => {
          const c = document.querySelector('.content');
          return {
            clientH: c.clientHeight,
            scrollH: c.scrollHeight,
            bodyScroll: document.body.scrollHeight,
            canScroll: c.scrollHeight > c.clientHeight + 4
          };
        }""")

        # 把鼠标移到内容区中间，滚动滚轮
        page.mouse.move(800, 500)
        page.mouse.wheel(0, 600)
        page.wait_for_timeout(450)
        after = page.evaluate("document.querySelector('.content').scrollTop")

        # 再滚回顶部
        page.evaluate("document.querySelector('.content').scrollTop = 0")
        page.wait_for_timeout(200)

        report[name] = {
            "内容高度": metrics["clientH"],
            "实际高度": metrics["scrollH"],
            "需要滚动": metrics["canScroll"],
            "滚轮后scrollTop": after,
            "滚动生效": (after > 0) if metrics["canScroll"]
                        else ("整页无需滚动" if name in NO_SCROLL else "无需滚动"),
        }

    # v1.2.0：单场详情页两个开关 + 关于页
    page.evaluate("document.querySelector('.nav-item[data-view=\"detail\"]').click()")
    page.wait_for_timeout(1200)
    report["单场标注"] = page.evaluate("""() => {
      const bar = document.querySelector('#detailBox .flag-bar');
      const cmd = bar && bar.querySelector('[data-act=\"command\"]');
      const exc = bar && bar.querySelector('[data-act=\"excluded\"]');
      if (!cmd || !exc) return { 开关渲染: false };
      const before = cmd.textContent.trim();
      cmd.click();
      return new Promise(r => setTimeout(() => {
        const now = document.querySelector('#detailBox .flag-bar [data-act="commander"]');
        r({
          开关渲染: true,
          标记前文案: before,
          标记后文案: now ? now.textContent.trim() : '（开关未重新渲染）',
          提示条: (document.querySelector('#toast') || {}).textContent || ''
        });
      }, 1200));
    }""")

    page.evaluate("document.querySelector('.nav-item[data-view=\"about\"]').click()")
    page.wait_for_timeout(600)
    report["关于页"] = page.evaluate("""() => ({
      版本: (document.querySelector('#aboutVersion') || {}).textContent || '',
      QQ群: (document.querySelector('#qqGroup') || {}).textContent || '',
      GitHub按钮: !!document.querySelector('#btnGithub')
    })""")

    report["JS错误"] = errors
    browser.close()

print(json.dumps(report, ensure_ascii=False, indent=1))
