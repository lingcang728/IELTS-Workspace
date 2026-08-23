from playwright.sync_api import TimeoutError, sync_playwright


def metrics(page):
    return page.evaluate("""() => ({
      inner: [innerWidth, innerHeight],
      outer: [outerWidth, outerHeight],
      screen: [screen.availWidth, screen.availHeight],
      hasHorizontalOverflow: document.body.scrollWidth > innerWidth,
    })""")


with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9223")
    page = browser.contexts[0].pages[0]
    page.reload()
    page.wait_for_selector(".app-shell", timeout=30_000)
    page.wait_for_timeout(300)
    initial = metrics(page)

    page.get_by_role("button", name="最大化或还原").click()
    page.wait_for_timeout(500)
    maximized = metrics(page)
    page.get_by_role("button", name="最大化或还原").click()
    page.wait_for_timeout(500)
    restored = metrics(page)

    page.keyboard.press("F11")
    page.wait_for_timeout(500)
    fullscreen = metrics(page)
    page.keyboard.press("F11")
    page.wait_for_timeout(500)
    fullscreen_restored = metrics(page)

    closed = False
    try:
        with page.expect_event("close", timeout=5_000):
            page.get_by_role("button", name="关闭").click(no_wait_after=True)
        closed = True
    except TimeoutError:
        closed = page.is_closed()

    print({
        "initial": initial,
        "maximized": maximized,
        "restored": restored,
        "fullscreen": fullscreen,
        "fullscreenRestored": fullscreen_restored,
        "closed": closed,
    })
    browser.close()
