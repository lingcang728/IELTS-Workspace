from pathlib import Path
from playwright.sync_api import sync_playwright


OUT = Path(__file__).resolve().parents[1] / ".codex-verify"
OUT.mkdir(exist_ok=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9223")
    page = browser.contexts[0].pages[0]
    page.reload()
    page.wait_for_selector(".app-shell", timeout=30_000)
    page.wait_for_timeout(350)
    page.screenshot(path=OUT / "01-home.png")
    home = page.evaluate("""() => {
      const top = document.querySelector('.top-grid')?.getBoundingClientRect();
      const bottom = document.querySelector('.bottom-grid')?.getBoundingClientRect();
      return {
        statusFooters: document.querySelectorAll('.status-footer').length,
        sidebarBottoms: document.querySelectorAll('.sidebar-bottom').length,
        overlapPx: top && bottom ? Math.max(0, top.bottom - bottom.top) : -1,
      };
    }""")
    assert home["statusFooters"] == 0
    assert home["sidebarBottoms"] == 0
    assert home["overlapPx"] == 0

    page.get_by_role("button", name="练习", exact=True).click()
    page.wait_for_selector(".practice-page")
    page.wait_for_timeout(350)
    page.screenshot(path=OUT / "02-practice.png")
    assert page.locator(".status-footer").count() == 0
    assert page.locator(".sidebar-bottom").count() == 0

    page.get_by_role("button", name="模考", exact=True).click()
    page.wait_for_selector(".mock-page")
    page.wait_for_timeout(350)
    page.screenshot(path=OUT / "03-mock.png")
    assert page.locator(".exam-rules").count() == 0

    page.get_by_role("button", name="分析报告", exact=True).click()
    page.wait_for_selector(".analytics-page")
    page.wait_for_timeout(350)
    page.screenshot(path=OUT / "04-analytics.png")
    accuracy_font = page.evaluate("""() => {
      let el = document.querySelector('.accuracy-row');
      let temporary = false;
      if (!el) {
        el = document.createElement('div');
        el.className = 'accuracy-row';
        el.style.position = 'absolute';
        el.style.visibility = 'hidden';
        document.body.appendChild(el);
        temporary = true;
      }
      const value = parseFloat(getComputedStyle(el).fontSize);
      if (temporary) el.remove();
      return value;
    }""")
    assert accuracy_font >= 14

    page.get_by_role("button", name="练习", exact=True).click()
    page.locator(".catalog-row .module-button").first.click()
    page.wait_for_selector(".exam", timeout=30_000)
    page.wait_for_timeout(350)
    page.screenshot(path=OUT / "05-exam-practice.png")

    metrics = page.evaluate("""() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      mode: document.querySelector('.exam')?.className,
      module: document.querySelector('.exam-header .left strong')?.textContent,
      navigatorButtons: document.querySelectorAll('.exam-nav .question-strip button').length,
      navigatorBottom: (() => {
        const strip = document.querySelector('.exam-nav .question-strip');
        const body = document.querySelector('.exam-body');
        return strip && body ? strip.getBoundingClientRect().top >= body.getBoundingClientRect().bottom - 1 : null;
      })(),
      rightRailRemoved: document.querySelectorAll('.exam-right-nav').length === 0,
      examChromeIsLight: getComputedStyle(document.querySelector('.exam')).backgroundColor,
    })""")
    # docs/ui-reference.md: the 40-question navigator sits along the BOTTOM.
    assert metrics["navigatorButtons"] == 40, metrics
    assert metrics["navigatorBottom"] is True, metrics
    assert metrics["rightRailRemoved"] is True, metrics
    print({"home": home, "accuracyFontPx": accuracy_font, "exam": metrics})
    browser.close()
