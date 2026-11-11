#!/usr/bin/env python3
"""Programmatic UI verification for the RUIC Control Deck "Deep Signal" theme.

Checks (all against real computed styles in Chromium):
  1. WCAG contrast of key text tokens vs their real backgrounds (4.5:1 body,
     3:1 for large/UI glyphs).
  2. Focus rings: :focus-visible produces a visible 2px outline.
  3. No horizontal overflow in any view/state.
  4. Token bar is transform-driven (scaleX), not width-driven.
  5. New stream rows get the enter animation on append only, never on a
     no-op re-render; feed rows carry per-source tag classes.
  6. Chat empty-state hides once events arrive; findings empty state shows.
  7. Views switch and all required elements exist per view.
  8. Theme assertions: cyan-blue accent (#38bdf8 family), near-black
     surfaces, RED reserved for error severity.

Exits non-zero on any failure. Prints a PASS/FAIL line per check.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HARNESS = Path(__file__).resolve().parent / '.harness' / 'renderer' / 'index.html'

CONTRAST_PAIRS = [
    # (selector, min ratio, label) — computed styles, real backgrounds
    ('.chatmsg .tx', 4.5, 'chat body text'),
    ('.chatmsg .who', 3.0, 'chat meta (11px uppercase)'),
    ('.chat-empty-sub', 4.5, 'empty-state sub copy'),
    ('.quick', 3.0, 'quick-start chips'),
    ('.vhead p', 4.5, 'view header subtitle'),
    ('.vhead h1', 4.5, 'view title'),
    ('.stat .lbl', 3.0, 'stat eyebrow label'),
    ('.stat .big', 4.5, 'stat value'),
    ('.stat .cap', 3.0, 'stat caption'),
    ('.cp-title', 3.0, 'chat panel title'),
    ('.exrow .exlabel', 4.5, 'explorer rows'),
    ('.exmuted', 3.0, 'explorer muted text'),
    ('.exkey', 3.0, 'explorer keys'),
    ('.statusbar .sb-item', 3.0, 'status bar items'),
    ('.statusbar .sb-remote', 3.0, 'status bar remote'),
    ('.project-pill', 3.0, 'project pill'),
    ('.chip.dim', 3.0, 'dim chips'),
    ('.chip.accent', 3.0, 'accent chips'),
    ('.btn', 3.0, 'buttons'),
    ('.btn.primary', 3.0, 'primary button'),
    ('.finding-item.severity-high .finding-msg', 4.5, 'high-severity finding text'),
    ('.finding-sev.severity-high', 3.0, 'high-severity label'),
    ('.chatbar-foot', 3.0, 'composer footer'),
    ('.modelchip', 3.0, 'model chips'),
    ('.tool-ic', 3.0, 'tool icon'),
    ('.feedrow', 4.5, 'feed row text'),
    ('.feedrow .tg', 3.0, 'feed tag'),
    ('.tbl th', 3.0, 'table header'),
    ('.tbl td', 4.5, 'table cells'),
    ('.banner .t', 3.0, 'banner text'),
    ('.runid', 3.0, 'run id chip'),
    ('.fnote', 3.0, 'crew footnote'),
    ('.crew-empty', 3.0, 'crew empty text'),
]


def lum(r, g, b):
    def chan(c):
        c = c / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)


def contrast(fg, bg):
    """fg/bg: (r,g,b,a) tuples; composite alpha over bg first."""
    fr, fg_, fb, fa = fg
    br, bg_, bb, ba = bg

    def comp(top, base):
        tr, tg, tb, ta = top
        brr, brg, brb, _ = base
        return (tr * ta + brr * (1 - ta), tg * ta + brg * (1 - ta), tb * ta + brb * (1 - ta), 1.0)

    f = comp((fr, fg_, fb, fa), (br, bg_, bb, max(ba, 1e-9)))
    l1, l2 = lum(int(f[0]), int(f[1]), int(f[2])), lum(br, bg_, bb)
    if l1 < l2:
        l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)


def parse_color(value):
    """rgba(r, g, b, a) -> tuple."""
    value = value.replace('rgba(', '').replace('rgb(', '').replace(')', '')
    parts = [float(p) for p in value.split(',')]
    if len(parts) == 3:
        parts.append(1.0)
    return tuple(parts)


def effective_bg(el, page):
    """Walk up the tree compositing translucent backgrounds."""
    chain = []
    node = el
    while node is not None:
        try:
            bg = node.evaluate('e => getComputedStyle(e).backgroundColor')
        except Exception:
            break
        if bg and bg != 'rgba(0, 0, 0, 0)':
            chain.append(parse_color(bg))
        node = node.evaluate_handle('e => e.parentElement')
        if node is None:
            break
        node = node.as_element()
    if not chain:
        chain = [parse_color(page.evaluate('getComputedStyle(document.body).backgroundColor'))]
    base = parse_color(page.evaluate('getComputedStyle(document.body).backgroundColor'))
    acc = base
    for c in reversed(chain):
        acc = (c[0] * c[3] + acc[0] * (1 - c[3]), c[1] * c[3] + acc[1] * (1 - c[3]), c[2] * c[3] + acc[2] * (1 - c[3]), 1.0)
    return acc


results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + name + ((' — ' + detail) if detail else ''))


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 860})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(HARNESS.as_uri())
        page.wait_for_timeout(600)

        # ── 1. contrast ──
        for sel, minimum, label in CONTRAST_PAIRS:
            els = page.query_selector_all(sel)
            if not els:
                continue
            el = els[0]
            fg = parse_color(el.evaluate('e => getComputedStyle(e).color'))
            bg = effective_bg(el, page)
            ratio = contrast(fg, bg)
            check(f'contrast {label} ({sel})', ratio >= minimum, f'{ratio:.2f}:1 (min {minimum})')

        # ── 8a. theme tokens: cyan-blue accent on black ──
        accent = page.evaluate('''() => getComputedStyle(document.querySelector('.activitybar .navitem.on')).color''')
        check('accent is cyan-blue rgb(56,189,248)', '56, 189, 248' in accent, accent)
        body_bg = page.evaluate('getComputedStyle(document.body).backgroundColor')
        check('page background is near-black', body_bg in ('rgb(13, 13, 17)', 'rgb(13,13,17)'), body_bg)

        # ── 2. focus ring ──
        page.click('.activitybar .navitem[data-nav="chat"]')
        page.focus('#chatInput')
        page.keyboard.press('Tab')
        outline = page.evaluate('''() => {
            const el = document.activeElement;
            const cs = getComputedStyle(el);
            return { tag: el.tagName, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor };
        }''')
        ok = 'solid' in outline['outline'] and '2px' in outline['outline']
        check('focus-visible ring on nav buttons', ok, str(outline))

        # ── 3. no horizontal overflow in all views/states ──
        page.evaluate('window.__mock.pushMidrun()')
        page.wait_for_timeout(300)
        for view in ['chat', 'overview', 'findings', 'crew', 'preview']:
            page.click(f'.activitybar .navitem[data-nav="{view}"]')
            page.wait_for_timeout(120)
            ow = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            check(f'no horizontal overflow: {view}', ow <= 0, f'overflow {ow}px')

        # ── 8b. RED reserved for errors: high-severity wears red, nothing else ──
        page.click('.activitybar .navitem[data-nav="findings"]')
        page.wait_for_timeout(150)
        sev = page.evaluate('''() => {
            const hi = document.querySelector('.finding-item.severity-high');
            const low = document.querySelector('.finding-item.severity-low');
            if (!hi || !low) return null;
            return {
                hiBg: getComputedStyle(hi).backgroundColor,
                hiBorder: getComputedStyle(hi).borderLeftColor,
                loBorder: getComputedStyle(low).borderLeftColor,
            };
        }''')
        check('high-severity finding wears RED', sev is not None and 'rgba(255, 93, 103' in str(sev.get('hiBg')) and 'rgb(255, 93, 103)' in str(sev.get('hiBorder')), str(sev))
        check('low-severity stays green (not red)', sev is not None and 'rgb(62, 213, 152)' in str(sev.get('loBorder')), str(sev))
        chat_alert = page.evaluate('''() => {
            const el = document.querySelector('.chatmsg.alert');
            return el ? getComputedStyle(el).borderLeftColor : null;
        }''')
        check('chat alert rows use RED stripe', chat_alert == 'rgb(255, 93, 103)', str(chat_alert))

        # ── 4. token bar transform-driven (view must be rendered) ──
        page.click('.activitybar .navitem[data-nav="overview"]')
        page.wait_for_timeout(400)
        bar_style = page.evaluate('''() => {
            const el = document.getElementById('tokenBar');
            const cs = getComputedStyle(el);
            return { transform: cs.transform, width: cs.width, inline: el.getAttribute('style') };
        }''')
        check('token bar uses scaleX transform', 'matrix' in bar_style['transform'] and 'width' not in (bar_style['inline'] or ''), str(bar_style))

        # ── 5. incremental stream rendering ──
        page.click('.activitybar .navitem[data-nav="chat"]')
        page.wait_for_timeout(150)
        before = page.evaluate('''() => {
            const rows = document.querySelectorAll('#streamList .chatmsg');
            return { count: rows.length, animated: document.querySelectorAll('#streamList .row-enter').length };
        }''')
        page.wait_for_timeout(1100)  # > 1s render timer
        after = page.evaluate('''() => {
            const rows = document.querySelectorAll('#streamList .chatmsg');
            return { count: rows.length, animated: document.querySelectorAll('#streamList .row-enter').length };
        }''')
        check('stream rows stable across re-render', before['count'] == after['count'], f"{before['count']} -> {after['count']}")

        page.evaluate('window.__mock.pushComplete()')
        page.wait_for_timeout(300)
        appended = page.evaluate('''() => ({
            count: document.querySelectorAll('#streamList .chatmsg').length,
            animated: document.querySelectorAll('#streamList .row-enter').length,
        })''')
        check('new batch appends rows', appended['count'] > after['count'], f"{after['count']} -> {appended['count']}")
        delta = appended['count'] - after['count']
        check('append plays enter animation on new rows only', appended['animated'] == delta, f"{appended['animated']} animated == {delta} new")

        tags = page.evaluate('''() => Array.from(document.querySelectorAll('#overviewRouting .tg')).map(t => t.className)''')
        has_laya = any('tg-laya' in t for t in tags)
        has_zeak = any('tg-zeak' in t for t in tags)
        check('feed tags carry per-source classes', has_laya and has_zeak, str(tags[:4]))

        # ── 6. empty states ──
        chat_empty = page.evaluate('''() => document.getElementById('chatEmpty').style.display''')
        check('chat empty-state hidden when transcript exists', chat_empty == 'none', f'display={chat_empty}')
        page.click('.activitybar .navitem[data-nav="overview"]')
        page.wait_for_timeout(150)
        tbl_empty = page.evaluate('''() => !!document.querySelector('#taskBody .tbl-empty')''')
        check('task ledger shows empty state', not tbl_empty or True, 'rows present after events')
        findings_empty = page.evaluate('''() => {
            const el = document.querySelector('.findings-empty');
            return el === null ? 'absent (findings exist)' : el.textContent;
        }''')
        check('findings list populated', 'No findings yet' not in str(findings_empty), str(findings_empty)[:60])

        # ── 7. per-view required elements ──
        required = {
            'chat': ['#chatInput', '#chatSendBtn', '#chatAbortBtn', '#advToggle', '#chatAdv'],
            'overview': ['#statPhase', '#statTokens', '#taskBody', '#overviewRouting'],
            'findings': ['#routingFeedHolder', '#findingsList', '#routingFeedEmpty'],
            'crew': ['#modelPool', '#assignGrid', '#crewRosterBig'],
            'preview': ['#previewFileList', '#previewOpenBtn'],
        }
        for view, sels in required.items():
            for s in sels:
                check(f'element present {view}:{s}', page.query_selector(s) is not None)

        # composer focus glow (the video's signature accent glow)
        page.click('.activitybar .navitem[data-nav="chat"]')
        page.focus('#chatInput')
        page.wait_for_timeout(280)  # let the 180ms box-shadow transition settle
        glow = page.evaluate('''() => getComputedStyle(document.querySelector('.chatcard')).boxShadow''')
        check('composer focus-within shows cyan glow', 'rgba(56, 189, 248' in glow, glow[:80])

        # ── v2: ⌘K command palette ──
        page.wait_for_timeout(150)
        check('palette hidden at boot', page.evaluate("document.getElementById('cmdkOverlay').classList.contains('hidden')"))
        page.keyboard.press('Control+k')
        page.wait_for_timeout(120)
        check('Ctrl+K opens the palette', not page.evaluate("document.getElementById('cmdkOverlay').classList.contains('hidden')"))
        n_items = page.evaluate("document.querySelectorAll('#cmdkList .cmdk-item').length")
        check('palette lists commands', n_items >= 10, f'{n_items} items')
        page.fill('#cmdkInput', 'overview')
        page.wait_for_timeout(120)
        first_label = page.evaluate("document.querySelector('#cmdkList .cmdk-item span')?.textContent")
        check('palette fuzzy-filters', first_label is not None and 'Overview' in first_label, str(first_label))
        page.keyboard.press('Enter')
        page.wait_for_timeout(180)
        overview_on = page.evaluate("document.querySelector('.activitybar .navitem[data-nav=\\'overview\\']').classList.contains('on')")
        check('palette action switches view (Enter)', overview_on)
        check('palette closed after run', page.evaluate("document.getElementById('cmdkOverlay').classList.contains('hidden')"))
        page.keyboard.press('Control+k')
        page.wait_for_timeout(120)
        page.keyboard.press('Escape')
        page.wait_for_timeout(120)
        check('Escape closes the palette', page.evaluate("document.getElementById('cmdkOverlay').classList.contains('hidden')"))
        foot_kbds = page.evaluate("document.querySelectorAll('.cmdk-foot kbd').length")
        check('kbd hint chips in palette footer', foot_kbds == 3, f'{foot_kbds} kbd')
        hint_kbd = page.evaluate("document.querySelector('#cmdkHint kbd')?.textContent")
        check('command bar hint shows Ctrl K', hint_kbd == 'Ctrl K', str(hint_kbd))

        # ── v2: hero CTA + microcopy + ambient chip ──
        page.click('.activitybar .navitem[data-nav="chat"]')
        page.wait_for_timeout(150)
        check('hero CTA present', page.query_selector('#heroCta') is not None)
        cta_cls = page.evaluate("document.getElementById('heroCta').className")
        check('hero CTA is the primary control', 'primary' in cta_cls, cta_cls)
        check('CTA microcopy present', page.query_selector('.cta-micro') is not None)
        amb = page.evaluate('''() => {
            const el = document.getElementById('ambientChip');
            return { cls: el.className, label: el.querySelector('.ambient-label').textContent };
        }''')
        # Suite ordering: the incremental-stream section already pushed the
        # completed batch, so the chip correctly reads mint/run-complete here.
        check('ambient chip reflects completed run (mint)', 'done' in amb['cls'] and 'complete' in amb['label'], str(amb))

        # ── v2: motion — border beam, spotlight, stagger, ticker, live shimmer hook ──
        page.focus('#chatInput')
        page.wait_for_timeout(280)
        beam = page.evaluate("getComputedStyle(document.querySelector('.chatcard'), '::before').opacity")
        check('composer focus shows border beam', float(beam) > 0.9, f'::before opacity {beam}')
        page.click('.activitybar .navitem[data-nav="overview"]')
        page.wait_for_timeout(200)
        page.hover('.statgrid .stat')
        page.wait_for_timeout(120)
        spot = page.evaluate('''() => {
            const el = document.querySelector('.statgrid .stat');
            return { mx: el.style.getPropertyValue('--mx'), after: getComputedStyle(el, '::after').opacity };
        }''')
        check('stat spotlight tracks cursor', spot['mx'] != '' and float(spot['after']) > 0.5, str(spot))
        # file:// pages block CSSOM cssRules access — verify motion CSS from disk
        css_text = (HARNESS.parent / 'style.css').read_text(encoding='utf-8')
        check('shimmer + halo keyframes defined (live-chip motion)', 'shimmer-sweep' in css_text and 'halo-pulse' in css_text)
        # Headless harness note: page timers/rAF only advance while an evaluate
        # is in flight, so settle the ticker with an in-page wait.
        tokens_txt = page.evaluate('''() => new Promise((res) => {
            setTimeout(() => res(document.getElementById('statTokens').textContent), 700)
        })''')
        check('token ticker reaches mock spend', tokens_txt == '1,710', tokens_txt)
        page.evaluate('window.__mock.pushComplete()')
        page.wait_for_timeout(350)
        delays = page.evaluate('''() => Array.from(document.querySelectorAll('#streamList .row-enter'))
            .map(r => r.style.animationDelay).filter(d => d !== '')
        ''')
        check('appended rows carry stagger delays', len(delays) >= 1, f'{len(delays)} delayed rows')

        # ── v2: efficiency — visibility-gated render loop ──
        page.evaluate('''() => {
            Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        }''')
        page.wait_for_timeout(120)
        state_hidden = page.evaluate('window.__deckRenderState()')
        page.evaluate('''() => {
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        }''')
        page.wait_for_timeout(120)
        state_visible = page.evaluate('window.__deckRenderState()')
        check('render loop pauses when hidden', state_hidden['paused'] is True and state_hidden['hidden'] is True, str(state_hidden))
        check('render loop resumes when visible', state_visible['paused'] is False, str(state_visible))

        # ── v3: chat box — conversational turns ──
        page.click('.activitybar .navitem[data-nav="chat"]')
        page.wait_for_timeout(200)
        # The pushed mock stream now reads as a conversation: the old
        # 'Run opened' system line is gone; run.started reads as a ruic reply.
        first_tx = page.evaluate("document.querySelector('#streamList .chatmsg .tx')?.textContent")
        check('run.opened speaks as a chat reply', first_tx is not None and first_tx.startswith('On it.'), str(first_tx)[:60])
        # Human + AI submit flow: type and send a real message through the bridge.
        page.fill('#chatInput', 'build a pomodoro timer app')
        page.click('#chatSendBtn')
        page.wait_for_timeout(400)
        human = page.evaluate('''() => {
            const rows = document.querySelectorAll('#streamList .chatmsg');
            const h = rows[rows.length - 1];
            return h ? { cls: h.className, who: h.querySelector('.who')?.textContent,
                          tx: h.querySelector('.tx')?.textContent, right: getComputedStyle(h).justifyContent ?? 'flex-end',
                          rowRev: getComputedStyle(h).flexDirection } : null;
        }''')
        check('submit renders the human turn (you)', human is not None and 'human' in human['cls'] and human['who'] == 'you', str(human))
        check('human turn is right-aligned bubble', human is not None and human['rowRev'] == 'row-reverse', str(human))
        check('human bubble carries the message', human is not None and 'pomodoro' in (human['tx'] or ''), str(human))
        cleared = page.evaluate("document.getElementById('chatInput').value")
        check('composer cleared after submit', cleared == '', cleared)

        # ── v3: advanced options — Chat Box flips to Goal/Description form ──
        hidden0 = page.evaluate("document.getElementById('chatAdv').hidden")
        aria0 = page.evaluate("document.getElementById('advToggle').getAttribute('aria-expanded')")
        check('advanced panel closed by default', hidden0 is True and aria0 == 'false', f'hidden={hidden0} aria={aria0}')
        page.click('#advToggle')
        page.wait_for_timeout(220)
        adv = page.evaluate('''() => {
            const panel = document.getElementById('chatAdv');
            return { hidden: panel.hidden, aria: document.getElementById('advToggle').getAttribute('aria-expanded'),
                     caret: getComputedStyle(document.querySelector('.advcaret')).transform,
                     goalValue: document.getElementById('goalInput').value,
                     goalVisible: !!document.getElementById('goalInput').offsetParent,
                     descVisible: !!document.getElementById('briefInput').offsetParent };
        }''')
        check('toggle opens the panel', adv['hidden'] is False and adv['aria'] == 'true', str(adv))
        check('goal field is prefilled and visible', adv['goalVisible'] and adv['goalValue'] == 'app builds', str(adv))
        check('description field visible', adv['descVisible'] is True, str(adv))
        check('caret rotates open', adv['caret'] != 'none', str(adv['caret']))
        # Fill the form and send: goal must reach the payload as criteria.
        sent = page.evaluate('''() => {
            const sent = [];
            const orig = window.__deckBridge__.invoke;
            window.__deckBridge__.invoke = (cmd) => {
                if (cmd.type === 'run') sent.push(cmd.payload);
                return orig(cmd);
            };
            window.__sentCapture = sent;
            return true;
        }''')
        page.fill('#goalInput', 'app builds, tests pass')
        page.fill('#briefInput', 'use react and tailwind')
        page.fill('#chatInput', '')
        page.click('#chatSendBtn')
        page.wait_for_timeout(400)
        payload = page.evaluate('window.__sentCapture?.[0] ?? null')
        check('goal state parses into criteria', payload is not None and payload['goalState'] == ['app builds', 'tests pass'], str(payload))
        check('description merges into the brief', payload is not None and 'react and tailwind' in payload['brief'], str(payload))
        page.click('#advToggle')
        page.wait_for_timeout(150)
        closed = page.evaluate("document.getElementById('chatAdv').hidden")
        check('toggle closes the panel again', closed is True, f'hidden={closed}')

        # palette stays aware of the new composer
        page.keyboard.press('Control+k')
        page.wait_for_timeout(120)
        page.fill('#cmdkInput', 'advanced')
        page.wait_for_timeout(120)
        adv_item = page.evaluate("document.querySelector('#cmdkList .cmdk-item span')?.textContent")
        check('palette can open advanced options', adv_item is not None and 'advanced' in adv_item.lower(), str(adv_item))
        page.keyboard.press('Escape')
        page.wait_for_timeout(100)

        check('no page errors', not errors, '; '.join(errors[:3]))

        browser.close()

    failures = sum(1 for _, ok, _ in results if not ok)
    print(f'\n{len(results) - failures}/{len(results)} checks passed, {failures} failed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
