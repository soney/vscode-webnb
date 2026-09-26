#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXTENSION_ROOT = path.resolve(__dirname, '..');

// Where a Practical-JavaScript checkout keeps its Docker dev harness, newest
// layout first. The course moved it from tools/coursera-docker-dev/ to
// coursera/docker-dev/ in its 2026-08 restructure; the old location is still
// probed so an older course checkout keeps working.
const DEV_SCRIPT_LOCATIONS = [
    ['coursera', 'docker-dev', 'dev.sh'],
    ['tools', 'coursera-docker-dev', 'dev.sh']
];

const DEFAULT_COURSE_REPO_CANDIDATES = [
    process.env.PRACTICAL_JAVASCRIPT_REPO,
    process.env.COURSES_REPO,
    process.env.COURSERA_DOCKER_REPO,
    // This checkout as the course repo's vscode-extensions/vscode-webnb submodule.
    path.resolve(EXTENSION_ROOT, '..', '..'),
    path.join(os.homedir(), 'teaching', 'Practical-JavaScript'),
    path.resolve(EXTENSION_ROOT, '..', 'Practical-JavaScript'),
    path.resolve(EXTENSION_ROOT, '..', '..', 'Practical-JavaScript')
].filter(Boolean);

function usage() {
    console.log(`Usage:
  npm run coursera:import -- [--repo /path/to/Practical-JavaScript] [--no-build] [--stage-only|--production-only]
  npm run coursera:start -- [--repo /path/to/Practical-JavaScript] [--no-build] [--prepare] [dev.sh start args...]
  npm run coursera:stop -- [--repo /path/to/Practical-JavaScript] [dev.sh stop args...]
  node scripts/coursera-docker-dev.js where [--repo /path/to/Practical-JavaScript]

Commands:
  import
      Build this extension VSIX and import it into the Practical-JavaScript
      Coursera Docker files (dev.sh import-web-notebook).

  start
      Build/import this extension, then run the Coursera Docker dev harness.
      By default this uses start --no-prepare. With --prepare, the harness also
      rebuilds the course content and the vendored extensions; web-notebook is
      then rebuilt from this checkout too (WEB_NOTEBOOK_DIR is set to it).

  stop
      Stop the Coursera Docker dev harness without building or importing.

  where
      Print the course repo and dev.sh these commands would use, and exit.
      Runs nothing, so it is safe without Docker.

Finding the course repo (first match wins; --repo replaces the whole list):
  $PRACTICAL_JAVASCRIPT_REPO, $COURSES_REPO, $COURSERA_DOCKER_REPO
  ${path.resolve(EXTENSION_ROOT, '..', '..')}  (this checkout as its vscode-extensions/vscode-webnb submodule)
  ~/teaching/Practical-JavaScript
  a Practical-JavaScript checkout next to this one, or one level up

  A folder counts as the course repo when it holds coursera/docker-dev/dev.sh
  (or tools/coursera-docker-dev/dev.sh, its location before the course's
  2026-08 restructure).`);
}

function die(message) {
    console.error(`coursera-docker-dev: ${message}`);
    process.exit(1);
}

/** The course repo's dev.sh, or undefined when `candidate` is not a course repo. */
function findDevScript(candidate) {
    if (!candidate) {
        return undefined;
    }
    return DEV_SCRIPT_LOCATIONS
        .map(parts => path.join(candidate, ...parts))
        .find(devScript => fs.existsSync(devScript));
}

function resolveCourseRepo(explicitRepo) {
    const candidates = explicitRepo
        ? [explicitRepo]
        : DEFAULT_COURSE_REPO_CANDIDATES;

    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        const devScript = findDevScript(resolved);
        if (devScript) {
            return { repoRoot: resolved, devScript };
        }
    }

    const tried = [...new Set(candidates.map(candidate => path.resolve(candidate)))];
    die('could not find Practical-JavaScript (a folder holding '
        + `${DEV_SCRIPT_LOCATIONS.map(parts => parts.join('/')).join(' or ')}). Tried:\n  `
        + tried.join('\n  ')
        + '\nPass --repo /path/to/Practical-JavaScript or set PRACTICAL_JAVASCRIPT_REPO.');
}

function runDev(course, args) {
    const result = spawnSync(course.devScript, args, {
        cwd: course.repoRoot,
        // The harness's extension rebuild (start --prepare) reads
        // WEB_NOTEBOOK_DIR for the web-notebook checkout. Pointing it here
        // keeps that rebuild on this checkout instead of the course repo's
        // submodule, which would otherwise replace the VSIX just imported.
        env: { ...process.env, WEB_NOTEBOOK_DIR: EXTENSION_ROOT },
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

function importWebNotebook(course, parsed) {
    const args = ['import-web-notebook'];

    if (parsed.build) {
        args.push('--build');
    }

    if (parsed.importMode) {
        args.push(parsed.importMode);
    }

    args.push(EXTENSION_ROOT);
    return runDev(course, args);
}

function startCourseraDev(course, parsed) {
    if (!importWebNotebook(course, parsed)) {
        return false;
    }

    const args = ['start'];
    if (!parsed.startPrepare) {
        args.push('--no-prepare');
    }

    args.push(...parsed.passthrough);
    return runDev(course, args);
}

function stopCourseraDev(course, parsed) {
    return runDev(course, ['stop', ...parsed.passthrough]);
}

function printWhere(course) {
    console.log(`course repo: ${course.repoRoot}`);
    console.log(`dev.sh:      ${course.devScript}`);
    console.log(`extension:   ${EXTENSION_ROOT}`);
}

const COMMANDS = {
    import: importWebNotebook,
    start: startCourseraDev,
    stop: stopCourseraDev,
    where: printWhere
};

const parsed = parseArgs(process.argv.slice(2));

if (parsed.command === 'help' || parsed.command === '-h' || parsed.command === '--help') {
    usage();
    process.exit(0);
}

if (!Object.prototype.hasOwnProperty.call(COMMANDS, parsed.command)) {
    console.error(`coursera-docker-dev: unknown command "${parsed.command}"\n`);
    usage();
    process.exit(1);
}

COMMANDS[parsed.command](resolveCourseRepo(parsed.repo), parsed);
