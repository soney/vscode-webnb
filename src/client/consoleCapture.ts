/**
 * Console capture for notebook cells, two ways:
 *  - createCellConsole: the per-cell `console` shim injected into evaluated
 *    code, recording entries for `console.didLog` checks and mirroring to the
 *    real console.
 *  - attachHtmlConsoleCapture: for HTML cells, patches window.console once
 *    (process-wide proxy) and routes calls made from the cell's inline event
 *    handlers to that cell's recorder.
 */
import ConsoleObjectView from './consoleobjectview';
import type { messageType } from './feedback';

export type ConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'trace' | 'warn';

export interface ConsoleHistoryEntry {
    method: ConsoleMethod;
    args: any[];
    text: string;
    timestamp: number;
}

const HTML_CONSOLE_EVENT_TYPES = [
    'change',
    'click',
    'dblclick',
    'focus',
    'input',
    'keydown',
    'keypress',
    'keyup',
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'submit'
] as const;
const WRAPPED_HTML_CONSOLE_HANDLERS = Symbol('webnbWrappedHtmlConsoleHandlers');

let activeConsoleReporter: ((method: ConsoleMethod, args: any[]) => void) | undefined;
let isWindowConsolePatched = false;
let originalWindowConsole: Console | undefined;

export function consoleMethodToMessageType(method: ConsoleMethod): messageType {
    return method === 'error' ? 'error' : 'info';
}

function installWindowConsoleProxy(): void {
    if (isWindowConsolePatched) {
        return;
    }

    const originalConsole = window.console;
    originalWindowConsole = originalConsole;
    const wrappedMethods = new Set<ConsoleMethod>(['debug', 'error', 'info', 'log', 'trace', 'warn']);
    const proxy = new Proxy(originalConsole, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof prop === 'string' && wrappedMethods.has(prop as ConsoleMethod) && typeof value === 'function') {
                return (...args: any[]) => {
                    activeConsoleReporter?.(prop as ConsoleMethod, args);
                    return value.apply(target, args);
                };
            }

            return typeof value === 'function' ? value.bind(target) : value;
        }
    });

    window.console = proxy as Console;
    isWindowConsolePatched = true;
}

function wrapHtmlConsoleHandlers(
    root: HTMLElement,
    reportHtmlConsole: (method: ConsoleMethod, args: any[]) => void
): () => void {
    type HtmlConsoleTarget = HTMLElement & {
        [WRAPPED_HTML_CONSOLE_HANDLERS]?: Map<string, (...args: any[]) => any>;
        [key: string]: unknown;
    };

    const wrappedTargets = new Set<HtmlConsoleTarget>();

    const wrapElement = (element: HTMLElement) => {
        const target = element as HtmlConsoleTarget;
        const wrappedHandlers = target[WRAPPED_HTML_CONSOLE_HANDLERS] ?? new Map<string, (...args: any[]) => any>();
        target[WRAPPED_HTML_CONSOLE_HANDLERS] = wrappedHandlers;

        for (const eventType of HTML_CONSOLE_EVENT_TYPES) {
            const property = `on${eventType}`;
            if (wrappedHandlers.has(property)) {
                continue;
            }

            const original = target[property];
            if (typeof original !== 'function') {
                continue;
            }
            const originalHandler = original as (...args: any[]) => any;

            target[property] = function wrappedHtmlConsoleHandler(this: unknown, ...args: any[]) {
                const previousReporter = activeConsoleReporter;
                activeConsoleReporter = reportHtmlConsole;
                try {
                    return originalHandler.apply(this, args);
                } finally {
                    activeConsoleReporter = previousReporter;
                }
            };
            wrappedHandlers.set(property, originalHandler);
            wrappedTargets.add(target);
        }
    };

    const visitNode = (node: Node) => {
        if (!(node instanceof HTMLElement)) {
            return;
        }

        wrapElement(node);
        node.querySelectorAll('*').forEach(element => {
            if (element instanceof HTMLElement) {
                wrapElement(element);
            }
        });
    };

    visitNode(root);

    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(node => visitNode(node));
        }
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => {
        observer.disconnect();
        for (const target of wrappedTargets) {
            const wrappedHandlers = target[WRAPPED_HTML_CONSOLE_HANDLERS];
            if (!wrappedHandlers) {
                continue;
            }

            for (const [property, original] of wrappedHandlers) {
                target[property] = original;
            }
            delete target[WRAPPED_HTML_CONSOLE_HANDLERS];
        }
    };
}


/**
 * The `console` object evaluated cell code sees: records every call (for
 * `didLog` checks and the on-page console view) and mirrors it to the real
 * browser console.
 */
/**
 * Past this many messages the console pane stops growing (a runaway
 * `setInterval(console.log)` would otherwise add DOM forever); history for
 * `console.didLog` checks keeps a larger, still bounded, window.
 */
const MAX_DISPLAYED_CONSOLE_MESSAGES = 1000;
const MAX_CONSOLE_HISTORY = 10000;

export function createCellConsole(consoleElement: HTMLElement) {
    const consoleHistory: ConsoleHistoryEntry[] = [];
    let displayedMessages = 0;

    function appendConsoleLine(el: HTMLElement): void {
        if (displayedMessages === MAX_DISPLAYED_CONSOLE_MESSAGES) {
            const notice = document.createElement('div');
            notice.classList.add('info', 'console-message', 'console-truncated');
            notice.textContent = `Console output stopped after ${MAX_DISPLAYED_CONSOLE_MESSAGES} messages.`;
            consoleElement.append(notice);
        }
        displayedMessages++;
        if (displayedMessages > MAX_DISPLAYED_CONSOLE_MESSAGES) {
            return;
        }
        consoleElement.append(el);
    }

    function addConsoleMessage(objects: ConsoleObjectView[], category: messageType = 'info') {
        const el = document.createElement('div');
        el.classList.add(category, 'console-message');
        for (const obj of objects) {
            const view = obj.getElement();
            el.append(view);
        }
        appendConsoleLine(el);
    }

    /**
     * An error nobody caught, shown the way a browser console shows one. It is
     * not a console call, so it stays out of `console.history()`: tests that
     * count logged lines must not change because a demo's promise rejected.
     */
    function reportUncaught(text: string): void {
        const el = document.createElement('div');
        el.classList.add('error', 'console-message', 'console-uncaught');
        el.textContent = text;
        appendConsoleLine(el);
    }

    function formatConsoleValue(value: any): string {
        if (typeof value === 'string') {
            return value;
        }
        if (value instanceof Error) {
            return value.message;
        }
        if (value === undefined) {
            return 'undefined';
        }
        if (typeof value === 'symbol') {
            return value.toString();
        }
        if (typeof value === 'object' && value !== null) {
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        }

        return String(value);
    }

    function consoleEntryMatches(entry: ConsoleHistoryEntry, expected: string | RegExp): boolean {
        if (typeof expected === 'string') {
            return entry.text.includes(expected);
        }

        expected.lastIndex = 0;
        return expected.test(entry.text);
    }

    function recordConsoleMessage(method: ConsoleMethod, args: any[]): void {
        const entry: ConsoleHistoryEntry = {
            method,
            args: args.slice(),
            text: args.map(formatConsoleValue).join(' '),
            timestamp: Date.now()
        };
        if (consoleHistory.length < MAX_CONSOLE_HISTORY) {
            consoleHistory.push(entry);
        }
        addConsoleMessage(args.map(arg => new ConsoleObjectView(arg)), consoleMethodToMessageType(method));
    }

    const consoleMirror = originalWindowConsole ?? window.console;
    const console = {
        debug: (...args: any[]) => {
            recordConsoleMessage('debug', args);
            (consoleMirror.debug ?? consoleMirror.log).apply(consoleMirror, args);
        },
        error: (...args: any[]) => {
            recordConsoleMessage('error', args);
            (consoleMirror.error ?? consoleMirror.log).apply(consoleMirror, args);
        },
        info: (...args: any[]) => {
            recordConsoleMessage('info', args);
            (consoleMirror.info ?? consoleMirror.log).apply(consoleMirror, args);
        },
        log: (...args: any[]) => {
            recordConsoleMessage('log', args);
            consoleMirror.log(...args);
        },
        trace: (...args: any[]) => {
            recordConsoleMessage('trace', args);
            (consoleMirror.trace ?? consoleMirror.log).apply(consoleMirror, args);
        },
        warn: (...args: any[]) => {
            recordConsoleMessage('warn', args);
            (consoleMirror.warn ?? consoleMirror.log).apply(consoleMirror, args);
        },
        history: (): ConsoleHistoryEntry[] => consoleHistory.map(entry => ({
            ...entry,
            args: entry.args.slice()
        })),
        didLog: (expected: string | RegExp): boolean => consoleHistory.some(entry => consoleEntryMatches(entry, expected)),
        clear: (): void => {
            consoleHistory.length = 0;
            displayedMessages = 0;
            consoleElement.innerHTML = '';
        }
    };

    return { console, recordConsoleMessage, reportUncaught };
}

/**
 * Captures console calls made from an HTML cell's markup: inline `on*`
 * handlers (rebound so the proxy reports to this cell) plus listeners added by
 * the cell's scripts, active for the microtask each DOM event dispatches.
 * Returns a cleanup that unwraps the handlers and detaches the listeners.
 */
export function attachHtmlConsoleCapture(
    container: HTMLElement,
    record: (method: ConsoleMethod, args: any[]) => void
): () => void {
    installWindowConsoleProxy();

    const reportHtmlConsole = (method: ConsoleMethod, args: any[]) => {
        record(method, args);
    };
    const activateHtmlConsoleReporter = () => {
        activeConsoleReporter = reportHtmlConsole;
        queueMicrotask(() => {
            if (activeConsoleReporter === reportHtmlConsole) {
                activeConsoleReporter = undefined;
            }
        });
    };
    const restoreWrappedHtmlHandlers = wrapHtmlConsoleHandlers(container, reportHtmlConsole);

    for (const eventType of HTML_CONSOLE_EVENT_TYPES) {
        container.addEventListener(eventType, activateHtmlConsoleReporter, true);
    }
    return () => {
        restoreWrappedHtmlHandlers();
        if (activeConsoleReporter === reportHtmlConsole) {
            activeConsoleReporter = undefined;
        }
        for (const eventType of HTML_CONSOLE_EVENT_TYPES) {
            container.removeEventListener(eventType, activateHtmlConsoleReporter, true);
        }
    };
}
