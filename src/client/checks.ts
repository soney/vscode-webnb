/**
 * File/command/console checks: the checklist cell grammar
 * (`kind: path | value | label` lines), the `check`/`file`/`checklist` API
 * exposed to test code, and the checklist feedback UI. Checks evaluate against
 * the workspace-file snapshots the kernel captured and the simulated
 * terminal's history — never the real filesystem.
 */
import type { WorkspaceFileSnapshotEntry } from '../shared/protocol';
import { parseRequestedPathReference } from '../shared/filePaths';
import {
    normalizeChecklistCheckKind,
    splitChecklistFields,
    stripChecklistLinePrefix,
    type FileChecklistCheckKind
} from '../shared/checklist';
import { renderMarkdownInline } from './markdown';
import type { FeedbackWriters } from './feedback';
import type { TerminalApi } from './terminal';

export interface FileChecklistCheck {
    kind: FileChecklistCheckKind;
    path: string;
    value?: string;
    label?: string;
    rawLine: string;
}

export interface ParsedFileChecklist {
    title?: string;
    intervalMs: number;
    checks: FileChecklistCheck[];
    errors: string[];
}

export interface FileCheckResult {
    label: string;
    passed: boolean;
    detail?: string;
    path?: string;
    run: (failMessage?: string, successMessage?: string) => void;
}

export interface FileCheckBuilder {
    toResult: () => FileCheckResult;
    run: (failMessage?: string, successMessage?: string) => void;
    exists: (label?: string) => FileCheckResult;
    isFile: (label?: string) => FileCheckResult;
    isDirectory: (label?: string) => FileCheckResult;
    contains: (text: string, label?: string) => FileCheckResult;
    notContains: (text: string, label?: string) => FileCheckResult;
    matches: (pattern: RegExp | string, label?: string) => FileCheckResult;
    equals: (text: string, label?: string) => FileCheckResult;
    hasEntry: (name: string, label?: string) => FileCheckResult;
}

export type ChecklistInput = FileCheckResult | FileCheckBuilder;

const DEFAULT_CHECKLIST_REFRESH_MS = 2000;

export function parseChecklistInterval(value: string): number | undefined {
    const raw = value.trim().toLowerCase();
    if (raw === 'off' || raw === 'false' || raw === 'none' || raw === 'manual') {
        return 0;
    }

    const match = raw.match(/^(\d+(?:\.\d+)?)(?:\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes))?$/);
    if (!match) {
        return undefined;
    }

    const amount = Number(match[1]);
    const unit = match[2] || 'ms';
    if (unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'second' || unit === 'seconds') {
        return amount * 1000;
    }
    if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes') {
        return amount * 60 * 1000;
    }
    return amount;
}

export function formatChecklistInterval(ms: number): string {
    if (ms >= 60000 && ms % 60000 === 0) {
        const minutes = ms / 60000;
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    if (ms >= 1000 && ms % 1000 === 0) {
        const seconds = ms / 1000;
        return `${seconds} second${seconds === 1 ? '' : 's'}`;
    }
    return `${ms} ms`;
}

export function parseFileChecklistSource(source: string): ParsedFileChecklist {
    const checks: FileChecklistCheck[] = [];
    const errors: string[] = [];
    let title: string | undefined;
    let intervalMs = DEFAULT_CHECKLIST_REFRESH_MS;
    let sawCheck = false;

    source.split(/\r?\n/g).forEach((rawLine, index) => {
        const line = stripChecklistLinePrefix(rawLine);
        if (!line || line.startsWith('#')) {
            return;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) {
            if (!sawCheck && !title) {
                title = line;
            } else {
                errors.push(`Line ${index + 1} is not a valid checklist item: \`${rawLine.trim()}\``);
            }
            return;
        }

        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        const normalizedKey = key.toLowerCase().replace(/[\s_-]+/g, '');

        if (normalizedKey === 'title') {
            title = value;
            return;
        }

        if (normalizedKey === 'interval' || normalizedKey === 'refresh' || normalizedKey === 'checkevery' || normalizedKey === 'poll') {
            const parsedInterval = parseChecklistInterval(value);
            if (parsedInterval === undefined) {
                errors.push(`Line ${index + 1} has an invalid interval: \`${value}\``);
            } else {
                intervalMs = parsedInterval;
            }
            return;
        }

        const kind = normalizeChecklistCheckKind(key);
        if (!kind) {
            errors.push(`Line ${index + 1} has an unknown check type: \`${key}\``);
            return;
        }

        const fields = splitChecklistFields(value);
        const path = fields[0];
        if (!path) {
            errors.push(`Line ${index + 1} is missing a path.`);
            return;
        }

        if (['contains', 'notContains', 'matches', 'equals', 'hasEntry'].includes(kind) && !fields[1]) {
            errors.push(`Line ${index + 1} is missing the value to check.`);
            return;
        }

        checks.push({
            kind,
            path,
            value: fields[1],
            label: kind === 'directory' || kind === 'file' || kind === 'path' || kind === 'command' ? fields[1] : fields[2],
            rawLine: rawLine.trim()
        });
        sawCheck = true;
    });

    return { title, intervalMs, checks, errors };
}

export function parseRegexLike(value: string): RegExp | string {
    const regexMatch = value.match(/^\/((?:\\.|[^/])+)\/([dgimsuvy]*)$/);
    if (!regexMatch) {
        return value;
    }

    const flags = regexMatch[2].includes('s') ? regexMatch[2] : `${regexMatch[2]}s`;
    return new RegExp(regexMatch[1], flags);
}

/** Renders checklist results into the feedback pane; returns whether all passed. */
export function createChecklistFeedback(feedback: HTMLElement) {
    return function addChecklistFeedback(results: FileCheckResult[], title?: string, options: { checkedAt?: number; intervalMs?: number; autoRefresh?: boolean; append?: boolean } = {}): boolean {
    // A checklist cell owns its whole pane; a checklist() called from a code
    // cell's test adds its block after the results already reported.
    if (!options.append) {
        feedback.innerHTML = '';
    }

    const allPassed = results.length > 0 && results.every(result => result.passed);
    const refreshIntervalMs = options.intervalMs ?? 0;
    const wrapper = document.createElement('div');
    const isChecking = !allPassed && !!options.autoRefresh && refreshIntervalMs > 0;
    wrapper.classList.add('checklist-feedback', allPassed ? 'success' : 'error');
    if (isChecking) {
        wrapper.classList.add('running');
    }

    const heading = document.createElement('div');
    heading.classList.add('checklist-title');
    heading.innerHTML = renderMarkdownInline(title || (allPassed ? 'Checklist complete' : 'Checklist needs work'));
    wrapper.appendChild(heading);

    if (options.checkedAt || options.autoRefresh) {
        const meta = document.createElement('div');
        meta.classList.add('checklist-meta');
        const parts: string[] = [];
        if (options.checkedAt) {
            parts.push(`Last checked ${new Date(options.checkedAt).toLocaleTimeString()}`);
        }
        if (isChecking) {
            parts.push(`checking again every ${formatChecklistInterval(refreshIntervalMs)}`);
        }
        if (allPassed) {
            parts.push('all items complete');
        }
        meta.textContent = parts.join(' · ');
        wrapper.appendChild(meta);
    }

    if (results.length === 0) {
        const empty = document.createElement('div');
        empty.classList.add('checklist-empty');
        empty.textContent = 'No checklist items were provided.';
        wrapper.appendChild(empty);
        feedback.append(wrapper);
        return false;
    }

    const list = document.createElement('ul');
    list.classList.add('checklist-items');

    for (const result of results) {
        const item = document.createElement('li');
        item.classList.add('checklist-item', result.passed ? 'passed' : 'failed');

        const status = document.createElement('span');
        status.classList.add('checklist-status');
        status.textContent = result.passed ? 'Pass' : 'Fix';

        const body = document.createElement('span');
        body.classList.add('checklist-body');

        const label = document.createElement('span');
        label.classList.add('checklist-label');
        label.innerHTML = renderMarkdownInline(result.label);
        body.appendChild(label);

        if (!result.passed && result.detail) {
            const detail = document.createElement('span');
            detail.classList.add('checklist-detail');
            detail.innerHTML = renderMarkdownInline(result.detail);
            body.appendChild(detail);
        }

        item.append(status, body);
        list.appendChild(item);
    }

    wrapper.appendChild(list);
    feedback.append(wrapper);
    return allPassed;
};
}

export type ChecklistFeedback = ReturnType<typeof createChecklistFeedback>;

export interface CheckApiDeps {
    files: Record<string, WorkspaceFileSnapshotEntry>;
    terminal: TerminalApi;
    didLog: (expected: string | RegExp) => boolean;
    /** Results a test reports with `.run()` join the others; they never replace them. */
    appendFeedback: FeedbackWriters['appendFeedback'];
    /** External/checklist cells collect results and render them all at once. */
    deferChecklistRendering: boolean;
    addChecklistFeedback: ChecklistFeedback;
}

/**
 * Builds the `check` / `file` / `checklist` API a cell's test code calls.
 * Everything is bound to one cell's snapshots, terminal, and feedback pane.
 */
export function createCheckApi({ files, terminal, didLog, appendFeedback, deferChecklistRendering, addChecklistFeedback }: CheckApiDeps) {
    const deferredChecklistResults: FileCheckResult[] = [];
    let deferredChecklistTitle: string | undefined;

    function normalizeWorkspacePath(path: string): string {
        return path.trim().replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/');
    }

    function getFileSnapshot(path: string): WorkspaceFileSnapshotEntry {
        const normalizedPath = normalizeWorkspacePath(path);
        // The kernel keys each snapshot by the same request string it parsed,
        // so `workspace: x` (with a space) is found under `workspace:x`.
        const requestKey = parseRequestedPathReference(path).requestPath;
        return files[requestKey] || files[normalizedPath] || files[path] || {
            path: normalizedPath || path,
            exists: false,
            error: `Add \`${path}\` to a \`+files\` block before checking it.`
        };
    }

    function createFileResult(label: string, passed: boolean, detail?: string, path?: string): FileCheckResult {
        return {
            label,
            passed,
            detail,
            path,
            run(failMessage?: string, successMessage?: string) {
                if (passed) {
                    appendFeedback(successMessage || label, 'success');
                } else {
                    appendFeedback(failMessage || detail || label, 'error');
                }
            }
        };
    }

    function describeFileEntry(entry: WorkspaceFileSnapshotEntry): string {
        if (entry.error) {
            return entry.error;
        }
        if (!entry.exists) {
            return `\`${entry.path}\` does not exist.`;
        }
        if (entry.type) {
            return `\`${entry.path}\` exists, but it is a ${entry.type}.`;
        }
        return `\`${entry.path}\` exists, but its type could not be determined.`;
    }

    function createFileCheck(path: string, expectedType?: 'file' | 'directory', label?: string): FileCheckBuilder {
        const normalizedPath = normalizeWorkspacePath(path);
        const defaultLabel = label || (
            expectedType === 'directory'
                ? `Create a directory named \`${normalizedPath}\``
                : expectedType === 'file'
                    ? `Create a file named \`${normalizedPath}\``
                    : `Create \`${normalizedPath}\``
        );

        function typeResult(type: 'file' | 'directory' | undefined, resultLabel: string): FileCheckResult {
            const entry = getFileSnapshot(path);
            const passed = entry.exists && (!type || entry.type === type);
            const detail = passed
                ? undefined
                : entry.exists && type
                    ? `Expected \`${entry.path}\` to be a ${type}, but found ${entry.type || 'unknown'}.`
                    : describeFileEntry(entry);
            return createFileResult(resultLabel, passed, detail, normalizedPath);
        }

        function contentResult(resultLabel: string, predicate: (content: string) => boolean, failDetail: string): FileCheckResult {
            const entry = getFileSnapshot(path);
            if (!entry.exists || entry.type !== 'file') {
                return createFileResult(resultLabel, false, describeFileEntry(entry), normalizedPath);
            }
            if (entry.content === undefined) {
                return createFileResult(resultLabel, false, entry.error || `Contents for \`${entry.path}\` were not loaded.`, normalizedPath);
            }
            const passed = predicate(entry.content);
            return createFileResult(resultLabel, passed, passed ? undefined : failDetail, normalizedPath);
        }

        const builder: FileCheckBuilder = {
            toResult() {
                return typeResult(expectedType, defaultLabel);
            },
            run(failMessage?: string, successMessage?: string) {
                this.toResult().run(failMessage, successMessage);
            },
            exists(resultLabel?: string) {
                return typeResult(undefined, resultLabel || `Create \`${normalizedPath}\``);
            },
            isFile(resultLabel?: string) {
                return typeResult('file', resultLabel || `Create a file named \`${normalizedPath}\``);
            },
            isDirectory(resultLabel?: string) {
                return typeResult('directory', resultLabel || `Create a directory named \`${normalizedPath}\``);
            },
            contains(text: string, resultLabel?: string) {
                return contentResult(
                    resultLabel || `In \`${normalizedPath}\`, include \`${text}\``,
                    content => content.includes(text),
                    `Expected \`${normalizedPath}\` to include \`${text}\`.`
                );
            },
            notContains(text: string, resultLabel?: string) {
                return contentResult(
                    resultLabel || `In \`${normalizedPath}\`, do not include \`${text}\``,
                    content => !content.includes(text),
                    `Expected \`${normalizedPath}\` not to include \`${text}\`.`
                );
            },
            matches(pattern: RegExp | string, resultLabel?: string) {
                let regex: RegExp;
                try {
                    regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
                } catch (error) {
                    return createFileResult(resultLabel || `In \`${normalizedPath}\`, match \`${pattern}\``, false, `Invalid regular expression: ${error}`, normalizedPath);
                }

                return contentResult(
                    resultLabel || `In \`${normalizedPath}\`, match \`${regex}\``,
                    content => {
                        regex.lastIndex = 0;
                        return regex.test(content);
                    },
                    `Expected \`${normalizedPath}\` to match \`${regex}\`.`
                );
            },
            equals(text: string, resultLabel?: string) {
                return contentResult(
                    resultLabel || `Make \`${normalizedPath}\` exactly match the expected contents`,
                    content => content === text,
                    `Expected \`${normalizedPath}\` to exactly match the expected contents.`
                );
            },
            hasEntry(name: string, resultLabel?: string) {
                const entry = getFileSnapshot(path);
                const label = resultLabel || `Inside \`${normalizedPath}\`, create \`${name}\``;
                if (!entry.exists || entry.type !== 'directory') {
                    return createFileResult(label, false, describeFileEntry(entry), normalizedPath);
                }

                const passed = !!entry.entries?.some(child => child.name === name);
                return createFileResult(
                    label,
                    passed,
                    passed ? undefined : `Expected \`${normalizedPath}\` to contain \`${name}\`.`,
                    normalizedPath
                );
            }
        };

        return builder;
    }

    function createChecklistSourceResult(parsedCheck: FileChecklistCheck): FileCheckResult {
        if (parsedCheck.kind === 'command') {
            const command = (parsedCheck.path || '').trim();
            const passed = terminal.didRun(command);
            return createFileResult(
                parsedCheck.label || `Run command \`${command}\``,
                passed,
                passed ? undefined : `Expected command history to include \`${command}\`.`,
                command
            );
        }

        const builder = createFileCheck(parsedCheck.path);

        if (parsedCheck.kind === 'directory') {
            return builder.isDirectory(parsedCheck.label);
        }
        if (parsedCheck.kind === 'file') {
            return builder.isFile(parsedCheck.label);
        }
        if (parsedCheck.kind === 'path') {
            return builder.exists(parsedCheck.label);
        }
        if (parsedCheck.kind === 'contains') {
            return builder.contains(parsedCheck.value || '', parsedCheck.label);
        }
        if (parsedCheck.kind === 'notContains') {
            return builder.notContains(parsedCheck.value || '', parsedCheck.label);
        }
        if (parsedCheck.kind === 'matches') {
            return builder.matches(parseRegexLike(parsedCheck.value || ''), parsedCheck.label);
        }
        if (parsedCheck.kind === 'equals') {
            return builder.equals(parsedCheck.value || '', parsedCheck.label);
        }
        return builder.hasEntry(parsedCheck.value || '', parsedCheck.label);
    }

    function createCommandCheck(command: string, label?: string): FileCheckResult {
        const normalized = command.trim();
        const passed = terminal.didRun(normalized);
        return createFileResult(
            label || `Run command \`${normalized}\``,
            passed,
            passed ? undefined : `Expected command history to include \`${normalized}\`.`,
            normalized
        );
    }

    function createCommandSequenceCheck(commands: string[], label?: string): FileCheckResult {
        const expected = commands.map(command => command.trim()).filter(Boolean);
        const actual = terminal.history();
        let position = -1;
        let missing: string | undefined;

        for (const command of expected) {
            const nextIndex = actual.findIndex((value, index) => index > position && value.trim() === command);
            if (nextIndex < 0) {
                missing = command;
                break;
            }
            position = nextIndex;
        }

        const passed = !missing;
        return createFileResult(
            label || `Run commands in order: ${expected.map(command => `\`${command}\``).join(', ')}`,
            passed,
            passed ? undefined : `Expected to find \`${missing}\` in order within command history.`,
            expected.join(' -> ')
        );
    }

    function createConsoleLogCheck(expected: string | RegExp, label?: string): FileCheckResult {
        const passed = didLog(expected);
        const expectedLabel = typeof expected === 'string' ? `\`${expected}\`` : `\`${expected.toString()}\``;
        return createFileResult(
            label || `Log ${expectedLabel} to the console`,
            passed,
            passed ? undefined : `Expected console history to include ${expectedLabel}.`
        );
    }

    const check = {
        path: (path: string, label?: string) => createFileCheck(path, undefined, label),
        file: (path: string, label?: string) => createFileCheck(path, 'file', label),
        directory: (path: string, label?: string) => createFileCheck(path, 'directory', label),
        exists: (path: string, label?: string) => createFileCheck(path, undefined, label).exists(label),
        command: (command: string, label?: string) => createCommandCheck(command, label),
        commands: (commands: string[], label?: string) => createCommandSequenceCheck(commands, label),
        consoleLogged: (expected: string | RegExp, label?: string) => createConsoleLogCheck(expected, label)
    };

    function file(path: string): FileCheckBuilder {
        return check.file(path);
    }

    function isFileCheckBuilder(item: ChecklistInput): item is FileCheckBuilder {
        return typeof (item as FileCheckBuilder).toResult === 'function';
    }

    function checklist(titleOrItems: string | ChecklistInput[], maybeItems?: ChecklistInput[]): boolean {
        const title = typeof titleOrItems === 'string' ? titleOrItems : undefined;
        const items = Array.isArray(titleOrItems) ? titleOrItems : (maybeItems || []);
        const results: FileCheckResult[] = items.map((item): FileCheckResult => {
            if (isFileCheckBuilder(item)) {
                return item.toResult();
            }
            return item;
        });

        if (deferChecklistRendering) {
            if (title) {
                deferredChecklistTitle = title;
            }
            deferredChecklistResults.push(...results);
            return results.length > 0 && results.every(result => result.passed);
        }

        return addChecklistFeedback(results, title, { append: true });
    }

    return {
        check,
        file,
        checklist,
        createChecklistSourceResult,
        createFileResult,
        getDeferred: () => ({ results: deferredChecklistResults, title: deferredChecklistTitle })
    };
}
