/**
 * Boots the vite preview harness for tests and waits until its API answers.
 * The preview hosts the extension's real render() (see preview/), so tests
 * driving it exercise the exact renderer VS Code ships.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VITE_ENTRY = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

function childIsDead(child) {
    return child.exitCode !== null || child.signalCode !== null;
}

async function waitForServer(url, timeoutMs, child) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        // A dead child means the port was taken (--strictPort) or vite crashed.
        // Failing here beats polling on: a stale server from an earlier run may
        // own the port and answer with the wrong content.
        if (childIsDead(child)) {
            throw new Error('vite exited before the server came up');
        }
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Preview server did not come up at ${url}: ${lastError}`);
}

/** Resilient realpath for comparing workspace identities. */
function canonical(dir) {
    try {
        return fs.realpathSync(dir);
    } catch {
        return path.resolve(dir);
    }
}

/**
 * Starts the preview on `port` serving `workspace` (default: this repo's
 * `samplenotebooks/`). Returns { url, stop }; always call stop() (also on
 * failure paths).
 */
async function startPreview(port, workspace = path.join(REPO_ROOT, 'samplenotebooks')) {
    // vite is spawned directly, not through npx: the wrapper would be the
    // process stop()'s SIGTERM reaches, orphaning the actual server on the
    // port — where it then answers the *next* run's health check.
    const child = spawn(
        process.execPath,
        [VITE_ENTRY, '--config', 'preview/vite.config.ts', '--port', String(port), '--strictPort'],
        {
            cwd: REPO_ROOT,
            env: { ...process.env, WEBNB_WORKSPACE: workspace },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });

    const stop = () => new Promise(resolve => {
        if (childIsDead(child)) {
            resolve();
            return;
        }
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000).unref();
    });

    const url = `http://localhost:${port}`;
    try {
        await waitForServer(`${url}/__webnb/api/notebooks`, 60000, child);
        // The port answered while our child is alive, but paranoia is cheap:
        // confirm the server is serving the workspace this run asked for.
        const listing = await (await fetch(`${url}/__webnb/api/notebooks`)).json();
        if (canonical(listing.workspace) !== canonical(workspace)) {
            throw new Error(
                `Port ${port} is served by another preview (workspace ${listing.workspace}); ` +
                'stop it or choose a different port'
            );
        }
    } catch (error) {
        await stop();
        throw new Error(`${error.message}\n--- vite output ---\n${output.slice(-2000)}`);
    }

    return { url, repoRoot: REPO_ROOT, stop };
}

module.exports = { startPreview, REPO_ROOT };
