/**
 * Renders every sample notebook in the preview harness and captures each
 * cell's output: visible text, feedback, console, and structural signals.
 * The capture is normalized so a run is comparable across machines and time.
 */
const { chromium } = require('playwright');

/** Volatile text that legitimately differs between runs. */
function normalize(text) {
    return (text || '')
        .replace(/Last checked [^·\n]+/g, 'Last checked <TIME>')
        .replace(/\s+/g, ' ')
        .trim();
}

async function captureAll(baseUrl) {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', err => pageErrors.push(err.message));

        const listing = await (await fetch(`${baseUrl}/__webnb/api/notebooks`)).json();
        const paths = listing.notebooks.map(n => n.path);
        const result = {};

        for (const notebookPath of paths) {
            // The app is an SPA: a hash-only navigation does not switch
            // notebooks, so bounce through about:blank.
            await page.goto('about:blank');
            await page.goto(`${baseUrl}/#${encodeURIComponent(notebookPath)}`);
            await page.waitForTimeout(3500);

            // Auto-widget cells run on open; the rest need their Run button.
            const runButtons = page.locator('button.cell-run');
            const count = await runButtons.count();
            for (let i = 0; i < count; i++) {
                try { await runButtons.nth(i).click({ timeout: 2000 }); } catch { /* detached */ }
                await page.waitForTimeout(300);
            }
            await page.waitForTimeout(3000);

            // Outputs render inside nested shadow DOM; walk it explicitly.
            const cells = await page.evaluate(() => {
                const results = [];
                const walk = (root) => {
                    for (const el of root.querySelectorAll('*')) {
                        if (el.shadowRoot) {
                            const sr = el.shadowRoot;
                            const container = sr.querySelector('#html-output');
                            const feedback = sr.querySelector('.feedback');
                            const consoleEl = sr.querySelector('.console');
                            if (container || feedback || consoleEl) {
                                results.push({
                                    containerClass: container ? container.className : '',
                                    output: container ? container.innerText : '',
                                    feedback: feedback ? feedback.innerText : '',
                                    feedbackClass: feedback ? feedback.className : '',
                                    console: consoleEl ? consoleEl.innerText : '',
                                    mcqOptions: Array.from(sr.querySelectorAll('.mcq-option')).map(o => o.innerText).sort(),
                                    checklistItems: Array.from(sr.querySelectorAll('.checklist-item')).map(i => i.innerText),
                                    walkthroughSteps: sr.querySelectorAll('.walkthrough-step').length,
                                    terminalPresent: !!sr.querySelector('.webnb-terminal'),
                                });
                            }
                            walk(sr);
                        }
                    }
                };
                walk(document);
                return results;
            });

            result[notebookPath] = cells.map(c => ({
                ...c,
                output: normalize(c.output),
                feedback: normalize(c.feedback),
                console: normalize(c.console),
                mcqOptions: c.mcqOptions.map(normalize),
                checklistItems: c.checklistItems.map(normalize),
            }));
        }

        return { result, pageErrors };
    } finally {
        await browser.close();
    }
}

module.exports = { captureAll };
