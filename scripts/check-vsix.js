#!/usr/bin/env node
/**
 * Packaging gate: fails when the VSIX would ship anything but the extension
 * itself, is missing an entry point, or grows past its size budget. CI runs
 * it on every push (`npm run check:vsix`).
 *
 *   node scripts/check-vsix.js              package into a temp folder, check, delete it
 *   node scripts/check-vsix.js --vsix <f>   check an already-built VSIX instead
 *   --max-bytes <n>                         size budget in bytes (default 2 MiB)
 *
 * Packaging runs `vsce package --no-dependencies`, exactly as `npm run
 * gen-vsix` does, so it also runs vscode:prepublish (a production webpack
 * build). A VSIX is a zip; its entries are read straight from the zip's
 * central directory, so no unzip tool or extra dependency is needed.
 *
 * What may ship, inside the package's extension/ folder:
 *   out/client/, out/extension/, out/markdownItPlugin/, icons/
 *   package.json, package.nls.json, SYNTAX.md, README.md, CHANGELOG.md, LICENSE
 *   (vsce stores the last three as readme.md, changelog.md, LICENSE.txt)
 * plus vsce's own extension.vsixmanifest and [Content_Types].xml. Every file
 * package.json points at (main, browser, the renderer entrypoints, the icon)
 * must be there. Anything else -- a stray folder, node_modules, a source map,
 * the preview harness -- fails, and so does a package over the budget.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const ALLOWED_DIRECTORIES = ['out/client/', 'out/extension/', 'out/markdownItPlugin/', 'icons/'];
const ALLOWED_FILES = new Set([
    'package.json',
    'package.nls.json',
    'SYNTAX.md',
    'README.md', 'readme.md',
    'CHANGELOG.md', 'changelog.md',
    'LICENSE', 'LICENSE.txt',
]);
const VSIX_METADATA = new Set(['extension.vsixmanifest', '[Content_Types].xml']);

function usageError(message) {
    console.error(`${message}\n\nRun with --help for usage.`);
    process.exit(2);
}

/** Name and uncompressed size of every entry in a zip's central directory. */
function zipEntries(file) {
    const buffer = fs.readFileSync(file);
    const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
    const CENTRAL_FILE_HEADER = 0x02014b50;
    // The end record is 22 bytes plus a comment of at most 65535.
    let end = -1;
    for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
        if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
            end = at;
            break;
        }
    }
    if (end < 0) {
        throw new Error(`${file} is not a zip archive`);
    }

    const count = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);
    const entries = [];
    for (let index = 0; index < count; index++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
            throw new Error(`${file}: unreadable zip directory at entry ${index}`);
        }
        const size = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        entries.push({ name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength), size });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/** Every file package.json makes VS Code load, as package-relative paths. */
function requiredFiles(manifest) {
    const paths = [manifest.main, manifest.browser, manifest.icon];
    for (const renderer of manifest.contributes?.notebookRenderer ?? []) {
        paths.push(typeof renderer.entrypoint === 'string' ? renderer.entrypoint : renderer.entrypoint?.path);
    }
    return ['package.json', ...paths.filter(Boolean).map(p => path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, ''))];
}

function packageVsix(outFile) {
    const vscePackage = require.resolve('@vscode/vsce/package.json', { paths: [REPO_ROOT] });
    const bin = require(vscePackage).bin;
    const vsceBin = path.join(path.dirname(vscePackage), typeof bin === 'string' ? bin : bin.vsce);
    console.log('Packaging with vsce package --no-dependencies (runs vscode:prepublish)...');
    const result = spawnSync(process.execPath, [vsceBin, 'package', '--no-dependencies', '-o', outFile], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`vsce package exited with ${result.status}`);
    }
}

function checkVsix(vsixPath, maxBytes) {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const entries = zipEntries(vsixPath).filter(entry => !entry.name.endsWith('/'));
    const problems = [];

    const shipped = new Set();
    for (const { name } of entries) {
        if (VSIX_METADATA.has(name)) {
            continue;
        }
        const inner = name.startsWith('extension/') ? name.slice('extension/'.length) : undefined;
        if (inner !== undefined) {
            shipped.add(inner);
        }
        const allowed = inner !== undefined
            && (ALLOWED_FILES.has(inner) || ALLOWED_DIRECTORIES.some(dir => inner.startsWith(dir)));
        if (!allowed) {
            problems.push(`ships an unexpected file: ${name}`);
        }
    }
    for (const required of requiredFiles(manifest)) {
        if (!shipped.has(required)) {
            problems.push(`is missing ${required}, which package.json points at`);
        }
    }

    const bytes = fs.statSync(vsixPath).size;
    if (bytes > maxBytes) {
        problems.push(`is ${bytes} bytes, over the ${maxBytes}-byte budget`);
    }

    const kib = n => `${(n / 1024).toFixed(0)} KiB`;
    for (const { name, size } of entries) {
        console.log(`  ${kib(size).padStart(9)}  ${name}`);
    }
    if (problems.length > 0) {
        console.error(`\nVSIX check FAILED: ${path.basename(vsixPath)}\n  ` + problems.join('\n  '));
        return false;
    }
    console.log(`\nVSIX OK: ${entries.length} entries, ${kib(bytes)} (budget ${kib(maxBytes)}).`);
    return true;
}

function main() {
    const { values } = parseArgs({
        options: {
            vsix: { type: 'string' },
            'max-bytes': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help) {
        const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
        console.log(header.replace(/^#![^\n]*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
        return;
    }
    const maxBytes = values['max-bytes'] === undefined ? DEFAULT_MAX_BYTES : Number(values['max-bytes']);
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        usageError(`Not a valid byte count: ${values['max-bytes']}`);
    }

    if (values.vsix) {
        process.exitCode = checkVsix(path.resolve(values.vsix), maxBytes) ? 0 : 1;
        return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webnb-vsix-'));
    try {
        const vsixPath = path.join(dir, 'web-notebook.vsix');
        packageVsix(vsixPath);
        process.exitCode = checkVsix(vsixPath, maxBytes) ? 0 : 1;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
