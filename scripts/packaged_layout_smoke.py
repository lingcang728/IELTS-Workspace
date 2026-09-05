# -*- coding: utf-8 -*-
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9224"

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(CDP)
    page = browser.contexts[0].pages[0]
    if page.locator(".exam").count():
        page.locator(".exam-nav-row .leave-button").click()
        confirm = page.get_by_role("button", name="Leave and save")
        if confirm.count():
            confirm.click()
        page.wait_for_selector(".app-shell", timeout=15_000)
    page.get_by_role("button", name="工作台", exact=True).click()
    page.wait_for_selector(".bottom-grid")
    page.wait_for_timeout(300)
    dash = page.evaluate(
        """() => {
          const h = (sel) => [...document.querySelectorAll(sel)].map(el => Math.round(el.getBoundingClientRect().height));
          return { top: h('.top-grid > .workspace-card'), bottom: h('.bottom-grid > .workspace-card') };
        }"""
    )
    print("dash", dash)
    assert len(dash["top"]) == 2 and abs(dash["top"][0] - dash["top"][1]) <= 1, dash
    assert len(dash["bottom"]) == 2 and abs(dash["bottom"][0] - dash["bottom"][1]) <= 1, dash
    page.get_by_role("button", name="练习", exact=True).click()
    page.wait_for_selector(".catalog-books")
    page.wait_for_timeout(300)
    cat = page.evaluate(
        """() => {
          const el = document.querySelector('.catalog-card .catalog-books');
          const cs = getComputedStyle(el);
          const inner = el.scrollHeight > el.clientHeight + 2 && (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
          return { overflow: cs.overflowY, innerBar: inner };
        }"""
    )
    print("catalog", cat)
    assert cat["overflow"] == "visible"
    assert not cat["innerBar"]
    print("packaged_layout_smoke ok")
