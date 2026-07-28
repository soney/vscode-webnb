/**
 * Boots the vite preview harness for tests and waits until its API answers.
 * The preview hosts the extension's real render() (see preview/), so tests
 * driving it exercise the exact renderer VS Code ships.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function waitForServer(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
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

/**
 * Starts the preview on `port` serving `samplenotebooks/`.
 * Returns { url, stop }; always call stop() (also on failure paths).
 */
async function startPreview(port) {
    const child = spawn(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['vite', '--config', 'preview/vite.config.ts', '--port', String(port), '--strictPort'],
        {
            cwd: REPO_ROOT,
            env: { ...process.env, WEBNB_WORKSPACE: path.join(REPO_ROOT, 'samplenotebooks') },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });

    const url = `http://localhost:${port}`;
    try {
        await waitForServer(`${url}/__webnb/api/notebooks`, 60000);
    } catch (error) {
        child.kill('SIGTERM');
        throw new Error(`${error.message}\n--- vite output ---\n${output.slice(-2000)}`);
    }

    return {
        url,
        repoRoot: REPO_ROOT,
        stop: () => new Promise(resolve => {
            child.once('exit', resolve);
            child.kill('SIGTERM');
            setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000).unref();
        })
    };
}

module.exports = { startPreview, REPO_ROOT };
