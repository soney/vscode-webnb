/**
 * Renderer regression test: renders every cell of the sample notebooks in the
 * preview harness (which hosts the extension's real render()) and compares
 * the normalized output against the committed goldens.
 *
 *   node tests/harness/run.js            compare against goldens (CI mode)
 *   node tests/harness/run.js --update   regenerate the goldens
 */
const fs = require('node:fs');
const path = require('node:path');
const { startPreview } = require('../lib/previewServer');
const { captureAll } = require('../lib/capture');
const { compareCaptures } = require('../lib/compare');

const PORT = Number(process.env.WEBNB_TEST_PORT || 5271);
const GOLDEN_PATH = path.join(__dirname, 'goldens', 'sample-notebooks.json');

async function main() {
    const update = process.argv.includes('--update');
    const server = await startPreview(PORT);
    try {
        const { result, pageErrors } = await captureAll(server.url);
        if (pageErrors.length > 0) {
            console.error('Page errors during capture:\n  ' + pageErrors.join('\n  '));
            process.exitCode = 1;
            return;
        }

        const totalCells = Object.values(result).reduce((n, cells) => n + cells.length, 0);
        if (totalCells === 0) {
            console.error('Captured 0 cells — the harness did not render anything.');
            process.exitCode = 1;
            return;
        }

        if (update) {
            fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
            fs.writeFileSync(GOLDEN_PATH, JSON.stringify(result, null, 2) + '\n');
            console.log(`Wrote goldens for ${totalCells} cells to ${path.relative(process.cwd(), GOLDEN_PATH)}`);
            return;
        }

        const expected = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
        const diffs = compareCaptures(expected, result);
        if (diffs.length > 0) {
            console.error(`Harness capture differs from goldens (${diffs.length} differences):\n\n` + diffs.join('\n\n'));
            console.error('\nIf the change is intentional, regenerate with: npm run test:harness:update');
            process.exitCode = 1;
            return;
        }
        console.log(`Harness OK: ${totalCells} cells match the goldens.`);
    } finally {
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
