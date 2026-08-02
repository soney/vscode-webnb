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

const SCENARIOS = [
    'The whole notebook',
    'A section of it',
    'A section, spelled out',
    'From the workspace root',
    'A notebook in a subfolder, with spaces in its name',
    'Down to the last section',
    'A notebook that does not exist',
    'A section that does not exist',
    'A source file',
];

async function runScenario(name) {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        if (!await waitForNotebook(page)) { return `${name}: NOTEBOOK NEVER RENDERED`; }
        await sleep(6000);

        if (process.env.WEBNB_RUN_ALL) { await runAllCells(page); }
        const href = await clickLink(page, name);
        await sleep(7000);
        const after = await observe(page);
        const shot = path.join(SHOTS, `${name.replace(/[^a-z0-9]+/gi, '-')}.png`);
        await page.screenshot({ path: shot });

        const activeTab = after.tabs.find(t => t.active)?.label;
        const topHeading = after.headings[0]?.heading;
        const warnings = after.warnings.filter(w => !w.includes('proposed API'));
        return [
            `${name}  (href=${href})`,
            `   tab       : ${activeTab}   [${after.tabs.map(t => t.label).join(', ')}]`,
            `   at top    : ${topHeading ?? '(no heading in view)'}`,
            `   warnings  : ${warnings.length ? JSON.stringify(warnings) : 'none'}`,
            `   revealed  : ${after.breadcrumb.join(' > ') || '(no breadcrumb)'}  ${after.cellStatus}`,
            `   screenshot: ${shot}`,
        ].join('\n');
    } finally {
        await browser.close();
    }
}

async function main() {
    fs.mkdirSync(SHOTS, { recursive: true });
    const only = process.argv[2];
    for (const name of only ? [only] : SCENARIOS) {
        console.log(await runScenario(name));
        console.log('');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
