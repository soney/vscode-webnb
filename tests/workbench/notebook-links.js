/**
 * Cross-notebook links, checked in a real VS Code workbench.
 *
 * The preview harness cannot cover this: following a link opens a *different*
 * notebook, which only exists inside the workbench. Each scenario clicks one
 * link in a fresh browser session and reports where it landed, plus a
 * screenshot -- the reveal has to be looked at, since a notebook's cell list is
 * virtualized and its scroll offset is not readable from the DOM.
 *
 *   node scripts/vscode-test-web.js samplenotebooks/links.webnb --browser none --port 3066
 *   node tests/workbench/notebook-links.js                  # every scenario
 *   node tests/workbench/notebook-links.js "A section of it" # just one
 *   WEBNB_RUN_ALL=1 node tests/workbench/notebook-links.js "this link"
 *
 * `WEBNB_RUN_ALL` runs the notebook first, for links that live in a rendered
 * output rather than in prose.
 *
 * Each scenario states where the click must land: the active tab, the
 * warning it must (or must not) raise, and for section links the section the
 * notebook selects (the last breadcrumb entry, which names the heading of the
 * selected cell -- "at top" is printed but not checked, for the reason
 * above). A scenario whose link cannot be found, whose notebook never
 * renders, or that lands anywhere else FAILS, and the process exits 1 after
 * running the rest. The printed report and screenshots are there to see why.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const URL = process.env.WEBNB_URL || 'http://localhost:3066';
const SHOTS = path.join(os.tmpdir(), 'webnb-link-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function previewFrames(page) {
    const out = [];
    for (const frame of page.frames()) {
        try {
            if (await frame.evaluate(() => document.querySelectorAll('.preview').length > 0)) { out.push(frame); }
        } catch { /* detached */ }
    }
    return out;
}

async function waitForNotebook(page) {
    for (let i = 0; i < 60; i++) {
        if ((await previewFrames(page)).length) { return true; }
        await sleep(1000);
    }
    return false;
}

/** Anchors live in shadow roots, in markup previews and in rendered outputs alike. */
const DEEP_ANCHORS = `(root) => {
    const found = [];
    const walk = (node) => {
        for (const el of node.querySelectorAll('*')) {
            if (el.tagName === 'A') { found.push(el); }
            if (el.shadowRoot) { walk(el.shadowRoot); }
        }
    };
    walk(root);
    return found;
}`;

async function clickLink(page, text) {
    for (const frame of await previewFrames(page)) {
        try {
            const href = await frame.evaluate(({ t, fn }) => {
                const anchors = eval(fn)(document);
                for (const a of anchors) {
                    if (a.textContent.trim() === t) {
                        a.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, view: window }));
                        return a.getAttribute('href');
                    }
                }
                return null;
            }, { t: text, fn: DEEP_ANCHORS });
            if (href !== null) { return href; }
        } catch { /* detached */ }
    }
    return null;
}

async function runAllCells(page) {
    const button = page.locator('.notebook-editor .monaco-toolbar a.action-label[aria-label*="Run All"]').first();
    try {
        await button.click({ timeout: 10000 });
        await sleep(6000);
    } catch { /* nothing to run */ }
}

/** Tabs, warnings, and the first heading actually visible in the viewport. */
async function observe(page) {
    const workbench = await page.evaluate(() => ({
        tabs: Array.from(document.querySelectorAll('.tabs-container .tab')).map(t => ({
            label: t.querySelector('.label-name')?.textContent,
            active: t.classList.contains('active'),
        })),
        warnings: Array.from(document.querySelectorAll('.notification-list-item-message')).map(n => n.textContent.trim()),
        breadcrumb: Array.from(document.querySelectorAll('.monaco-breadcrumbs .monaco-breadcrumb-item'))
            .map(b => b.textContent.trim()).filter(Boolean),
        cellStatus: Array.from(document.querySelectorAll('.statusbar-item'))
            .map(i => i.textContent.trim()).find(t => /^Cell \d+ of \d+$/.test(t)) || '',
    }));

    const visible = [];
    for (const frame of await previewFrames(page)) {
        try {
            visible.push(...await frame.evaluate(() => Array.from(document.querySelectorAll('.preview'))
                .map(p => {
                    const rect = p.getBoundingClientRect();
                    const root = p.shadowRoot || p;
                    const heading = root.querySelector('h1,h2,h3');
                    return { top: Math.round(rect.top), height: Math.round(rect.height), heading: heading?.textContent?.trim() };
                })
                .filter(x => x.heading && x.height > 0)));
        } catch { /* detached */ }
    }
    visible.sort((a, b) => a.top - b.top);
    return { ...workbench, headings: visible };
}

/**
 * Every link in samplenotebooks/links.webnb worth clicking, keyed by its text,
 * with where it must land: `tab` is the file in the active editor tab
 * afterwards, `section` the heading of the cell the notebook selected
 * (section links only), `warning` a substring the one expected notification
 * must contain. No `warning` means none may appear.
 */
const SCENARIOS = {
    'The whole notebook': { tab: 'links-target.webnb' },
    'A section of it': { tab: 'links-target.webnb', section: 'Beta' },
    'A section, spelled out': { tab: 'links-target.webnb', section: 'The fetch API, really?' },
    'From the workspace root': { tab: 'links-target.webnb', section: 'Beta' },
    'A notebook in a subfolder, with spaces in its name': { tab: 'links nested.webnb' },
    'Down to the last section': { tab: 'links.webnb', section: 'The Last Section' },
    'A notebook that does not exist': { tab: 'links.webnb', warning: 'There is no notebook at "missing.webnb"' },
    'A section that does not exist': { tab: 'links-target.webnb', warning: 'has no section called "#no-such-section"' },
    'A source file': { tab: 'notes.txt' },
};

/** Tab labels may leave the extension off ("links-target" for links-target.webnb). */
function sameFile(label, fileName) {
    return label === fileName || label === fileName.replace(/\.[^.]+$/, '');
}

/** Where the click landed versus where it should have; empty means it passed. */
function mismatches(expected, observed) {
    const problems = [];
    if (!sameFile(observed.activeTab, expected.tab)) {
        problems.push(`active tab is ${JSON.stringify(observed.activeTab)}, expected ${JSON.stringify(expected.tab)}`);
    }
    if (expected.section && observed.selectedSection !== expected.section) {
        problems.push(`selected section is ${JSON.stringify(observed.selectedSection)}, expected ${JSON.stringify(expected.section)}`);
    }
    if (expected.warning) {
        if (!observed.warnings.some(w => w.includes(expected.warning))) {
            problems.push(`no warning containing ${JSON.stringify(expected.warning)}`);
        }
    } else if (observed.warnings.length > 0) {
        problems.push(`unexpected warning(s): ${JSON.stringify(observed.warnings)}`);
    }
    return problems;
}

async function runScenario(name, expected) {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        if (!await waitForNotebook(page)) {
            return { passed: false, report: `FAIL ${name}: notebook never rendered at ${URL}` };
        }
        await sleep(6000);

        if (process.env.WEBNB_RUN_ALL) { await runAllCells(page); }
        const href = await clickLink(page, name);
        if (href === null) {
            return { passed: false, report: `FAIL ${name}: no link with that text in the rendered notebook` };
        }
        await sleep(7000);
        const after = await observe(page);
        const shot = path.join(SHOTS, `${name.replace(/[^a-z0-9]+/gi, '-')}.png`);
        await page.screenshot({ path: shot });

        const observed = {
            activeTab: after.tabs.find(t => t.active)?.label,
            topHeading: after.headings[0]?.heading,
            selectedSection: after.breadcrumb[after.breadcrumb.length - 1],
            warnings: after.warnings.filter(w => !w.includes('proposed API')),
        };
        const problems = expected ? mismatches(expected, observed) : [];
        return {
            passed: problems.length === 0,
            report: [
                `${problems.length ? 'FAIL' : 'ok  '} ${name}  (href=${href})`,
                `   tab       : ${observed.activeTab}   [${after.tabs.map(t => t.label).join(', ')}]`,
                `   at top    : ${observed.topHeading ?? '(no heading in view)'}`,
                `   warnings  : ${observed.warnings.length ? JSON.stringify(observed.warnings) : 'none'}`,
                `   revealed  : ${after.breadcrumb.join(' > ') || '(no breadcrumb)'}  ${after.cellStatus}`,
                `   screenshot: ${shot}`,
                ...problems.map(problem => `   PROBLEM   : ${problem}`),
            ].join('\n'),
        };
    } catch (error) {
        return { passed: false, report: `FAIL ${name}: ${error instanceof Error ? error.message : error}` };
    } finally {
        await browser.close();
    }
}

async function main() {
    fs.mkdirSync(SHOTS, { recursive: true });
    const only = process.argv[2];
    // A link text outside the table still runs (it may live in another
    // notebook); it only fails when the link cannot be found or clicked.
    const names = only ? [only] : Object.keys(SCENARIOS);
    const failed = [];
    for (const name of names) {
        const { passed, report } = await runScenario(name, Object.hasOwn(SCENARIOS, name) ? SCENARIOS[name] : undefined);
        console.log(report);
        console.log('');
        if (!passed) { failed.push(name); }
    }
    if (failed.length > 0) {
        console.error(`${failed.length} of ${names.length} scenario(s) failed: ${failed.join('; ')}`);
        process.exitCode = 1;
    } else {
        console.log(`All ${names.length} scenario(s) landed where expected.`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
