/**
 * In-browser unit tests for lite-cy (the grading engine behind assert/wrap):
 * it needs a real DOM and getComputedStyle, so the specs run inside Chromium.
 * The module is imported through the vite dev server's /@fs/ endpoint, which
 * transpiles the TypeScript source on the fly — no separate build step.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { startPreview } = require('../lib/previewServer');

const PORT = Number(process.env.WEBNB_TEST_PORT || 5272);

async function main() {
    const server = await startPreview(PORT);
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        page.on('pageerror', err => console.error('PAGEERROR:', err.message));
        await page.goto(server.url);

        const modulePath = path.join(server.repoRoot, 'src', 'client', 'lite-cy.ts');
        const results = await page.evaluate(async (moduleFsPath) => {
            const module = await import(/* @vite-ignore */ `/@fs/${moduleFsPath}`);
            const cy = module.default;

            const results = [];
            /** Runs one spec; `reports` collects every onResult call it makes. */
            const spec = (name, fn) => {
                const reports = [];
                const onResult = (passed, message, trace) => reports.push({ passed, message, trace });
                const host = document.createElement('div');
                document.body.appendChild(host);
                try {
                    fn(host, onResult, reports);
                    results.push({ name, ok: true });
                } catch (error) {
                    results.push({ name, ok: false, error: String(error) });
                } finally {
                    host.remove();
                }
            };
            const expect = (condition, detail) => {
                if (!condition) { throw new Error(`expectation failed: ${detail}`); }
            };

            spec('get + should(exist) passes and reports through run()', (host, onResult, reports) => {
                host.innerHTML = '<h1>Hi</h1>';
                cy(host, onResult).get('h1').should('exist').run('fail', 'ok');
                expect(reports.length === 1 && reports[0].passed && reports[0].message === 'ok', JSON.stringify(reports));
            });

            spec('should(not.exist) passes vacuously when nothing matches', (host, onResult, reports) => {
                cy(host, onResult).get('h2').should('not.exist').run('fail', 'ok');
                expect(reports[0].passed, JSON.stringify(reports));
            });

            spec('have.text failure reports the mismatch and run() uses failMessage', (host, onResult, reports) => {
                host.innerHTML = '<p>actual</p>';
                cy(host, onResult).get('p').should('have.text', 'expected').run('custom fail', 'ok');
                expect(reports[0].passed === false && reports[0].message === 'custom fail', JSON.stringify(reports));
                expect(reports[0].trace[0].includes('Expected text "expected", got "actual"'), JSON.stringify(reports[0].trace));
            });

            spec('have.css matches computed style', (host, onResult, reports) => {
                host.innerHTML = '<div style="color: red">x</div>';
                cy(host, onResult).get('div').should('have.css', 'color: red').run('fail', 'ok');
                expect(reports[0].passed, JSON.stringify(reports));
            });

            spec('have.css mismatch fails', (host, onResult, reports) => {
                host.innerHTML = '<div style="color: red">x</div>';
                cy(host, onResult).get('div').should('have.css', 'color: blue').run('fail', 'ok');
                expect(reports[0].passed === false, JSON.stringify(reports));
            });

            spec('wrap + equal deep-compares objects', (host, onResult, reports) => {
                cy.wrap({ name: 'Ada', tags: ['a'] }, onResult).should('equal', { name: 'Ada', tags: ['a'] }).run('fail', 'ok');
                expect(reports[0].passed, JSON.stringify(reports));
            });

            spec('wrap + have.property with value', (host, onResult, reports) => {
                cy.wrap({ count: 3 }, onResult).should('have.property', 'count', 3).run('fail', 'ok');
                expect(reports[0].passed, JSON.stringify(reports));
            });

            spec('wrap + be.an(array) distinguishes arrays from objects', (host, onResult, reports) => {
                cy.wrap([], onResult).should('be.an', 'array').run('fail', 'ok');
                cy.wrap({}, onResult).should('be.an', 'array').run('fail', 'ok');
                expect(reports[0].passed === true && reports[1].passed === false, JSON.stringify(reports));
            });

            spec('sourceOnly elements are ignored by negated assertions', (host, onResult, reports) => {
                const el = document.createElement('div');
                el.className = 'present';
                cy([el], onResult, { sourceOnly: true }).should('not.have.class', 'present').run('fail', 'ok');
                expect(reports[0].passed, 'sourceOnly negation should hold vacuously: ' + JSON.stringify(reports));
            });

            spec('not.have.class fails when any element has the class', (host, onResult, reports) => {
                host.innerHTML = '<div class="a"></div><div></div>';
                cy(host, onResult).get('div').should('not.have.class', 'a').run('fail', 'ok');
                expect(reports[0].passed === false, JSON.stringify(reports));
            });

            spec('contains() threads onResult through the chain', (host, onResult, reports) => {
                host.innerHTML = '<span>needle in here</span>';
                cy(host, onResult).contains('needle').should('exist').run('fail', 'found it');
                expect(reports.length === 1 && reports[0].passed && reports[0].message === 'found it', JSON.stringify(reports));
            });

            spec('have.length counts matched elements', (host, onResult, reports) => {
                host.innerHTML = '<li></li><li></li>';
                cy(host, onResult).get('li').should('have.length', 2).run('fail', 'ok');
                expect(reports[0].passed, JSON.stringify(reports));
            });

            spec('getRule finds a stylesheet rule and checks its css', (host, onResult, reports) => {
                const style = document.createElement('style');
                style.textContent = '.webnb-test-rule { color: red; }';
                document.head.appendChild(style);
                try {
                    cy.getRule('.webnb-test-rule', onResult).should('have.css', 'color: red').run('fail', 'ok');
                    expect(reports[0].passed, JSON.stringify(reports));
                } finally {
                    style.remove();
                }
            });

            spec('click() dispatches and later assertions see the result', (host, onResult, reports) => {
                host.innerHTML = '<button id="b">go</button><p id="out"></p>';
                host.querySelector('#b').addEventListener('click', () => {
                    host.querySelector('#out').textContent = 'clicked';
                });
                cy(host, onResult).get('#b').click().run('fail', 'clicked ok');
                cy(host, onResult).get('#out').should('have.text', 'clicked').run('fail', 'ok');
                expect(reports.every(r => r.passed), JSON.stringify(reports));
            });

            return results;
        }, modulePath);

        const failed = results.filter(r => !r.ok);
        for (const r of results) {
            console.log(`${r.ok ? 'ok' : 'FAIL'} - ${r.name}${r.error ? `\n      ${r.error}` : ''}`);
        }
        console.log(`\n${results.length - failed.length}/${results.length} lite-cy specs passed`);
        if (failed.length > 0 || results.length === 0) {
            process.exitCode = 1;
        }
    } finally {
        await browser.close();
        await server.stop();
    }
}

main().then(
    // The vite child's pipes or lingering sockets can keep the event loop
    // alive after all work is done; exit explicitly with the recorded code.
    () => process.exit(process.exitCode ?? 0),
    error => {
        console.error(error);
        process.exit(1);
    }
);
