#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const webpack = require('webpack');
const { open, runTests } = require('@vscode/test-web');

const DEFAULT_WORKSPACE = 'samplenotebooks';
const TEST_RUNNER_DIR = '.vscode-test-web';
const TEST_RUNNER_FILE = 'open-file-runner.js';
const RELOAD_SIGNAL_DIR = '.vscode-test-web';
const RELOAD_SIGNAL_FILE = 'reload-signal.json';
const RELOAD_SIGNAL_POLL_MS = 500;
const REOPEN_FILE_DELAY_MS = 1000;
const WATCH_DEBOUNCE_MS = 300;
const DEFAULT_WATCH_PATHS = ['out', 'package.json'];
const WEBPACK_INPUT_PATHS = [
    'src/**/*',
    'icons/**/*',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'webpack.config.js',
];
const IGNORED_WATCH_PATHS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/.vscode-test/**',
    '**/.vscode-test-web/**',
    '**/out/**',
];

function printHelp() {
    console.log(`Usage:
  node scripts/vscode-test-web.js [file] [options]

Options:
  --file <path>       File to open after VS Code Web starts.
  --workspace <path>  Local folder to mount as the VS Code Web workspace.
                      Defaults to ${DEFAULT_WORKSPACE}.
  --browser <name>    Browser to launch: chromium, firefox, webkit, or none.
                      Defaults to chromium.
  --port <number>     Server port. Defaults to 3000.
  --host <name>       Server host. Defaults to localhost.
  --headless          Launch the browser headlessly.
  --devtools          Open browser devtools.
  --quality <name>    VS Code quality: insiders or stable.
  --verbose           Print extra server/browser logging.
  --watch             Watch source files, rebuild with webpack, then reload
                      VS Code Web when compiled extension output changes.
  --no-keep-open      Exit after the file is opened. By default, file-open mode
                      keeps the VS Code Web session alive for manual testing.
  --help              Show this help.

Examples:
  node scripts/vscode-test-web.js
  node scripts/vscode-test-web.js sample.webnb
  node scripts/vscode-test-web.js samplenotebooks/sample.webnb
  node scripts/vscode-test-web.js samplenotebooks/sample.webnb --watch
  node scripts/vscode-test-web.js --workspace . samplenotebooks/sample.webnb
`);
}

function parseArgs(argv) {
    const options = {
        workspace: DEFAULT_WORKSPACE,
        browser: 'chromium',
        keepOpen: true,
    };
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--file') {
            options.file = argv[++i];
        } else if (arg === '--workspace' || arg === '--folder') {
            options.workspace = argv[++i];
        } else if (arg === '--browser' || arg === '--browserType') {
            options.browser = argv[++i];
        } else if (arg === '--port') {
            options.port = Number(argv[++i]);
        } else if (arg === '--host') {
            options.host = argv[++i];
        } else if (arg === '--headless') {
            options.headless = true;
        } else if (arg === '--devtools' || arg === '--open-devtools') {
            options.devTools = true;
        } else if (arg === '--quality') {
            options.quality = argv[++i];
        } else if (arg === '--verbose') {
            options.verbose = true;
        } else if (arg === '--watch') {
            options.watch = true;
        } else if (arg === '--no-keep-open') {
            options.keepOpen = false;
        } else if (arg.startsWith('--')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            positional.push(arg);
        }
    }

    if (!options.file && positional.length > 0) {
        options.file = positional[0];
    }

    return options;
}

function assertOptionValue(name, value) {
    if (value === undefined || value === '') {
        throw new Error(`${name} needs a value.`);
    }
}

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

function isSubPath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWorkspace(workspace) {
    assertOptionValue('--workspace', workspace);
    return path.resolve(process.cwd(), workspace);
}

function resolveFileInWorkspace(file, workspacePath) {
    assertOptionValue('--file', file);

    const candidates = [];
    if (path.isAbsolute(file)) {
        candidates.push(file);
    } else {
        candidates.push(path.resolve(workspacePath, file));
        candidates.push(path.resolve(process.cwd(), file));
    }

    const filePath = candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
    if (!isSubPath(workspacePath, filePath)) {
        throw new Error(`File "${file}" must be inside the mounted workspace "${workspacePath}".`);
    }

    const relativePath = toPosixPath(path.relative(workspacePath, filePath));
    if (!relativePath || relativePath.startsWith('..')) {
        throw new Error(`Could not resolve "${file}" inside "${workspacePath}".`);
    }

    return {
        filePath,
        workspaceUriPath: `/${relativePath}`
    };
}

function reloadSignalStaticPath() {
    return `/static/devextensions/${RELOAD_SIGNAL_DIR}/${RELOAD_SIGNAL_FILE}`;
}

function reloadSignalUrl(options) {
    const host = options.host && options.host !== '0.0.0.0' && options.host !== '::'
        ? options.host
        : 'localhost';
    const port = options.port ?? 3000;
    return `http://${host}:${port}${reloadSignalStaticPath()}`;
}

function createOpenFileRunner({ workspaceUriPath, keepOpen, watch, reloadSignalUrl }) {
    const runnerDir = path.resolve(process.cwd(), TEST_RUNNER_DIR);
    fs.mkdirSync(runnerDir, { recursive: true });

    const runnerPath = path.join(runnerDir, TEST_RUNNER_FILE);
const source = `const vscode = require('vscode');

const reloadSignalUrl = ${JSON.stringify(reloadSignalUrl)};
const targetUri = ${workspaceUriPath ? `vscode.Uri.from({
    scheme: 'vscode-test-web',
    authority: 'mount',
    path: ${JSON.stringify(workspaceUriPath)}
})` : 'undefined'};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}

async function readReloadSignal() {
    try {
        const response = await fetch(reloadSignalUrl + '?t=' + Date.now(), { cache: 'no-store' });
        if (!response.ok) {
            console.log('[webnb-watch] Reload signal is not ready: HTTP ' + response.status);
            return undefined;
        }
        return (await response.text()).trim();
    } catch (error) {
        console.log('[webnb-watch] Could not read reload signal: ' + formatError(error));
        return undefined;
    }
}

async function openTargetFile(reason) {
    if (!targetUri) {
        return;
    }

    try {
        await vscode.commands.executeCommand('vscode.openWith', targetUri, 'web-notebook');
        console.log('[webnb-watch] Opened ' + targetUri.toString() + (reason ? ' (' + reason + ')' : ''));
    } catch (error) {
        console.error('[webnb-watch] Could not open ' + targetUri.toString() + ': ' + formatError(error));
    }
}

async function watchForReloads(initialSignal) {
    let lastSignal = initialSignal;

    while (true) {
        await delay(${RELOAD_SIGNAL_POLL_MS});
        const nextSignal = await readReloadSignal();

        if (nextSignal && nextSignal !== lastSignal) {
            lastSignal = nextSignal;
            console.log('[webnb-watch] Reloading VS Code Web after extension changes: ' + nextSignal);
            await openTargetFile('before reload');

            try {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            } catch (error) {
                console.error('[webnb-watch] Reload command failed: ' + formatError(error));
            }

            await delay(${REOPEN_FILE_DELAY_MS});
            await openTargetFile('after reload');
        }
    }
}

async function run() {
    await openTargetFile('initial');

    ${watch ? `console.log('[webnb-watch] Watching reload signal at ' + reloadSignalUrl);
    const initialSignal = await readReloadSignal();
    await watchForReloads(initialSignal);` : ''}

    ${keepOpen || watch ? 'await new Promise(() => {});' : ''}
}

exports.run = run;
`;

    fs.writeFileSync(runnerPath, source);
    return runnerPath;
}

function reloadSignalPath() {
    return path.resolve(process.cwd(), RELOAD_SIGNAL_DIR, RELOAD_SIGNAL_FILE);
}

function writeReloadSignal(reason) {
    const signalPath = reloadSignalPath();
    fs.mkdirSync(path.dirname(signalPath), { recursive: true });

    const payload = {
        version: Date.now(),
        reason: reason ? toPosixPath(path.relative(process.cwd(), reason)) : 'initial',
    };

    fs.writeFileSync(signalPath, `${JSON.stringify(payload)}\n`);
}

function relativeLabel(filePath) {
    return toPosixPath(path.relative(process.cwd(), filePath)) || filePath;
}

function loadWebpackConfig() {
    const configPath = path.resolve(process.cwd(), 'webpack.config.js');
    const config = require(configPath);
    const resolvedConfig = typeof config === 'function'
        ? config({}, { mode: 'development' })
        : config;
    const configs = Array.isArray(resolvedConfig) ? resolvedConfig : [resolvedConfig];

    return configs.map(item => ({
        ...item,
        plugins: (item.plugins ?? []).filter(plugin => plugin?.constructor?.name !== 'ForkTsCheckerWebpackPlugin'),
    }));
}

function formatWebpackStats(stats) {
    return stats.toString({
        colors: !!process.stdout.isTTY,
        preset: 'errors-warnings',
    }).trim();
}

function runWebpackBuild(reason) {
    const compiler = webpack(loadWebpackConfig());

    if (reason) {
        console.log(`[webpack] Building after change in ${relativeLabel(reason)}.`);
    } else {
        console.log('[webpack] Building extension bundles.');
    }

    return new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            const finish = buildError => {
                compiler.close(closeError => {
                    reject(buildError ?? closeError);
                });
            };

            if (error) {
                console.error('[webpack] Fatal build error.');
                console.error(error);
                finish(error);
                return;
            }

            if (stats) {
                const output = formatWebpackStats(stats);
                if (output) {
                    console.log(output);
                }

                if (stats.hasErrors()) {
                    finish(new Error('Webpack build failed.'));
                    return;
                }
            }

            console.log(`[webpack] compiled successfully at ${new Date().toLocaleTimeString()}.`);
            compiler.close(closeError => {
                if (closeError) {
                    reject(closeError);
                } else {
                    resolve();
                }
            });
        });
    });
}

function startWebpackWatcher() {
    let readyResolved = false;
    let resolveReady;
    let rejectReady;
    let closed = false;
    let building = false;
    let queuedReason;

    const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    async function build(reason) {
        if (closed) {
            return;
        }

        if (building) {
            queuedReason = reason;
            return;
        }

        building = true;

        try {
            let nextReason = reason;

            do {
                queuedReason = undefined;
                await runWebpackBuild(nextReason);

                if (!readyResolved) {
                    readyResolved = true;
                    resolveReady();
                }

                nextReason = queuedReason;
            } while (nextReason && !closed);
        } catch (error) {
            if (!readyResolved) {
                rejectReady(error);
            } else {
                console.error(error instanceof Error ? error.message : error);
            }
        } finally {
            building = false;
        }
    }

    const watcher = chokidar.watch(WEBPACK_INPUT_PATHS, {
        cwd: process.cwd(),
        ignored: IGNORED_WATCH_PATHS,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 150,
            pollInterval: 50,
        },
    });

    watcher.on('all', (_event, changedPath) => {
        build(path.resolve(process.cwd(), changedPath));
    });

    watcher.on('error', error => {
        console.warn(`Webpack source watch error: ${error.message}`);
    });

    console.log(`Watching webpack inputs in ${WEBPACK_INPUT_PATHS.join(', ')}`);
    build();

    return {
        ready,
        async close() {
            closed = true;
            await watcher.close();
        }
    };
}

function startExtensionWatcher(signalUrl) {
    let debounceTimer;

    writeReloadSignal();

    function queueReload(changedPath) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            writeReloadSignal(changedPath);
            console.log(`Change detected in ${relativeLabel(changedPath)}; reloading VS Code Web.`);
        }, WATCH_DEBOUNCE_MS);
    }

    const watcher = chokidar.watch(DEFAULT_WATCH_PATHS, {
        cwd: process.cwd(),
        ignored: IGNORED_WATCH_PATHS,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 150,
            pollInterval: 50,
        },
    });

    watcher.on('all', (_event, changedPath) => {
        queueReload(path.resolve(process.cwd(), changedPath));
    });

    watcher.on('error', error => {
        console.warn(`Watch error: ${error.message}`);
    });

    console.log(`Watching for extension changes in ${DEFAULT_WATCH_PATHS.join(', ')}`);
    console.log(`Reload signal is served from ${signalUrl}`);

    return {
        close() {
            clearTimeout(debounceTimer);
            return watcher.close();
        }
    };
}

async function closeAll(disposables) {
    await Promise.all(disposables.map(disposable => disposable.close()));
}

function createSessionRunner({ workspaceUriPath, keepOpen, watch, reloadSignalUrl }) {
    return createOpenFileRunner({
        workspaceUriPath,
        keepOpen: keepOpen || watch,
        watch,
        reloadSignalUrl
    });
}

function baseOptions(options, workspacePath) {
    return {
        browserType: options.browser,
        extensionDevelopmentPath: process.cwd(),
        folderPath: workspacePath,
        headless: !!options.headless,
        devTools: !!options.devTools,
        quality: options.quality,
        verbose: !!options.verbose,
        host: options.host,
        port: options.port,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    const workspacePath = resolveWorkspace(options.workspace);
    if (!fs.existsSync(workspacePath)) {
        throw new Error(`Workspace folder does not exist: ${workspacePath}`);
    }

    if (options.watch && options.browser === 'none') {
        throw new Error('--watch needs a browser session; --browser none cannot reload VS Code Web.');
    }

    if (!options.file && !options.watch) {
        console.log(`Opening VS Code Web on ${workspacePath}`);
        const disposable = await open(baseOptions(options, workspacePath));
        process.once('SIGINT', () => {
            disposable.dispose();
            process.exit(0);
        });
        return;
    }

    const disposables = [];

    if (options.watch) {
        const webpackWatcher = startWebpackWatcher();
        disposables.push(webpackWatcher);
        try {
            await webpackWatcher.ready;
        } catch (error) {
            await closeAll(disposables);
            throw error;
        }
    }

    const signalUrl = reloadSignalUrl(options);
    const resolvedFile = options.file ? resolveFileInWorkspace(options.file, workspacePath) : undefined;
    const runnerPath = createSessionRunner({
        workspaceUriPath: resolvedFile?.workspaceUriPath,
        keepOpen: options.keepOpen,
        watch: !!options.watch,
        reloadSignalUrl: signalUrl
    });

    if (options.watch) {
        disposables.push(startExtensionWatcher(signalUrl));
    }

    process.once('SIGINT', async () => {
        await closeAll(disposables);
        process.exit(0);
    });

    console.log(`Opening VS Code Web on ${workspacePath}`);
    if (resolvedFile) {
        console.log(`Opening file vscode-test-web://mount${resolvedFile.workspaceUriPath}`);
    }

    try {
        await runTests({
            ...baseOptions(options, workspacePath),
            extensionTestsPath: runnerPath,
            headless: !!options.headless,
        });
    } finally {
        await closeAll(disposables);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
