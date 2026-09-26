#!/usr/bin/env node
/**
 * Verifies the .webnb notebooks of any workspace by rendering and running
 * every cell through the extension's real render() in the preview harness.
 *
 *   from a course repo:   node /path/to/vscode-webnb/scripts/verify-notebooks.js
 *   from this repo:       npm run verify:notebooks -- /path/to/course
 *
 * Passing means the workspace is structurally healthy: notebooks are found,
 * every one loads (no parse or load errors), every code cell renders (render()
 * neither throws nor leaves the cell without output), and nothing throws an
 * uncaught page error. Checks that ship unsatisfied on purpose -- exercise
 * checklists, tests the learner must make pass -- do NOT fail verification;
 * they are listed as warnings, as are errors a cell's code throws later (a
 * timer, a listener, a rejected promise), which the renderer shows in that
 * cell's console as "Uncaught ...". --strict-feedback promotes all of these
 * to failures.
 *
 * --solutions renders every HTML/CSS/JavaScript/Node/React cell with its
 * +solution in place of its source (the preview's ?solutions mode), and then
 * also fails on error feedback or an uncaught error from any cell that HAS a
 * +solution: the answer the notebook ships must pass its own checks. Cells
 * without a +solution are left as written and keep the usual rules, since some
 * are error demos on purpose.
 *
 * With --baseline the run is also compared cell-by-cell against a saved
 * capture, giving a course repo the same golden-diff regression workflow this
 * repo uses for its sample notebooks, with the baseline committed in the
 * course repo itself. (A --solutions run needs a baseline of its own.)
 *
 * Usage: verify-notebooks.js [workspace] [options]
 *   workspace              folder holding .webnb files (default: current dir)
 *   --notebook <substr>    only verify notebooks whose path contains substr
 *   --solutions            render cells from their +solution (see above)
 *   --baseline <file>      compare against a baseline capture (JSON)
 *   --update-baseline      write --baseline from this run instead of comparing
 *   --strict-feedback      fail when a cell reports error-category feedback
 *   --json <file>          also write this run's raw capture to a file
 *   --port <n>             preview port (default 5272)
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { startPreview } = require('../tests/lib/previewServer');
const { captureAll } = require('../tests/lib/capture');
const { compareCaptures } = require('../tests/lib/compare');

const DEFAULT_PORT = 5272;

function usageError(message) {
    console.error(`${message}\n\nRun with --help for usage.`);
    process.exit(2);
}

function firstLine(text, max = 120) {
    const line = (text || '').split('\n')[0];
    return line.length > max ? line.slice(0, max) + '...' : line;
}

async function main() {
    const { values, positionals } = parseArgs({
        options: {
            notebook: { type: 'string' },
            solutions: { type: 'boolean' },
            baseline: { type: 'string' },
            'update-baseline': { type: 'boolean' },
            'strict-feedback': { type: 'boolean' },
            json: { type: 'string' },
            port: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
    });

    if (values.help) {
        const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
        console.log(header.replace(/^#![^\n]*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
        return;
    }
    if (positionals.length > 1) {
        usageError(`Expected at most one workspace path, got: ${positionals.join(', ')}`);
    }
    if (values['update-baseline'] && !values.baseline) {
        usageError('--update-baseline needs --baseline <file> to know where to write.');
    }

    const workspace = path.resolve(positionals[0] ?? process.cwd());
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
        usageError(`Workspace is not a directory: ${workspace}`);
    }
    const port = Number(values.port || DEFAULT_PORT);
    if (!Number.isInteger(port) || port <= 0) {
        usageError(`Not a valid port: ${values.port}`);
    }

    const solutions = !!values.solutions;
    console.log(`Verifying notebooks in ${workspace}${solutions ? ' (cells rendered from their +solution)' : ''}`);
    const server = await startPreview(port, workspace);
    let capture;
    try {
        capture = await captureAll(server.url, { filter: values.notebook, solutions });
    } finally {
        await server.stop();
    }
    const { result, pageErrorsByNotebook, notebookErrors } = capture;

    const failures = [];
    const warnings = [];
    const notebookPaths = Object.keys(result);

    if (notebookPaths.length === 0) {
        failures.push(values.notebook
            ? `No .webnb notebooks matching "${values.notebook}" in ${workspace}`
            : `No .webnb notebooks found in ${workspace}`);
    }

    for (const notebookPath of notebookPaths) {
        const problems = [];
        if (notebookErrors[notebookPath]) {
            problems.push(`failed to load: ${firstLine(notebookErrors[notebookPath])}`);
        }
        for (const error of pageErrorsByNotebook[notebookPath] || []) {
            problems.push(`uncaught page error: ${firstLine(error)}`);
        }

        // Indexes count code cells only, in document order (the --json and
        // --baseline captures use the same numbering).
        result[notebookPath].forEach((cell, index) => {
            const where = `[${index}] (${cell.language})`;
            if (cell.state === 'render-error') {
                problems.push(`${where} render error: ${firstLine(cell.renderError)}`);
            } else if (cell.state === 'not-rendered') {
                problems.push(`${where} never rendered`);
            }
            // Error feedback, and errors the cell's code threw asynchronously
            // (shown in its console as "Uncaught ..."), are what the learner
            // sees go wrong: warnings, since lessons demonstrate errors on
            // purpose -- except from a +solution in --solutions mode.
            const complaints = [];
            if ((cell.feedbackKinds || []).includes('error')) {
                complaints.push({ kind: 'error feedback', text: cell.feedback });
            }
            for (const line of cell.uncaught || []) {
                complaints.push({ kind: 'uncaught error', text: line });
            }
            for (const { kind, text } of complaints) {
                const fromSolution = solutions && cell.hasSolution;
                if (fromSolution || values['strict-feedback']) {
                    problems.push(`${where} ${kind}${fromSolution ? ' from its +solution' : ''}: "${firstLine(text)}"`);
                } else {
                    warnings.push(`${notebookPath}${where}: ${kind}: "${firstLine(text)}"`);
                }
            }
        });
        problems.forEach(problem => failures.push(problem.startsWith('[')
            ? `${notebookPath}${problem}`
            : `${notebookPath}: ${problem}`));

        const status = problems.length > 0 ? 'FAIL' : 'ok  ';
        console.log(`  ${status} ${notebookPath} (${result[notebookPath].length} code cells)`);
    }

    if (values.json) {
        const jsonPath = path.resolve(values.json);
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
        console.log(`Capture written to ${jsonPath}`);
    }

    if (values.baseline) {
        const baselinePath = path.resolve(values.baseline);
        if (values['update-baseline']) {
            fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
            fs.writeFileSync(baselinePath, JSON.stringify(result, null, 2) + '\n');
            console.log(`Baseline written to ${baselinePath}`);
        } else if (!fs.existsSync(baselinePath)) {
            failures.push(`Baseline not found: ${baselinePath} (create it with --update-baseline)`);
        } else {
            const expected = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
            const diffs = compareCaptures(expected, result);
            diffs.forEach(diff => failures.push(`baseline: ${diff}`));
            if (diffs.length === 0) {
                console.log('Baseline matches.');
            } else {
                console.log('If the change is intentional, refresh with --update-baseline.');
            }
        }
    }

    if (warnings.length > 0) {
        console.log(`\nWarnings (not failures; --strict-feedback promotes them):\n  ` + warnings.join('\n  '));
    }

    const totalCells = Object.values(result).reduce((n, cells) => n + cells.length, 0);
    if (failures.length > 0) {
        console.error(`\nFAIL: ${failures.length} problem(s) across ${notebookPaths.length} notebook(s):\n  ` + failures.join('\n  '));
        process.exitCode = 1;
        return;
    }
    console.log(`\nOK: ${notebookPaths.length} notebook(s), ${totalCells} code cells rendered, no problems.`);
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
