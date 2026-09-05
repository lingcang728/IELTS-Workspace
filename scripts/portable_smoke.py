from pathlib import Path
from time import perf_counter

from playwright.sync_api import sync_playwright


OUT = Path(__file__).resolve().parents[1] / ".codex-verify" / "portable-home.png"
started = perf_counter()

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9224")
    page = browser.contexts[0].pages[0]
    page.wait_for_selector(".app-shell, .exam, .audio-wizard-backdrop", timeout=30_000)
    if page.locator("#pending-start-title").count():
        page.get_by_role("button", name="取消").click()
        page.wait_for_timeout(200)
    if page.locator(".exam").count():
        page.locator(".exam-nav-row .leave-button").click()
        confirm = page.get_by_role("button", name="Leave and save")
        if confirm.count():
            confirm.click()
        page.wait_for_selector(".app-shell", timeout=15_000)
    ready_ms = round((perf_counter() - started) * 1000)
    page.get_by_role("button", name="练习", exact=True).click()
    page.wait_for_selector(".practice-page")
    page.wait_for_timeout(300)
    page.screenshot(path=OUT)
    metrics = page.evaluate("""() => ({
      visibleRows: document.querySelectorAll('.catalog-row').length,
      horizontalOverflow: document.body.scrollWidth > innerWidth,
      replacementCharacters: (document.body.innerText.match(/\uFFFD/g) || []).length,
      title: document.querySelector('.page-heading h1')?.textContent,
    })""")
    page.locator(".filter-tabs button", has_text="听力").click()
    page.get_by_placeholder("搜索题目").fill("Cambridge IELTS 21")
    page.wait_for_timeout(100)
    unverified_c21_listening_rows = page.locator(".catalog-row").count()
    assert unverified_c21_listening_rows == 0
    metrics["unverifiedC21ListeningRows"] = unverified_c21_listening_rows

    page.get_by_placeholder("搜索题目").fill("")
    page.locator(".filter-tabs button", has_text="阅读").click()
    page.wait_for_timeout(200)
    if page.locator(".catalog-book-flat .module-button").count():
        page.locator(".catalog-book-flat .module-button").first.click()
    elif page.locator(".catalog-mod.reading").count():
        page.locator(".catalog-mod.reading").first.click()
    else:
        page.locator(".catalog-row .module-button").first.click()
    if page.locator("#pending-start-title").count():
        page.get_by_role("button", name="放弃未完成并新开").click()
    page.wait_for_selector(".exam-body.reading", timeout=30_000)
    passage_text = page.locator(".passage").inner_text()
    assert len(passage_text) > 80, passage_text[:120]

    page.get_by_role("button", name="Display", exact=True).click()
    page.get_by_role("slider", name="Text size").fill("1.15")
    font_scale = page.locator(".exam").evaluate(
        "el => getComputedStyle(el).getPropertyValue('--font-scale').trim()"
    )
    page.locator(".exam-section-tabs").click(position={"x": 700, "y": 20})
    outside_click_closed = page.locator(".options-pop").count() == 0
    assert outside_click_closed
    page.screenshot(path=OUT.parent / "portable-reading.png")

    metrics["readingPassageCharacters"] = len(passage_text)
    metrics["fontSlider"] = font_scale
    metrics["outsideClickClosed"] = outside_click_closed
    print({"readyMsAfterCdpConnect": ready_ms, **metrics})
    page.get_by_role("button", name="关闭").click(no_wait_after=True)
    browser.close()
