#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const DEFAULT_COURSE_REPO_CANDIDATES = [
    process.env.PRACTICAL_JAVASCRIPT_REPO,
    process.env.COURSES_REPO,
    process.env.COURSERA_DOCKER_REPO,
    path.join(os.homedir(), 'teaching', 'Practical-JavaScript'),
    path.resolve(EXTENSION_ROOT, '..', 'Practical-JavaScript'),
    path.resolve(EXTENSION_ROOT, '..', '..', 'Practical-JavaScript')
].filter(Boolean);

function usage() {
    console.log(`Usage:
  npm run coursera:import -- [--repo /path/to/Practical-JavaScript] [--no-build] [--stage-only|--production-only]
  npm run coursera:start -- [--repo /path/to/Practical-JavaScript] [--no-build] [--prepare] [dev.sh start args...]
  npm run coursera:stop -- [--repo /path/to/Practical-JavaScript] [dev.sh stop args...]

Commands:
  import
      Build this extension VSIX and import it into the Practical-JavaScript
      Coursera Docker files.

  start
      Build/import this extension, then run the Coursera Docker dev harness.
      By default this uses start --no-prepare.

  stop
      Stop the Coursera Docker dev harness without building or importing.

Environment:
  PRACTICAL_JAVASCRIPT_REPO=/path/to/Practical-JavaScript
      Default repo path used when --repo is not provided.

Aliases:
  COURSES_REPO and COURSERA_DOCKER_REPO are also accepted.`);
}

function die(message) {
    console.error(`coursera-docker-dev: ${message}`);
    process.exit(1);
}

function isCourseRepo(candidate) {
    return Boolean(candidate)
        && fs.existsSync(path.join(candidate, 'tools', 'coursera-docker-dev', 'dev.sh'));
}

function resolveCourseRepo(explicitRepo) {
    const candidates = explicitRepo
        ? [explicitRepo]
        : DEFAULT_COURSE_REPO_CANDIDATES;

    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (isCourseRepo(resolved)) {
            return resolved;
        }
    }

    die('could not find Practical-JavaScript. Pass --repo /path/to/Practical-JavaScript or set PRACTICAL_JAVASCRIPT_REPO.');
}

function runDev(repoRoot, args) {
    const devScript = path.join(repoRoot, 'tools', 'coursera-docker-dev', 'dev.sh');
    const result = spawnSync(devScript, args, {
        cwd: repoRoot,
        env: process.env,
        stdio: 'inherit'
    });

    if (result.error) {
        throw result.error;
    }

    process.exitCode = result.status ?? 1;
    return process.exitCode === 0;
}

function parseArgs(argv) {
    const parsed = {
        command: argv[0] || 'help',
        repo: undefined,
        build: true,
        startPrepare: false,
        importMode: undefined,
        passthrough: []
    };

    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--') {
            parsed.passthrough.push(...argv.slice(index + 1));
            break;
        }

        if (arg === '--repo') {
            index += 1;
            parsed.repo = argv[index];
            if (!parsed.repo) {
                die('--repo requires a path');
            }
            continue;
        }

        if (arg.startsWith('--repo=')) {
            parsed.repo = arg.slice('--repo='.length);
            continue;
        }

        if (arg === '--no-build') {
            parsed.build = false;
            continue;
        }

        if (arg === '--prepare') {
            parsed.startPrepare = true;
            continue;
        }

        if (arg === '--stage-only' || arg === '--production-only') {
            parsed.importMode = arg;
            continue;
        }

        if (arg === '-h' || arg === '--help') {
            parsed.command = 'help';
            continue;
        }

        parsed.passthrough.push(arg);
    }

    return parsed;
}

function importWebNotebook(repoRoot, parsed) {
    const args = ['import-web-notebook'];

    if (parsed.build) {
        args.push('--build');
    }

    if (parsed.importMode) {
        args.push(parsed.importMode);
    }

    args.push(EXTENSION_ROOT);
    return runDev(repoRoot, args);
}

function startCourseraDev(repoRoot, parsed) {
    if (!importWebNotebook(repoRoot, parsed)) {
        return false;
    }

    const args = ['start'];
    if (!parsed.startPrepare) {
        args.push('--no-prepare');
    }

    args.push(...parsed.passthrough);
    return runDev(repoRoot, args);
}

function stopCourseraDev(repoRoot, parsed) {
    return runDev(repoRoot, ['stop', ...parsed.passthrough]);
}

const parsed = parseArgs(process.argv.slice(2));

if (parsed.command === 'help' || parsed.command === '-h' || parsed.command === '--help') {
    usage();
    process.exit(0);
}

const repoRoot = resolveCourseRepo(parsed.repo);

if (parsed.command === 'import') {
    importWebNotebook(repoRoot, parsed);
} else if (parsed.command === 'start') {
    startCourseraDev(repoRoot, parsed);
} else if (parsed.command === 'stop') {
    stopCourseraDev(repoRoot, parsed);
} else {
    usage();
    process.exit(1);
}
