#!/usr/bin/env python3
"""Drive the UI visual-check harness with Playwright and screenshot every
view in three run states (idle / mid-run live / completed).

Usage: python3 ui_shots.py <outdir> <label>
Writes <outdir>/<label>-<name>.png files.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HARNESS = Path(__file__).resolve().parent / '.harness' / 'renderer' / 'index.html'
VIEWS = ['chat', 'overview', 'findings', 'crew', 'preview']


def shot(page, outdir: Path, label: str, name: str):
    # Headless harness: page timers only advance during an in-flight evaluate,
    # so settle in-page (ticker fallback, CSS animations) before capturing.
    page.evaluate('() => new Promise((res) => setTimeout(res, 420))')
    page.wait_for_timeout(120)
    page.screenshot(path=str(outdir / f'{label}-{name}.png'))
    print(f'  saved {label}-{name}.png')


def main() -> None:
    outdir = Path(sys.argv[1])
    label = sys.argv[2]
    outdir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 860})
        page.goto(HARNESS.as_uri())
        page.wait_for_timeout(600)  # boot: subscribe, replay, crewHealth

        # 1) idle state (bridge live, empty run) — every view
        print(f'[{label}] idle state')
        shot(page, outdir, label, '01-chat-idle')
        for view in VIEWS[1:]:
            page.click(f'.activitybar .navitem[data-nav="{view}"]')
            shot(page, outdir, label, f'0{VIEWS.index(view) + 2}-{view}-idle')

        # 2) mid-run live state — push scripted events through subscribe
        print(f'[{label}] mid-run state')
        page.click('.activitybar .navitem[data-nav="chat"]')
        page.evaluate('window.__mock.pushMidrun()')
        page.wait_for_timeout(400)
        shot(page, outdir, label, '07-chat-live')
        page.click('.activitybar .navitem[data-nav="overview"]')
        shot(page, outdir, label, '08-overview-live')
        page.click('.activitybar .navitem[data-nav="findings"]')
        shot(page, outdir, label, '09-findings-live')

        # 3) completed run with preview files
        print(f'[{label}] completed state')
        page.evaluate('window.__mock.pushComplete()')
        page.wait_for_timeout(400)
        page.click('.activitybar .navitem[data-nav="chat"]')
        shot(page, outdir, label, '10-chat-completed')
        page.click('.activitybar .navitem[data-nav="preview"]')
        shot(page, outdir, label, '11-preview-completed')

        # 4) focus states — type into the composer to show the focus glow
        page.click('.activitybar .navitem[data-nav="chat"]')
        page.focus('#chatInput')
        page.keyboard.type('write a readme for a calculator app')
        shot(page, outdir, label, '13-chat-typed')

        # 5) advanced options — the composer flips to Goal/Description form
        page.click('#advToggle')
        page.wait_for_timeout(200)
        page.fill('#goalInput', 'app builds, readme covers usage')
        page.fill('#briefInput', 'plain language, short sections, no emoji')
        shot(page, outdir, label, '15-advanced-open')
        page.click('#advToggle')

        # 6) ⌘K command palette open, filtered
        page.keyboard.press('Control+k')
        page.keyboard.type('go to')
        shot(page, outdir, label, '14-cmdk')

        browser.close()
    print(f'[{label}] done -> {outdir}')


if __name__ == '__main__':
    main()
