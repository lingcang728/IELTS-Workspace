# -*- coding: utf-8 -*-
"""Web V2 smoke: landing -> onboarding -> today -> library -> exam -> submit -> results -> heatmap."""
import os, sys, time
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", r"G:\build_cache\playwright-browsers")
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173"
OUT = ".codex-verify"
os.makedirs(OUT, exist_ok=True)

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + "/#/")
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/w1-landing.png", full_page=False)
    cta = page.get_by_text("进入在线练习", exact=False).first
    print("landing CTA:", cta.is_visible() if cta.count() else "MISSING")
    cta.click()
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/w2-today-onboarding.png")
    print("hash:", page.evaluate("location.hash"))

    # Onboarding: pick band + date + minutes if the card is up
    if page.get_by_text("目标", exact=False).count() or page.locator("select").count():
        try:
            page.locator("select").first.select_option("7")
        except Exception as e:
            print("band select:", e)
        try:
            page.get_by_text("30", exact=True).first.click()
        except Exception:
            pass
        for label in ["保存", "开始", "完成", "确认"]:
            btn = page.get_by_text(label, exact=False).first
            if btn.count():
                btn.click()
                break
        page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/w3-today.png")

    page.goto(BASE + "/#/app/library")
    page.wait_for_timeout(1800)
    page.screenshot(path=f"{OUT}/w4-library.png", full_page=True)
    print("library rows:", page.locator("[class*='row'], [class*='exam']").count())

    page.goto(BASE + "/#/app/exam?exam=cambridge-18-test-1-reading&mode=practice")
    page.wait_for_timeout(2500)
    page.screenshot(path=f"{OUT}/w5-exam.png")
    print("exam title-ish:", page.locator("body").inner_text()[:200].replace("\n", " | "))

    # answer Q1 via first text input / radio then submit
    try:
        inp = page.locator("input[type='text'], input:not([type])").first
        if inp.count():
            inp.fill("library")
        else:
            radio = page.locator("input[type='radio'], [role='radio'], .option").first
            if radio.count():
                radio.click()
    except Exception as e:
        print("answer:", e)
    for label in ["完成练习", "交卷", "提交"]:
        btn = page.get_by_text(label, exact=False).first
        if btn.count():
            btn.click()
            break
    page.wait_for_timeout(800)
    confirm = page.get_by_text("确认", exact=False).first
    if confirm.count():
        confirm.click()
    page.wait_for_timeout(2500)
    page.screenshot(path=f"{OUT}/w6-results.png")
    print("after submit hash:", page.evaluate("location.hash"))

    page.goto(BASE + "/#/app")
    page.wait_for_timeout(1800)
    page.screenshot(path=f"{OUT}/w7-today-after.png")
    heat = page.locator("[class*='heat'], svg rect").count()
    print("heatmap cells:", heat)

    page.goto(BASE + "/#/app/analytics")
    page.wait_for_timeout(1800)
    page.screenshot(path=f"{OUT}/w8-analytics.png")

    browser.close()

print("CONSOLE ERRORS:", len(errors))
for e in errors[:10]:
    print("  -", e[:200])
