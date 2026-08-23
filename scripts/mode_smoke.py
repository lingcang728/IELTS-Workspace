from pathlib import Path
from time import perf_counter

from playwright.sync_api import sync_playwright


OUT = Path(__file__).resolve().parents[1] / ".codex-verify"
OUT.mkdir(exist_ok=True)


def open_home(page):
    page.reload()
    page.wait_for_selector(".app-shell", timeout=30_000)
    page.wait_for_timeout(300)


def page_metrics(page):
    return page.evaluate("""() => ({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.body.scrollWidth,
      scrollHeight: document.body.scrollHeight,
      replacementCharacters: (document.body.innerText.match(/\uFFFD/g) || []).length,
    })""")


with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9223")
    page = browser.contexts[0].pages[0]

    open_home(page)
    initial = page_metrics(page)

    captures = [
        ("Reading", "06-exam-reading-practice.png"),
        ("Writing", "07-exam-writing-practice.png"),
    ]
    entry_times = {}
    reading_checks = {}
    for module, filename in captures:
        open_home(page)
        page.get_by_role("button", name="练习", exact=True).click()
        page.get_by_role("button", name=module, exact=True).click()
        started = perf_counter()
        page.locator(".catalog-row .module-button").first.click()
        page.wait_for_selector(f".exam-body.{module.lower()}", timeout=30_000)
        entry_times[module] = round((perf_counter() - started) * 1000)
        page.wait_for_timeout(300)
        page.screenshot(path=OUT / filename)
        if module == "Reading":
            passage_text = page.locator(".passage").inner_text()
            assert "Stepwells" in passage_text
            assert page.get_by_role("button", name="NOT GIVEN", exact=True).first.is_visible()
            page.get_by_role("button", name="Display", exact=True).click()
            slider = page.get_by_role("slider", name="Text size")
            slider.fill("1.2")
            page.screenshot(path=OUT / "09-reading-display-slider.png")
            page.locator(".exam-section-tabs").click(position={"x": 700, "y": 20})
            assert page.locator(".options-pop").count() == 0
            reading_checks = {
                "passageCharacters": len(passage_text),
                "notGivenVisible": True,
                "fontScale": page.locator(".exam").evaluate("el => getComputedStyle(el).getPropertyValue('--font-scale').trim()"),
                "outsideClickClosed": True,
            }

    open_home(page)
    page.get_by_role("button", name="模考", exact=True).click()
    started = perf_counter()
    page.locator(".catalog-row .strict-button").first.click()
    page.wait_for_selector(".exam.mock", timeout=30_000)
    entry_times["Mock"] = round((perf_counter() - started) * 1000)
    page.wait_for_timeout(300)
    page.screenshot(path=OUT / "08-exam-mock.png")
    mock_text = page.locator(".exam-header").inner_text()

    print({
        "initial": initial,
        "entryMs": entry_times,
        "reading": reading_checks,
        "mockHeader": mock_text,
    })
    browser.close()
