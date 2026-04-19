// We've set up this sample using CSS modules, which lets you import class
// names into JavaScript: https://github.com/css-modules/css-modules
// You can configure or change this in the webpack.config.js file.
// import * as style from './style.css';
import type { RendererContext } from 'vscode-notebook-renderer';
import cy from './lite-cy';
import { marked } from 'marked';
import ConsoleObjectView from './consoleobjectview';
// import * as css from "css";

interface IRenderInfo {
    container: HTMLElement;
    feedback: HTMLElement;
    console: HTMLElement;
    style: HTMLStyleElement;
    addStyle: (css: string) => void;
    mime: string;
    value: any;
    context: RendererContext<unknown>;
}
type messageType = 'info' | 'success' | 'error';
interface McqOption {
    text: string;
    correct: boolean;
    correctFeedback?: string;
    wrongFeedback?: string;
}
interface ParsedMcq {
    question: string;
    options: McqOption[];
    correctFeedback?: string;
    wrongFeedback?: string;
}

type FileChecklistCheckKind = 'directory' | 'file' | 'path' | 'contains' | 'notContains' | 'matches' | 'equals' | 'hasEntry';

interface FileChecklistCheck {
    kind: FileChecklistCheckKind;
    path: string;
    value?: string;
    label?: string;
    rawLine: string;
}

interface ParsedFileChecklist {
    title?: string;
    intervalMs: number;
    checks: FileChecklistCheck[];
    errors: string[];
}

interface Addon {
    type: string;
    content: string;
    id?: string;
}

interface WorkspaceFileSnapshotEntry {
    path: string;
    exists: boolean;
    type?: 'file' | 'directory' | 'symlink' | 'unknown';
    content?: string;
    entries?: { name: string; type: string }[];
    size?: number;
    error?: string;
}

interface FileCheckResult {
    label: string;
    passed: boolean;
    detail?: string;
    path?: string;
    run: (failMessage?: string, successMessage?: string) => void;
}

interface FileCheckBuilder {
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

type ChecklistInput = FileCheckResult | FileCheckBuilder;

const DEFAULT_CHECKLIST_REFRESH_MS = 2000;

function isExternalCheckLanguage(language: string): boolean {
    return language === 'external' || language === 'checklist';
}

function normalizeAddonType(type: string | undefined): string {
    return (type || '').trim().toLowerCase().replace(/^\+/, '');
}

function isSolutionAddon(type: string | undefined): boolean {
    return normalizeAddonType(type) === 'solution';
}

function isScriptAddon(type: string | undefined): boolean {
    const normalizedType = normalizeAddonType(type);
    return normalizedType === 'test' || normalizedType === 'javascript' || normalizedType === 'js';
}

function isHtmlAddon(type: string | undefined): boolean {
    return normalizeAddonType(type) === 'html';
}

function isCssAddon(type: string | undefined): boolean {
    return normalizeAddonType(type) === 'css';
}

function parseMcqSource(source: string): ParsedMcq {
    const lines = source.split(/\r?\n/);
    const options: McqOption[] = [];
    const questionLines: string[] = [];
    let correctFeedback: string | undefined;
    let wrongFeedback: string | undefined;
    let sawOption = false;
    let currentOption: McqOption | undefined;

    for (const line of lines) {
        const optionMatch = line.match(/^\s*(?:-\s*)?\[([ xX])\]\s*(.*)$/);
        if (optionMatch) {
            sawOption = true;
            currentOption = {
                text: optionMatch[2].trim(),
                correct: optionMatch[1].toLowerCase() === 'x'
            };
            options.push(currentOption);
            continue;
        }

        if (currentOption) {
            const optionCorrectMatch = line.match(/^[ \t]+correct\s*:\s*(.*)$/i);
            if (optionCorrectMatch) {
                currentOption.correctFeedback = optionCorrectMatch[1].trim();
                continue;
            }

            const optionWrongMatch = line.match(/^[ \t]+(?:wrong|incorrect)\s*:\s*(.*)$/i);
            if (optionWrongMatch) {
                currentOption.wrongFeedback = optionWrongMatch[1].trim();
                continue;
            }
        }

        if (!sawOption) {
            const correctMatch = line.match(/^\s*correct\s*:\s*(.*)$/i);
            if (correctMatch) {
                correctFeedback = correctMatch[1].trim();
                continue;
            }

            const wrongMatch = line.match(/^\s*(?:wrong|incorrect)\s*:\s*(.*)$/i);
            if (wrongMatch) {
                wrongFeedback = wrongMatch[1].trim();
                continue;
            }
        }

        questionLines.push(line);
    }

    return {
        question: questionLines.join('\n').trim(),
        options,
        correctFeedback,
        wrongFeedback
    };
}

function stripChecklistLinePrefix(line: string): string {
    return line.trim()
        .replace(/^[-*]\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '')
        .trim();
}

function splitChecklistFields(value: string): string[] {
    const fields: string[] = [];
    let current = '';
    let escaped = false;

    for (const char of value) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (char === '|') {
            fields.push(current.trim());
            current = '';
            continue;
        }

        current += char;
    }

    fields.push(current.trim());
    return fields;
}

function normalizeChecklistCheckKind(kind: string): FileChecklistCheckKind | undefined {
    const normalized = kind.toLowerCase().replace(/[\s_-]+/g, '');
    if (normalized === 'directory' || normalized === 'dir') {
        return 'directory';
    }
    if (normalized === 'file') {
        return 'file';
    }
    if (normalized === 'path' || normalized === 'exists') {
        return 'path';
    }
    if (normalized === 'contains' || normalized === 'include' || normalized === 'includes') {
        return 'contains';
    }
    if (normalized === 'notcontains' || normalized === 'notinclude' || normalized === 'notincludes' || normalized === 'doesnotcontain') {
        return 'notContains';
    }
    if (normalized === 'matches' || normalized === 'match' || normalized === 'regex') {
        return 'matches';
    }
    if (normalized === 'equals' || normalized === 'equal') {
        return 'equals';
    }
    if (normalized === 'hasentry' || normalized === 'entry' || normalized === 'containsentry') {
        return 'hasEntry';
    }
    return undefined;
}

function parseChecklistInterval(value: string): number | undefined {
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

function formatChecklistInterval(ms: number): string {
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

function parseFileChecklistSource(source: string): ParsedFileChecklist {
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
            label: kind === 'directory' || kind === 'file' || kind === 'path' ? fields[1] : fields[2],
            rawLine: rawLine.trim()
        });
        sawCheck = true;
    });

    return { title, intervalMs, checks, errors };
}

function parseRegexLike(value: string): RegExp | string {
    const regexMatch = value.match(/^\/((?:\\.|[^/])+)\/([dgimsuvy]*)$/);
    if (!regexMatch) {
        return value;
    }

    return new RegExp(regexMatch[1], regexMatch[2]);
}

// This function is called to render your contents.
export function render({ container, feedback, mime, value, style, addStyle, console: consoleElement, context }: IRenderInfo): void | (() => void) {
    const { language, source, addons } = value;
    container.className = '';
    container.classList.add('webnb-output', `webnb-output-${language}`);
    feedback.className = '';
    feedback.classList.add('feedback', `feedback-${language}`);
    const files: Record<string, WorkspaceFileSnapshotEntry> =
        value.files && typeof value.files === 'object' ? value.files : {};
    // Solution addons are authoring helpers and should never be rendered or executed.
    const activeAddons: Addon[] = Array.isArray(addons)
        ? addons.filter((addon: Addon) => !isSolutionAddon(addon.type))
        : [];
    const deferChecklistRendering = isExternalCheckLanguage(language);
    const deferredChecklistResults: FileCheckResult[] = [];
    let deferredChecklistTitle: string | undefined;

    function addFeedback(message: string, category: messageType = 'info', isHtml: boolean = false) {
        feedback.innerHTML = '';
        const el = document.createElement('div');
        el.classList.add(category);

        if (isHtml) {
            el.innerHTML = message;
        } else {
            el.innerText = message;
        }
        feedback.append(el);
    }
    function addChecklistFeedback(results: FileCheckResult[], title?: string, options: { checkedAt?: number; intervalMs?: number; autoRefresh?: boolean } = {}): boolean {
        feedback.innerHTML = '';

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
        heading.innerHTML = marked.parseInline(title || (allPassed ? 'Checklist complete' : 'Checklist needs work')) as string;
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
            label.innerHTML = marked.parseInline(result.label) as string;
            body.appendChild(label);

            if (!result.passed && result.detail) {
                const detail = document.createElement('span');
                detail.classList.add('checklist-detail');
                detail.innerHTML = marked.parseInline(result.detail) as string;
                body.appendChild(detail);
            }

            item.append(status, body);
            list.appendChild(item);
        }

        wrapper.appendChild(list);
        feedback.append(wrapper);
        return allPassed;
    }
    function addConsoleMessage(objects: ConsoleObjectView[], category: messageType = 'info') {
        const el = document.createElement('div');
        el.classList.add(category, 'console-message');
        for (const obj of objects) {
            const view = obj.getElement();
            el.append(view);
        }
        consoleElement.append(el);
    }

    const sy = cy;
    function assert(selector: string, passMessage: string, failMessage: string) {
        return cy(container, (passed: boolean, message: string, trace: string[]) => {
            if (passed) {
                addFeedback(`${message}`, 'success');
            } else {
                addFeedback(`${message}`, 'error');
            }
        }).get(selector);
    }

    function assertRule(selector: string) {
        return cy.getRule(selector, (passed: boolean, message: string, trace: string[]) => {
            if (passed) {
                addFeedback(`${message}`, 'success');
            } else {
                addFeedback(`${message}`, 'error');
            }
        });
    }
    function wrap(object: any, passMessage: string, failMessage: string) {
        return cy.wrap(object, (passed: boolean, message: string, trace: string[]) => {
            if (passed) {
                addFeedback(`${message}`, 'success');
            } else {
                addFeedback(`${message}`, 'error');
            }
        });
    }

    function normalizeWorkspacePath(path: string): string {
        return path.trim().replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/');
    }

    function getFileSnapshot(path: string): WorkspaceFileSnapshotEntry {
        const normalizedPath = normalizeWorkspacePath(path);
        return files[normalizedPath] || files[path] || {
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
                    addFeedback(successMessage || label, 'success');
                } else {
                    addFeedback(failMessage || detail || label, 'error');
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

    const check = {
        path: (path: string, label?: string) => createFileCheck(path, undefined, label),
        file: (path: string, label?: string) => createFileCheck(path, 'file', label),
        directory: (path: string, label?: string) => createFileCheck(path, 'directory', label),
        exists: (path: string, label?: string) => createFileCheck(path, undefined, label).exists(label)
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

        return addChecklistFeedback(results, title);
    }

    function scheduleChecklistRefresh(allPassed: boolean, intervalMs: number): void | (() => void) {
        if (allPassed || intervalMs <= 0 || !value.cellUri || typeof context.postMessage !== 'function') {
            return undefined;
        }

        const timer = window.setTimeout(() => {
            context.postMessage?.({
                type: 'webnb.refreshCell',
                cellUri: value.cellUri
            });
        }, intervalMs);

        return () => window.clearTimeout(timer);
    }

    if (language === 'html') {
        container.innerHTML = source;

        for (const { type, content } of activeAddons) {
            if (isScriptAddon(type)) {
                eval(content);
            } else if (isCssAddon(type)) {
                addStyle(content);
            }

        }

        // addFeedback(`Rendered HTML with ${source.length} characters.`);
        // try {
        //     cy(container).get('h1').should('exist');
        //     addFeedback('Cypress assertion: h1 exists', 'success');
        // } catch (error) {
        //     addFeedback(`Error in Cypress assertion: ${error}`, 'error');
        // }
        //         `<h1>Output!:</h1>
        // <div id="outp"></div>
        // ${source}
        // <script>
        // function addToOutput(message) {
        // console.log(message);
        // const h1 = document.querySelector('h1');
        // h1.textContent = 'Output from the web notebook renderer:';
        //     const outputDiv = document.querySelector('#outp');
        //     if (outputDiv) {
        //         const pre = document.createElement('pre');
        //         pre.append(message);
        //         outputDiv.appendChild(pre);
        //     }
        // }
        // addToOutput('This is a message from the web notebook renderer.');
        // </script>`;
    } else if (language === 'css') {
        addStyle(source);
        for (const { type, content } of activeAddons) {
            if (isHtmlAddon(type)) {
                container.innerHTML = content;
            } else if (isCssAddon(type)) {
                addStyle(content);
            } else if (isScriptAddon(type)) {
                eval(content);
            }
        }
        /*
        const ast = css.parse(source);
        
        let numSelectors: number = 0;
        let numRules: number = 0;
        if(ast.stylesheet) {
            numSelectors = ast.stylesheet.rules.length;
            for (const rule of ast.stylesheet.rules) {
                if (rule.type === 'rule') {
                    if(rule.selectors) {
                        numRules += rule.selectors.length;
                    }
                }
            }
        }

        container.innerText = `CSS with ${numRules} rules`;
        */
    } else if (isExternalCheckLanguage(language)) {
        const parsedChecklist = parseFileChecklistSource(source);
        const results = parsedChecklist.checks.map(check => createChecklistSourceResult(check));
        for (const error of parsedChecklist.errors) {
            results.push(createFileResult(error, false, error));
        }
        for (const { type, content } of activeAddons) {
            if (isScriptAddon(type)) {
                try {
                    eval(content);
                } catch (error) {
                    results.push(createFileResult(`Error in external check test: ${error}`, false, `${error}`));
                }
            }
        }
        results.push(...deferredChecklistResults);

        const shouldRefresh = results.length > 0;
        const allPassed = addChecklistFeedback(results, parsedChecklist.title || deferredChecklistTitle, {
            checkedAt: value.checkedAt,
            intervalMs: parsedChecklist.intervalMs,
            autoRefresh: shouldRefresh
        });

        return shouldRefresh ? scheduleChecklistRefresh(allPassed, parsedChecklist.intervalMs) : undefined;
    } else if (language === 'mcq') {
        const { question, options, correctFeedback, wrongFeedback } = parseMcqSource(source);
        if (!question || options.length === 0) {
            addFeedback('MCQ cells need a question plus at least one option.', 'error');
            return;
        }

        const numCorrect = options.filter(o => o.correct).length;
        const inputType = numCorrect > 1 ? 'checkbox' : 'radio';

        const form = document.createElement('form');
        form.classList.add('mcq-form');

        const questionEl = document.createElement('div');
        questionEl.classList.add('mcq-question');
        questionEl.innerHTML = marked.parse(question) as string;
        form.appendChild(questionEl);

        const optionFeedbackEls: HTMLDivElement[] = [];

        options.forEach((opt, index) => {
            const optionRow = document.createElement('div');
            optionRow.classList.add('mcq-option-row');

            const label = document.createElement('label');
            label.classList.add('mcq-option');

            const input = document.createElement('input');
            input.type = inputType;
            input.name = 'mcq-option';
            input.value = index.toString();

            label.appendChild(input);
            const span = document.createElement('span');
            span.innerHTML = marked.parseInline(opt.text) as string;
            label.appendChild(span);

            const optionFeedbackEl = document.createElement('div');
            optionFeedbackEl.classList.add('mcq-option-feedback');
            optionFeedbackEl.hidden = true;

            optionFeedbackEls.push(optionFeedbackEl);
            optionRow.append(label, optionFeedbackEl);
            form.appendChild(optionRow);
        });

        const checkBtn = document.createElement('button');
        checkBtn.textContent = 'Check Answer';
        checkBtn.type = 'button';
        checkBtn.classList.add('mcq-check-button');

        checkBtn.addEventListener('click', () => {
            const inputs = form.querySelectorAll<HTMLInputElement>('input');
            const checkedInputs = Array.from(inputs).filter(input => input.checked);

            optionFeedbackEls.forEach(el => {
                el.hidden = true;
                el.className = 'mcq-option-feedback';
                el.textContent = '';
            });

            if (checkedInputs.length === 0) {
                addFeedback('Select at least one answer before checking.', 'error');
                return;
            }

            let allCorrect = true;

            inputs.forEach((input, index) => {
                const opt = options[index];
                const itemIsCorrect = input.checked === opt.correct;
                if (!itemIsCorrect) {
                    allCorrect = false;
                }

                const itemFeedback = itemIsCorrect ? opt.correctFeedback : opt.wrongFeedback;
                if (itemFeedback) {
                    const optionFeedbackEl = optionFeedbackEls[index];
                    optionFeedbackEl.hidden = false;
                    optionFeedbackEl.classList.add(itemIsCorrect ? 'success' : 'error');
                    optionFeedbackEl.innerHTML = marked.parseInline(itemFeedback) as string;
                }
            });

            if (allCorrect) {
                addFeedback(marked.parseInline(correctFeedback || 'Correct!') as string, 'success', true);
            } else {
                addFeedback(marked.parseInline(wrongFeedback || 'Incorrect. Try again.') as string, 'error', true);
            }
        });

        form.appendChild(checkBtn);
        container.appendChild(form);

    } else if (language === 'javascript' || language === 'js') {
        for (const { type, content } of activeAddons) {
            if (isHtmlAddon(type)) {
                container.innerHTML = content;
            } else if (isCssAddon(type)) {
                addStyle(content);
                // } else if(type === 'test' || type === 'javascript' || type === 'js') {
                //     eval(content);
            }
        }
        const oldConsole = window.console;
        const console = {
            doLog: (method: "log" | "trace" | "error", ...args: any[]) => {
                let cls: messageType = "info";
                if (method === 'log' || method === 'trace') { cls = "info"; }
                else if (method === 'error') { cls = "error"; }

                addConsoleMessage(args.map(a => new ConsoleObjectView(a)), cls);
                oldConsole.log(...args);
            },
            log: (...args: any[]) => {
                console.doLog('log', ...args);
            },
            error: (...args: any[]) => {
                console.doLog('error', ...args);
            },
            trace: (...args: any[]) => {
                console.doLog('trace', ...args);
            }
        };
        const document = container;
        (document as any).body = container;
        try {
            let toEval = source;
            for (const { type, content } of activeAddons) {
                if (isScriptAddon(type)) {
                    toEval += '\n\n' + content;
                }
            }
            window.console.log(toEval);
            eval(toEval);
        } catch (error) {
            addFeedback(`Error in JavaScript code: ${error}`, 'error');
        }
    } else {
        const pre = document.createElement('pre');
        // pre.classList.add(style.json);
        const code = document.createElement('code');
        code.textContent = `mime type: ${mime}\n\n${JSON.stringify(value, null, 2)}`;
        pre.appendChild(code);
        container.appendChild(pre);
    }
}

if (module.hot) {
    module.hot.addDisposeHandler(() => {
        // In development, this will be called before the renderer is reloaded. You
        // can use this to clean up or stash any state.
    });
}
