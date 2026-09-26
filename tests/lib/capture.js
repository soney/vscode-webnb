/**
 * Renders every notebook the preview serves and captures each code cell's
 * output: visible text, feedback, console, the action strip, and structural
 * signals. The capture is normalized so a run is comparable across machines
 * and time.
 *
 * Shared by the golden-diff harness (tests/harness) and the workspace
 * verifier (scripts/verify-notebooks.js).
 *
 * There is one entry per code cell, in document order -- including a cell that
 * never rendered or whose render threw, so no cell drops out of the count.
 * Each entry:
 *
 *   language        the cell's language id
 *   hasSolution     the cell carries a +solution addon
 *   ranOnOpen       it had output before the capture pressed any Run button:
 *                   true for autorun/runonstart/hidecode cells and the
 *                   self-rendering widgets, so one that failed to autorun
 *                   shows up as false
 *   state           after every Run button was pressed: 'rendered',
 *                   'render-error' (render() threw; see renderError), or
 *                   'not-rendered' (the cell never produced output)
 *   renderError     the error line of a thrown render ('' otherwise); the
 *                   stack is dropped, since its URLs are machine-specific
 *   containerClass, output, feedback, feedbackClass, console
 *                   what the output pane shows. An MCQ's output leaves out its
 *                   option rows (they may shuffle); mcqOptions lists them sorted
 *   feedbackKinds   the categories among the feedback messages ('error',
 *                   'info', 'success'; a checklist counts by its outcome)
 *   uncaught        errors the cell's code threw asynchronously (timers,
 *                   listeners, rejected promises, React renders): the renderer
 *                   prints them in the cell's console pane as "Uncaught ..."
 *                   lines instead of letting them reach the page
 *   actions         the buttons in the strip under the output ("View solution",
 *                   "Reset code")
 *   solution        the text of the solution panel "View solution" reveals
 *   mcqOptions      an MCQ's option labels, sorted
 *   mcqCheck        an MCQ graded by the capture: "Show Answer" is pressed,
 *                   exactly the options it marks correct are selected, and
 *                   "Check Answer" is pressed. { correct, feedback,
 *                   feedbackKinds }; null for other cells and for MCQs without
 *                   a Show Answer button
 *   checklistItems, walkthroughSteps, terminalPresent
 *
 * Waiting is by condition, not by fixed sleeps: the preview marks a notebook
 * `data-state="ready"` once its autorun cells have started and a running cell
 * carries `is-running`. Each Run button waits for its cell to hold still for
 * CELL_QUIET_MS before the next is pressed, and after the last one the capture
 * waits until every output has held still for QUIET_MS (up to MAX_SETTLE_MS,
 * for pages that never do: clocks, animations). Every notebook starts from
 * empty localStorage, sessionStorage, and cookies, so its capture does not
 * depend on which notebooks ran before it (or on a --notebook filter).
 */
const { chromium } = require('playwright');

const LOAD_TIMEOUT_MS = 30000;
const RUN_TIMEOUT_MS = 10000;
// Before the next Run button, a cell's output must hold still this long, the
// way a learner finishes with one cell before running the next. Cells share
// the page (window.document.title, globals), so a +test checking a 50 ms
// timer would otherwise see the NEXT cell's writes. Bounded, for cells that
// never hold still.
const CELL_QUIET_MS = 300;
const CELL_SETTLE_MAX_MS = 1500;
// After the last Run button: long enough for the longer timers lessons use
// (a few are 1-1.5 s) to fire, and for an async error they throw to be seen.
const QUIET_MS = 2000;
const MAX_SETTLE_MS = 12000;
const POLL_MS = 100;

/** Volatile text that legitimately differs between runs. */
function normalize(text) {
    return (text || '')
        .replace(/Last checked [^·\n]+/g, 'Last checked <TIME>')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The error's own message from a `.webnb-render-error` box: its heading line
 * ("Renderer error:", "This output could not be displayed:", ...) and any
 * stack below the message are dropped.
 */
function renderErrorLine(text) {
    const lines = (text || '').split('\n').map(line => line.trim()).filter(Boolean);
    const body = lines.length > 1 && lines[0].endsWith(':') ? lines.slice(1) : lines;
    return body[0] || 'render error';
}

// ---- page-side helpers (serialized into the page; no outer references) ----

/** Per code cell: has it produced output (rendered or thrown) yet? */
function pageRenderedStates() {
    return Array.from(document.querySelectorAll('.cell-code')).map(cell => {
        const shadow = cell.querySelector('.cell-output')?.shadowRoot;
        return !!(shadow && (shadow.querySelector('#html-output') || shadow.querySelector('.webnb-render-error')));
    });
}

/** True once code cell `index` is not running and its output has not changed for `quietMs`. */
function pageCellQuiet({ index, quietMs }) {
    const cell = document.querySelectorAll('.cell-code')[index];
    if (!cell) {
        return true;
    }
    const root = cell.querySelector('.cell-output')?.shadowRoot?.querySelector('#root');
    const signature = root ? root.textContent.replace(/Last checked [0-9:.\s]+(?:[AaPp]\.?\s?[Mm]\.?)?/g, '') : '';
    const now = performance.now();
    const state = window.__webnbCellQuiet;
    if (!state || state.index !== index || state.signature !== signature) {
        window.__webnbCellQuiet = { index, signature, since: now };
        return false;
    }
    return now - state.since >= quietMs && !cell.classList.contains('is-running');
}

/**
 * True once no output has changed for `quietMs` and no cell is running. The
 * fingerprint is every output's text; a checklist's "Last checked <time>"
 * ticks on each refresh, so it is left out.
 */
function pageOutputsQuiet({ quietMs }) {
    const signature = Array.from(document.querySelectorAll('.cell-code')).map(cell => {
        const root = cell.querySelector('.cell-output')?.shadowRoot?.querySelector('#root');
        return root ? root.textContent.replace(/Last checked [0-9:.\s]+(?:[AaPp]\.?\s?[Mm]\.?)?/g, '') : '';
    }).join('\u0001');
    const now = performance.now();
    const state = window.__webnbQuiet;
    if (!state || state.signature !== signature) {
        window.__webnbQuiet = { signature, since: now };
        return false;
    }
    return now - state.since >= quietMs && !document.querySelector('.cell.is-running');
}

function pageCaptureCells() {
    const kindsOf = feedback => {
        const kinds = new Set();
        for (const child of feedback ? Array.from(feedback.children) : []) {
            for (const name of child.classList) {
                if (name === 'error' || name === 'info' || name === 'success') {
                    kinds.add(name);
                }
            }
        }
        return Array.from(kinds).sort();
    };

    return Array.from(document.querySelectorAll('.cell-code')).map(cell => {
        const shadow = cell.querySelector('.cell-output')?.shadowRoot;
        const find = selector => (shadow ? shadow.querySelector(selector) : null);
        const container = find('#html-output');
        const feedback = find('.feedback');
        const consoleEl = find('.console');
        const widgetHost = find('.widget-host');
        const renderError = find('.webnb-render-error');

        let output = container ? container.innerText : '';
        if (container && container.classList.contains('webnb-output-mcq')) {
            // Options may shuffle between renders; they are captured sorted in
            // mcqOptions, so the output keeps everything else, in order. The
            // rows are hidden just while innerText (which skips what is not
            // displayed) is read, however deep the markup nests them.
            const rows = Array.from(container.querySelectorAll('.mcq-option-row'));
            const displays = rows.map(row => row.style.display);
            rows.forEach(row => { row.style.display = 'none'; });
            output = container.innerText;
            rows.forEach((row, index) => { row.style.display = displays[index]; });
        }

        const solutionPanel = widgetHost ? widgetHost.querySelector('.webnb-solution-panel') : null;
        return {
            language: cell.dataset.language || '',
            hasSolution: cell.dataset.hasSolution === 'true',
            state: renderError ? 'render-error' : container ? 'rendered' : 'not-rendered',
            renderError: renderError ? renderError.textContent : '',
            containerClass: container ? container.className : '',
            output,
            feedback: feedback ? feedback.innerText : '',
            feedbackClass: feedback ? feedback.className : '',
            feedbackKinds: kindsOf(feedback),
            console: consoleEl ? consoleEl.innerText : '',
            uncaught: consoleEl ? Array.from(consoleEl.querySelectorAll('.console-uncaught')).map(line => line.innerText) : [],
            actions: widgetHost
                ? Array.from(widgetHost.querySelectorAll('.webnb-cell-action')).map(button => button.innerText)
                : [],
            solution: solutionPanel ? solutionPanel.textContent : '',
            mcqOptions: shadow ? Array.from(shadow.querySelectorAll('.mcq-option')).map(o => o.innerText).sort() : [],
            checklistItems: shadow ? Array.from(shadow.querySelectorAll('.checklist-item')).map(i => i.innerText) : [],
            walkthroughSteps: shadow ? shadow.querySelectorAll('.walkthrough-step').length : 0,
            terminalPresent: !!(shadow && shadow.querySelector('.webnb-terminal')),
        };
    });
}

/**
 * Grades each MCQ that offers "Show Answer" with exactly the options it marks
 * correct. Runs after the capture, so it cannot disturb the captured output.
 */
function pageCheckMcqs() {
    const results = {};
    document.querySelectorAll('.cell-code').forEach((cell, index) => {
        const shadow = cell.querySelector('.cell-output')?.shadowRoot;
        const form = shadow ? shadow.querySelector('.webnb-output-mcq .mcq-form') : null;
        const reveal = form ? form.querySelector('.mcq-reveal-button') : null;
        const check = form ? form.querySelector('.mcq-check-button') : null;
        if (!reveal || !check) {
            return;
        }
        reveal.click();
        const correct = [];
        for (const label of form.querySelectorAll('.mcq-option')) {
            const isCorrect = label.classList.contains('mcq-revealed-correct');
            const input = label.querySelector('input');
            if (input) {
                input.checked = isCorrect;
            }
            if (isCorrect) {
                correct.push(label.innerText);
            }
        }
        reveal.click();
        check.click();
        const feedback = shadow.querySelector('.feedback');
        const kinds = new Set();
        for (const child of feedback ? Array.from(feedback.children) : []) {
            for (const name of child.classList) {
                if (name === 'error' || name === 'info' || name === 'success') {
                    kinds.add(name);
                }
            }
        }
        results[index] = {
            correct,
            feedback: feedback ? feedback.innerText : '',
            feedbackKinds: Array.from(kinds).sort(),
        };
    });
    return results;
}

// ---- driver ----------------------------------------------------------------

/**
 * Resolves when the notebook view has built its cells and started its autorun
 * cells; false if it never got there.
 */
async function waitForNotebookReady(page) {
    // `.notebook-error` / `.empty-pane` also cover the app-level failures
    // (dev server unreachable, empty workspace) that never create a view.
    try {
        await page.waitForSelector(
            '.notebook[data-state="ready"], .notebook[data-state="error"], .notebook-error, .empty-pane',
            { state: 'attached', timeout: LOAD_TIMEOUT_MS }
        );
    } catch {
        return false;
    }
    await waitForNoRunningCells(page);
    return true;
}

async function waitForNoRunningCells(page) {
    await page.waitForFunction(() => !document.querySelector('.cell.is-running'), null, {
        polling: 25,
        timeout: RUN_TIMEOUT_MS,
    }).catch(() => { /* a stuck cell is captured as-is */ });
}

/** Presses one code cell's Run button and waits for that cell to settle (see CELL_QUIET_MS). */
async function runCell(page, index) {
    await page.evaluate(i => {
        window.__webnbCellQuiet = undefined;
        const button = document.querySelectorAll('.cell-code')[i]?.querySelector('button.cell-run');
        if (button) {
            // A DOM click cannot miss: a pointer click waits for the button to
            // stop moving, and outputs above it animating can keep it moving.
            button.scrollIntoView({ block: 'nearest' });
            button.click();
        }
    }, index);
    // A run still going when the settle window runs out gets the rest of
    // RUN_TIMEOUT_MS: the next cell must not start under a rendering one.
    await page.waitForFunction(pageCellQuiet, { index, quietMs: CELL_QUIET_MS }, { polling: 50, timeout: CELL_SETTLE_MAX_MS })
        .catch(() => page.waitForFunction(
            i => !document.querySelectorAll('.cell-code')[i]?.classList.contains('is-running'),
            index,
            { polling: 25, timeout: RUN_TIMEOUT_MS }
        ))
        .catch(() => { /* captured as-is */ });
}

async function waitForQuiet(page) {
    await page.evaluate(() => { window.__webnbQuiet = undefined; });
    await page.waitForFunction(pageOutputsQuiet, { quietMs: QUIET_MS }, { polling: POLL_MS, timeout: MAX_SETTLE_MS })
        .catch(() => { /* never held still: capture what is there */ });
}

/**
 * Captures every notebook at `baseUrl` (optionally only those whose path
 * contains `options.filter`; with `options.solutions`, through the preview's
 * `?solutions` mode, where runnable cells start from their +solution).
 * Returns:
 *   result             notebook path -> normalized cell captures (see above)
 *   pageErrors         every uncaught page error, in order
 *   pageErrorsByNotebook  the same errors keyed by the notebook being visited
 *   notebookErrors     notebook path -> load-failure banner text (parse errors)
 */
async function captureAll(baseUrl, options = {}) {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', err => pageErrors.push(err.message));

        const listing = await (await fetch(`${baseUrl}/__webnb/api/notebooks`)).json();
        let paths = listing.notebooks.map(n => n.path);
        if (options.filter) {
            paths = paths.filter(p => p.includes(options.filter));
        }
        const query = options.solutions ? '?solutions=1' : '';
        const result = {};
        const notebookErrors = {};
        const pageErrorsByNotebook = {};

        for (const notebookPath of paths) {
            const errorsBefore = pageErrors.length;
            // The app is an SPA: a hash-only navigation does not switch
            // notebooks, so bounce through about:blank.
            const notebookUrl = `${baseUrl}/${query}#${encodeURIComponent(notebookPath)}`;
            await page.goto('about:blank');
            await page.goto(notebookUrl);
            let ready = await waitForNotebookReady(page);
            if (!ready) {
                // One more try before calling it broken: a heavily loaded
                // machine can stall a page load past the timeout.
                await page.goto('about:blank');
                await page.goto(notebookUrl);
                ready = await waitForNotebookReady(page);
            }

            // A notebook that cannot load (parse error, unreadable file)
            // replaces the pane with a light-DOM banner instead of cells.
            const loadError = await page.evaluate(() => {
                const el = document.querySelector('.notebook-error');
                return el ? el.innerText : null;
            });
            if (loadError) {
                notebookErrors[notebookPath] = normalize(loadError);
            } else if (!ready) {
                const seen = await page.evaluate(() => {
                    const view = document.querySelector('.notebook');
                    return `page ${document.readyState}, notebook ${view ? `state=${view.dataset.state}` : 'view missing'}, ` +
                        `${document.querySelectorAll('.cell').length} cells, ` +
                        `${document.querySelectorAll('.cell.is-running').length} running`;
                }).catch(error => `page unresponsive: ${error.message}`);
                notebookErrors[notebookPath] = `did not finish loading within ${LOAD_TIMEOUT_MS / 1000}s, twice (${seen})`;
            }

            // Which cells rendered by themselves, before any Run button.
            const ranOnOpen = await page.evaluate(pageRenderedStates);

            const codeCellCount = ranOnOpen.length;
            for (let index = 0; index < codeCellCount; index++) {
                await runCell(page, index);
            }
            await waitForQuiet(page);

            const cells = await page.evaluate(pageCaptureCells);
            const mcqChecks = await page.evaluate(pageCheckMcqs);

            result[notebookPath] = cells.map((c, index) => {
                const check = mcqChecks[index];
                return {
                    language: c.language,
                    hasSolution: c.hasSolution,
                    ranOnOpen: !!ranOnOpen[index],
                    state: c.state,
                    renderError: c.state === 'render-error' ? renderErrorLine(c.renderError) : '',
                    containerClass: c.containerClass,
                    output: normalize(c.output),
                    feedback: normalize(c.feedback),
                    feedbackClass: c.feedbackClass,
                    feedbackKinds: c.feedbackKinds,
                    console: normalize(c.console),
                    uncaught: c.uncaught.map(normalize),
                    actions: c.actions.map(normalize),
                    solution: normalize(c.solution),
                    mcqOptions: c.mcqOptions.map(normalize),
                    mcqCheck: check
                        ? {
                            correct: check.correct.map(normalize).sort(),
                            feedback: normalize(check.feedback),
                            feedbackKinds: check.feedbackKinds,
                        }
                        : null,
                    checklistItems: c.checklistItems.map(normalize),
                    walkthroughSteps: c.walkthroughSteps,
                    terminalPresent: c.terminalPresent,
                };
            });

            const newErrors = pageErrors.slice(errorsBefore);
            if (newErrors.length > 0) {
                pageErrorsByNotebook[notebookPath] = newErrors;
            }

            // Every notebook starts from empty storage, as the first one does:
            // lessons read localStorage and cookies, and the preview writes
            // there (the MCQ answers graded above), so a notebook's capture
            // must not depend on which notebooks ran before it.
            await page.evaluate(() => {
                try {
                    localStorage.clear();
                    sessionStorage.clear();
                } catch { /* storage unavailable */ }
            }).catch(() => { /* page gone */ });
            await page.context().clearCookies();
        }

        return { result, pageErrors, pageErrorsByNotebook, notebookErrors };
    } finally {
        await browser.close();
    }
}

module.exports = { captureAll };
