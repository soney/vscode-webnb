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
            /**
             * Runs one spec; `reports` collects every onResult call it makes.
             * `host` sits inside a shadow root, as a cell's output does in the
             * real renderer, so a query that escapes to the page document
             * shows up as a failure here too.
             */
            const spec = (name, fn) => {
                const reports = [];
                const onResult = (passed, message, trace) => reports.push({ passed, message, trace });
                const shadowHost = document.createElement('div');
                document.body.appendChild(shadowHost);
                const host = document.createElement('div');
                shadowHost.attachShadow({ mode: 'open' }).appendChild(host);
                try {
                    fn(host, onResult, reports);
                    results.push({ name, ok: true });
                } catch (error) {
                    results.push({ name, ok: false, error: String(error) });
                } finally {
                    shadowHost.remove();
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
                expect(reports[0].trace[0].includes('Expected text `expected`, got `actual`'), JSON.stringify(reports[0].trace));
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

            spec('getRule with explicit sheets ignores every other stylesheet', (host, onResult, reports) => {
                const outside = document.createElement('style');
                outside.textContent = '.box { color: red; }';
                document.head.appendChild(outside);
                const inside = document.createElement('style');
                inside.textContent = '.box { color: blue; }';
                host.getRootNode().appendChild(inside);
                try {
                    cy.getRule('.box', onResult, [inside.sheet]).should('have.css', 'color: blue').run('fail', 'ok');
                    expect(reports[0].passed, JSON.stringify(reports));
                } finally {
                    outside.remove();
                }
            });

            spec('getRule merges rules for one selector, later ones winning', (host, onResult, reports) => {
                const style = document.createElement('style');
                style.textContent = '.m { color: red; animation-name: fade; } .m { color: blue; }';
                host.getRootNode().appendChild(style);
                cy.getRule('.m', onResult, [style.sheet]).should('have.css', 'color: blue').run('fail', 'ok');
                cy.getRule('.m', onResult, [style.sheet]).should('have.css', 'animation-name: fade').run('fail', 'ok');
                expect(reports.every(r => r.passed), JSON.stringify(reports));
            });

            spec('an unknown assertion fails instead of passing', (host, onResult, reports) => {
                host.innerHTML = '<input value="x">';
                cy(host, onResult).get('input').should('be.tru').run('fail', 'ok');
                cy.wrap(1, onResult).should('have.valu', 1).run('fail', 'ok');
                expect(reports.every(r => !r.passed), JSON.stringify(reports));
                expect(reports[0].trace.join(' ').includes('Unknown assertion'), JSON.stringify(reports[0].trace));
            });

            spec('wrap(element) takes element assertions', (host, onResult, reports) => {
                host.innerHTML = '<p class="a">Hi</p>';
                const p = host.querySelector('p');
                cy.wrap(p, onResult).should('have.text', 'Hi').run('fail', 'ok');
                cy.wrap(p, onResult).should('have.text', 'Nope').run('fail', 'ok');
                cy.wrap(p, onResult).should('have.class', 'a').run('fail', 'ok');
                expect(reports[0].passed && !reports[1].passed && reports[2].passed, JSON.stringify(reports));
            });

            spec('an element assertion on a plain value fails', (host, onResult, reports) => {
                cy.wrap('Hi', onResult).should('have.text', 'Hi').run('fail', 'ok');
                expect(!reports[0].passed, JSON.stringify(reports));
            });

            spec('a value assertion on elements fails', (host, onResult, reports) => {
                host.innerHTML = '<p>1</p>';
                cy(host, onResult).get('p').should('equal', 1).run('fail', 'ok');
                expect(!reports[0].passed, JSON.stringify(reports));
            });

            spec('click() on nothing fails the chain', (host, onResult, reports) => {
                cy(host, onResult).get('#missing').click().run('fail', 'ok');
                expect(!reports[0].passed, JSON.stringify(reports));
                expect(reports[0].trace.join(' ').includes('nothing matched'), JSON.stringify(reports[0].trace));
            });

            spec('a selection with no assertion requires a match', (host, onResult, reports) => {
                host.innerHTML = '<p>here</p>';
                cy(host, onResult).get('p').run('fail', 'ok');
                cy(host, onResult).get('h1').run('fail', 'ok');
                expect(reports[0].passed && !reports[1].passed, JSON.stringify(reports));
            });

            spec('have.text compares text as a reader sees it', (host, onResult, reports) => {
                host.innerHTML = '<ul><li>\n    Apples\n  </li></ul>';
                cy(host, onResult).get('li').should('have.text', 'Apples').run('fail', 'ok');
                cy(host, onResult).get('li').should('have.text', 'apples').run('fail', 'ok');
                expect(reports[0].passed && !reports[1].passed, JSON.stringify(reports));
            });

            spec('SVG elements take attr and class assertions', (host, onResult, reports) => {
                host.innerHTML = '<svg><rect class="r" x="20"></rect></svg>';
                cy(host, onResult).get('rect').should('have.attr', 'x', '20').run('fail', 'ok');
                cy(host, onResult).get('rect').should('have.class', 'r').run('fail', 'ok');
                cy(host, onResult).get('rect').should('have.attr', 'x', '5').run('fail', 'ok');
                expect(reports[0].passed && reports[1].passed && !reports[2].passed, JSON.stringify(reports));
            });

            spec('contains() looks only inside the chain and yields the deepest match', (host, onResult, reports) => {
                host.innerHTML = '<div><p>needle</p></div>';
                const chain = cy(host, onResult).contains('needle');
                expect(chain.elements.length === 1 && chain.elements[0].tagName === 'P', chain.elements.map(e => e.tagName).join());
                cy(host, onResult).get('div').contains('haystack').should('exist').run('fail', 'ok');
                expect(!reports[0].passed, JSON.stringify(reports));
            });

            spec('type() goes through the value setter and fires input', (host, onResult, reports) => {
                host.innerHTML = '<input>';
                const input = host.querySelector('input');
                let seen = '';
                input.addEventListener('input', () => { seen = input.value; });
                cy(host, onResult).get('input').type('hello').should('have.value', 'hello').run('fail', 'ok');
                expect(reports[0].passed && seen === 'hello', JSON.stringify(reports) + ' seen=' + seen);
            });

            spec('be.a function accepts async functions', (host, onResult, reports) => {
                cy.wrap(async () => 1, onResult).should('be.a', 'function').run('fail', 'ok');
                expect(reports[0].passed, JSON.stringify(reports));
            });

            spec('include checks strings and arrays', (host, onResult, reports) => {
                cy.wrap('hello world', onResult).should('include', 'world').run('fail', 'ok');
                cy.wrap([1, { a: 2 }], onResult).should('include', { a: 2 }).run('fail', 'ok');
                cy.wrap([1, 2], onResult).should('include', 3).run('fail', 'ok');
                expect(reports[0].passed && reports[1].passed && !reports[2].passed, JSON.stringify(reports));
            });

            spec('afterAction runs after each action', (host, onResult, reports) => {
                host.innerHTML = '<button>b</button>';
                let flushed = 0;
                cy(host, onResult, { afterAction: () => { flushed++; } }).get('button').click().run('fail', 'ok');
                expect(flushed === 1 && reports[0].passed, 'flushed=' + flushed);
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
