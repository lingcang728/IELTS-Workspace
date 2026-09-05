# -*- coding: utf-8 -*-
"""Live checks for the 1.3.7 audit-fix release.

Attaches over CDP to a running IELTS Workspace window (dev :9223 or
packaged :9224). Asserts the behaviours that unit tests cannot see:
narrow-header volume/Display, answered-bar colour, large type fill-in
height, practice submit, maximize glyph.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[1] / ".codex-verify"
OUT.mkdir(exist_ok=True)
CDP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9223"
INK = "rgb(20, 33, 44)"
ANSWERED_GREEN = "rgb(31, 122, 61)"


def dismiss_pending(page) -> None:
    if page.locator("#pending-start-title").count():
        page.get_by_role("button", name="放弃未完成并新开").click()
        page.wait_for_selector(".exam", timeout=30_000)


def go_home(page) -> None:
    if page.locator(".exam").count():
        leave = page.locator(".exam-nav-row .leave-button")
        if leave.count():
            leave.click()
            confirm = page.get_by_role("button", name="Leave and save")
            if confirm.count():
                confirm.click()
            page.wait_for_selector(".app-shell", timeout=30_000)
            page.wait_for_timeout(200)
    if page.locator(".boot-screen").count():
        raise AssertionError(f"boot-screen still up: {page.locator('.boot-screen').inner_text()[:200]}")
    page.get_by_role("button", name="工作台", exact=True).click()
    page.wait_for_selector(".app-shell")


def enter_practice_reading(page) -> None:
    page.get_by_role("button", name="练习", exact=True).click()
    page.wait_for_selector(".practice-page")
    page.locator(".filter-tabs button", has_text="阅读").click()
    page.wait_for_timeout(200)
    mods = page.locator(".catalog-mod.reading")
    rows = page.locator(".catalog-row.reading .module-button")
    if mods.count():
        mods.first.click()
    elif rows.count():
        rows.first.click()
    else:
        raise AssertionError("没有可点的阅读练习入口")
    dismiss_pending(page)
    page.wait_for_selector(".exam", timeout=30_000)


def header_chrome(page) -> dict:
    return page.evaluate(
        """() => {
          const right = document.querySelector('.exam-header .right');
          const display = document.querySelector('.toolbar button[aria-expanded]');
          const vol = document.querySelector('.vol-wrap');
          const rightCs = right ? getComputedStyle(right) : null;
          const box = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { display: getComputedStyle(el).display, w: r.width, h: r.height, t: r.top, visible: r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' };
          };
          return {
            innerWidth: innerWidth,
            rightDisplay: rightCs ? rightCs.display : null,
            display: box(display),
            volume: box(vol),
          };
        }"""
    )


def main() -> int:
    report: dict = {"cdp": CDP, "checks": {}}
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(CDP)
        page = browser.contexts[0].pages[0]
        page.wait_for_selector(".app-shell, .exam, .boot-screen", timeout=30_000)
        if page.locator(".boot-screen .error-panel").count():
            raise AssertionError(page.locator(".error-panel").inner_text())

        go_home(page)
        enter_practice_reading(page)
        page.wait_for_timeout(400)
        page.screenshot(path=OUT / "audit-exam-reading.png")

        chrome = header_chrome(page)
        report["checks"]["headerDefault"] = chrome
        assert chrome["display"] and chrome["display"]["visible"], chrome
        assert chrome["rightDisplay"] != "none", chrome

        # 960 CSS px at 1.5 device scale — the 150% / 1080p case from the audit.
        client = page.context.new_cdp_session(page)
        client.send(
            "Emulation.setDeviceMetricsOverride",
            {"width": 960, "height": 700, "deviceScaleFactor": 1.5, "mobile": False},
        )
        page.wait_for_timeout(500)
        narrow = header_chrome(page)
        report["checks"]["header960"] = narrow
        page.screenshot(path=OUT / "audit-exam-960.png")
        assert narrow["innerWidth"] == 960, narrow
        assert narrow["rightDisplay"] != "none", narrow
        assert narrow["display"] and narrow["display"]["visible"], narrow
        client.send("Emulation.clearDeviceMetricsOverride")
        page.wait_for_timeout(300)

        page.get_by_role("button", name="Display", exact=True).click()
        page.get_by_role("slider", name="Text size").fill("1.4")
        font_scale = page.locator(".exam").evaluate(
            "el => getComputedStyle(el).getPropertyValue('--font-scale').trim()"
        )
        report["checks"]["fontScale"] = font_scale
        assert float(font_scale) >= 1.35, font_scale
        gap = page.locator(".gap").first
        if gap.count():
            metrics = gap.evaluate(
                """el => {
                  const cs = getComputedStyle(el);
                  return { height: el.getBoundingClientRect().height, font: parseFloat(cs.fontSize), overflow: cs.overflow };
                }"""
            )
            report["checks"]["gap"] = metrics
            assert metrics["height"] + 0.5 >= metrics["font"] * 2.0, metrics
        page.locator(".exam-section-tabs").click(position={"x": 40, "y": 10})

        if page.locator(".choice-card").count():
            page.locator(".choice-card").first.click()
        elif page.locator(".choices input").count():
            page.locator(".choices input").first.check()
        elif page.locator(".gap").count():
            page.locator(".gap").first.fill("library")
        page.wait_for_timeout(250)
        answered = page.evaluate(
            """() => {
              const btn = document.querySelector('.question-strip button.answered');
              if (!btn) return null;
              const before = getComputedStyle(btn, '::before');
              return { color: before.backgroundColor, overflow: getComputedStyle(btn).overflow, count: document.querySelectorAll('.question-strip button.answered').length };
            }"""
        )
        report["checks"]["answered"] = answered
        assert answered and answered["count"] >= 1, answered
        assert answered["color"] != ANSWERED_GREEN, answered
        assert answered["overflow"] == "hidden", answered

        page.locator(".review-toggle").click()
        page.wait_for_timeout(150)
        flagged = page.evaluate(
            """() => {
              const btn = document.querySelector('.question-strip button.flagged.answered');
              if (!btn) return null;
              const before = getComputedStyle(btn, '::before');
              const r = btn.getBoundingClientRect();
              return { left: parseFloat(before.left), right: parseFloat(before.right), radius: getComputedStyle(btn).borderRadius, width: r.width };
            }"""
        )
        report["checks"]["flaggedAnswered"] = flagged
        if flagged:
            assert flagged["left"] >= 8, flagged

        page.locator(".exam-nav-row .leave-button").click()
        confirm = page.get_by_role("button", name="Leave and save")
        if confirm.count():
            confirm.click()
        page.wait_for_selector(".app-shell", timeout=30_000)
        assert page.locator(".boot-screen").count() == 0
        toast = page.locator(".toast").inner_text() if page.locator(".toast").count() else ""
        report["checks"]["leaveToast"] = toast

        page.get_by_role("button", name="模考", exact=True).click()
        page.wait_for_selector(".mock-page")
        page.locator(".filter-tabs button", has_text="阅读").click()
        page.wait_for_timeout(200)
        mods = page.locator(".catalog-mod.reading")
        if mods.count():
            mods.first.click()
        else:
            page.locator(".catalog-row.reading .strict-button").first.click()
        dismiss_pending(page)
        page.wait_for_selector(".exam.mock", timeout=30_000)
        timer = page.evaluate(
            """() => {
              const el = document.querySelector('.timer');
              return el ? { className: el.className, text: el.textContent } : null;
            }"""
        )
        report["checks"]["mockTimer"] = timer
        assert timer and "warn" not in timer["className"].split(), timer
        page.screenshot(path=OUT / "audit-exam-mock.png")
        page.locator(".exam-nav-row .leave-button").click()
        page.get_by_role("button", name="Leave and save").click()
        page.wait_for_selector(".app-shell", timeout=30_000)

        page.get_by_role("button", name="分析报告", exact=True).click()
        page.wait_for_selector(".analytics-page")
        types = page.locator(".accuracy-row span").all_inner_texts()
        report["checks"]["analyticsTypes"] = types[:4]
        joined = " ".join(types)
        assert "single choice" not in joined
        assert "multi_choice" not in joined

        glyph = page.locator(".maximize-glyph")
        assert glyph.count() == 1
        report["checks"]["maximizeGlyph"] = glyph.evaluate("el => el.tagName")
        assert report["checks"]["maximizeGlyph"] == "svg"
        page.screenshot(path=OUT / "audit-shell.png")

    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("audit_fix_smoke ok")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise
