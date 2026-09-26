/**
 * The notebook renderer: turns a cell's output payload into DOM inside the
 * webview. render() dispatches on the cell language to the per-cell-type
 * modules (mcq, checks, terminal, walkthroughRender, ...) and owns the
 * lexical scope that evaluated notebook code sees.
 *
 * IMPORTANT: evalCellCode() runs notebook and addon code with a direct eval,
 * which deliberately exposes this function's local bindings (console,
 * document, window, assert, assertRule, wrap, check, checklist, file,
 * createFileResult, files, source, cy, sy, defaultSource, terminal,
 * renderReact, React, ReactDOM, pathModule, the timer functions, ...) to that
 * code; the node/react/module sandbox passes the same names explicitly.
 * `document` and `window` are the cell-scoped stand-ins from cellGlobals.ts,
 * not the webview's own. Deep internals that were incidentally visible before
 * the split (terminal/console/check-DSL implementation helpers) are
 * intentionally no longer in scope. Renaming, moving, or removing any of those
 * locals is an API change for existing notebooks, invisible to the type
 * checker -- keep the preview harness green across all languages.
 */
import cy from './lite-cy';
import { createNodeProcess, createRuntimeRequire, pathModule as importedPathModule } from './runtime';
import { parseWalkthroughSource } from './walkthrough';
import {
    createWalkthroughHoverBridge,
    renderParsedWalkthrough,
    type WalkthroughHoverBridge
} from './walkthroughRender';
import { renderMarkdownBlock, renderMarkdownInline } from './markdown';
import { renderCellActions } from './cellActions';
import { createFeedback, type messageType } from './feedback';
import { attachHtmlConsoleCapture, createCellConsole } from './consoleCapture';
import { renderMcqCell } from './mcq';
import { createTerminalController, parseTerminalAddon, parseTerminalHistoryAddon, serializeTerminalHistoryAddon } from './terminal';
import {
    createCheckApi,
    createChecklistFeedback,
    parseFileChecklistSource
} from './checks';
import type {
    Addon,
    WebnbOutputValue,
    WebNbRendererMessage,
    WorkspaceFileSnapshotEntry
} from '../shared/protocol';
import {
    getAddonContent,
    hasAddon,
    isCssAddon,
    isExternalCheckLanguage,
    isHtmlAddon,
    isScriptAddonType as isScriptAddon,
    isSolutionAddon,
    isTerminalAddon
} from '../shared/addons';
import { AUTO_OUTPUT_HEIGHT, parseOutputHeight } from '../shared/outputHeight';
import { LEARNER_OUTPUT_ATTRIBUTE } from '../shared/notebookLinks';
import { createCellGlobals, describeAsyncError } from './cellGlobals';
import { createLoopFailure, insertLoopGuards } from './loopGuard';
import * as Babel from '@babel/standalone';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root, type RootOptions } from 'react-dom/client';

/** The slice of the notebook-renderer context render() actually uses; the
 * preview harness provides just this instead of a full RendererContext. */
export interface RendererHostContext {
    postMessage?(message: unknown): void;
}

export interface IRenderInfo {
    container: HTMLElement;
    feedback: HTMLElement;
    console: HTMLElement;
    widgetHost: HTMLElement;
    style: HTMLStyleElement;
    addStyle: (css: string) => void;
    mime: string;
    value: WebnbOutputValue;
    context: RendererHostContext;
}
const REACT_LANGUAGE_IDS = new Set(['react', 'jsx', 'javascriptreact']);
const NODE_LANGUAGE_IDS = new Set(['node']);
const JAVASCRIPT_LANGUAGE_IDS = new Set(['javascript', 'js']);
type RuntimeLanguageKind = 'javascript' | 'node' | 'react';

/**
 * Sizes the output pane from the cell's `height=` attribute, as an inline style
 * because it has to beat the stylesheet's `div#html-output:not(...)` rule. That
 * rule's `min-height` would also win over a shorter height, so any explicit
 * height clears the floor; `auto` drops it and lets the pane fit its content.
 */
function applyOutputHeight(container: HTMLElement, height: string | undefined): void {
    const { style } = container;
    style.removeProperty('height');
    style.removeProperty('min-height');
    style.removeProperty('overflow');
    style.removeProperty('box-sizing');
    if (height === undefined) {
        return;
    }

    style.minHeight = '0';
    if (height === AUTO_OUTPUT_HEIGHT) {
        style.height = AUTO_OUTPUT_HEIGHT;
        return;
    }

    // A pane held at a fixed height scrolls rather than clipping what does not
    // fit, and counts its own border so `height=300` is 300px on the page.
    style.height = height;
    style.overflow = 'auto';
    style.boxSizing = 'border-box';
}

function getRuntimeLanguageKind(language: string): RuntimeLanguageKind | undefined {
    if (REACT_LANGUAGE_IDS.has(language)) {
        return 'react';
    }
    if (NODE_LANGUAGE_IDS.has(language)) {
        return 'node';
    }
    if (JAVASCRIPT_LANGUAGE_IDS.has(language)) {
        return 'javascript';
    }
    return undefined;
}

/**
 * Parses an HTML cell's source the way the page would, for assertions the
 * rendered output cannot answer: `innerHTML` on a div drops <html>, <head> and
 * <body>, so `assert('body')` would never match. DOMParser keeps them, but it
 * also invents them when the source has none, and an invented element is no
 * evidence the learner wrote it. So each of the three that the source does not
 * actually spell out is renamed to `webnb-implicit-*`, where no selector a
 * test writes can match it (and `body > ul` stops matching through it).
 */
function parseExplicitSource(markup: string): Element {
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const spelledOut = (tag: string) => new RegExp(`<${tag}(\\s|>|/)`, 'i').test(markup);
    const standIn = (element: Element, tag: string): Element => {
        const explicit = spelledOut(tag);
        const copy = document.createElement(explicit ? tag : `webnb-implicit-${tag}`);
        if (explicit) {
            for (const attribute of Array.from(element.attributes)) {
                copy.setAttribute(attribute.name, attribute.value);
            }
        }
        return copy;
    };
    const html = standIn(parsed.documentElement, 'html');
    const head = standIn(parsed.head, 'head');
    const body = standIn(parsed.body, 'body');
    head.append(...Array.from(parsed.head.childNodes));
    body.append(...Array.from(parsed.body.childNodes));
    html.append(head, body);
    const holder = document.createElement('div');
    holder.append(html);
    return holder;
}

/**
 * Wraps sandboxed code in a block so its own declarations can shadow the
 * sandbox's parameter names: `const file = 'notes.txt'` in a node cell would
 * otherwise be a SyntaxError ("Identifier 'file' has already been
 * declared"). A leading "use strict" stays outside the block, where it still
 * counts as a directive.
 */
function wrapInBlock(code: string): string {
    const directive = /^\s*(['"])use strict\1;?/.exec(code);
    return directive
        ? `${directive[0]}{${code.slice(directive[0].length)}\n}`
        : `{${code}\n}`;
}

// This function is called to render your contents.
export function render({ container, feedback, mime, value, style, addStyle, console: consoleElement, widgetHost, context }: IRenderInfo): void | (() => void) {
    const { language, source, addons } = value;
    container.className = '';
    container.classList.add('webnb-output', `webnb-output-${language}`);
    feedback.className = '';
    feedback.classList.add('feedback', `feedback-${language}`);
    const files: Record<string, WorkspaceFileSnapshotEntry> =
        value.files && typeof value.files === 'object' ? value.files : {};
    // Typed against the protocol union, so a message-shape change is a compile
    // error here and in the extension's isRendererMessage guard alike.
    const postToHost = (message: WebNbRendererMessage): void => {
        context.postMessage?.(message);
    };
    // Solution addons never execute, and stay hidden unless the host allows
    // revealing them (the webnb.allowRevealingSolutions setting, as `reveal`).
    const solutionAddon = Array.isArray(addons)
        ? addons.find((addon: Addon) => isSolutionAddon(addon.type))
        : undefined;
    const reveal = value.reveal === true;
    const activeAddons: Addon[] = Array.isArray(addons)
        ? addons.filter((addon: Addon) => !isSolutionAddon(addon.type))
        : [];
    const hasHtmlAddon = activeAddons.some(addon => isHtmlAddon(addon.type));
    const runtimeLanguageKind = getRuntimeLanguageKind(language);
    const outputHeight = parseOutputHeight(value.height);
    // Asking for a height is asking for the pane: a JavaScript cell that draws
    // into `document` without an `+html` fixture would otherwise have nowhere
    // visible to draw. `height=auto` is the opposite request, so it does not
    // count -- it takes space away rather than reserving it.
    const heightWantsOutputContainer = outputHeight !== undefined && outputHeight !== AUTO_OUTPUT_HEIGHT;
    const shouldShowOutputContainer =
        language === 'css' ? hasHtmlAddon
            : runtimeLanguageKind === 'javascript' || runtimeLanguageKind === 'node' ? hasHtmlAddon
                : true;
    container.classList.toggle('webnb-output-empty', !shouldShowOutputContainer && !heightWantsOutputContainer);
    applyOutputHeight(container, outputHeight);
    const defaultSource = getAddonContent(activeAddons, 'default') ?? '';
    const deferChecklistRendering = isExternalCheckLanguage(language);
    const terminalAddon = activeAddons.find(addon => isTerminalAddon(addon.type));
    const terminalConfig = terminalAddon ? parseTerminalAddon(terminalAddon.content) : undefined;
    const terminalCellKey = typeof value.cellUri === 'string' ? value.cellUri : `webnb:${language}`;
    const canSaveToCell = typeof value.cellUri === 'string' && typeof context.postMessage === 'function';
    const terminalController = createTerminalController({
        widgetHost,
        cellKey: terminalCellKey,
        config: terminalConfig,
        // The commands a learner ran are saved in the cell, so a terminal
        // checklist survives closing the notebook or reloading the lab.
        savedHistory: terminalConfig ? parseTerminalHistoryAddon(getAddonContent(activeAddons, 'history')) : undefined,
        onHistoryChanged: terminalConfig && canSaveToCell
            ? history => postToHost({
                type: 'webnb.upsertCellAddon',
                cellUri: value.cellUri,
                addonType: 'history',
                content: serializeTerminalHistoryAddon(history)
            })
            : undefined,
        onCommandRan: command => {
            if (!command.trim()) {
                return;
            }
            if (!terminalConfig || !isExternalCheckLanguage(language) || !value.cellUri || typeof context.postMessage !== 'function') {
                return;
            }

            terminalController.state.restoreFocus = true;
            window.setTimeout(() => {
                postToHost({
                    type: 'webnb.refreshCell',
                    cellUri: value.cellUri
                });
            }, 0);
        }
    });
    const terminal = terminalController.api;
    let reactRoot: Root | undefined;
    let refreshCleanup: void | (() => void);
    let htmlConsoleCleanup: void | (() => void);
    let walkthroughHoverBridge: WalkthroughHoverBridge | undefined;

    const { appendFeedback, addFeedback } = createFeedback(feedback);
    const { console, recordConsoleMessage, reportUncaught } = createCellConsole(consoleElement);
    // The page globals the cell's code sees: DOM queries scoped to this cell,
    // timers and global listeners cleared on the next run, and asynchronous
    // errors shown in this cell's console.
    const cellScope = createCellGlobals({
        root: container,
        console,
        reportError: (error, kind) => reportUncaught(describeAsyncError(error, kind))
    });
    const isLearnerMarkup = language === 'html' || language === 'css' || runtimeLanguageKind !== undefined;
    if (isLearnerMarkup) {
        container.setAttribute(LEARNER_OUTPUT_ATTRIBUTE, '');
    } else {
        container.removeAttribute(LEARNER_OUTPUT_ATTRIBUTE);
    }
    const addChecklistFeedback = createChecklistFeedback(feedback);
    const checkApi = createCheckApi({
        files,
        terminal,
        didLog: expected => console.didLog(expected),
        appendFeedback,
        deferChecklistRendering,
        addChecklistFeedback
    });
    const check = checkApi.check;
    const file = checkApi.file;
    const checklist = checkApi.checklist;
    const createFileResult = checkApi.createFileResult;

    const sy = cy;
    const reportAssertion = (passed: boolean, message: string, _trace: string[]) => {
        appendFeedback(`${message}`, passed ? 'success' : 'error');
    };
    // React commits a click's state update in a microtask; flushing it right
    // after the event lets the next assertion in the same test see the result.
    const afterAction = runtimeLanguageKind === 'react' ? () => flushSync(() => undefined) : undefined;
    function assert(selector: string) {
        const onResult = reportAssertion;
        // Browsers strip <html> and <body> when setting innerHTML on a div, so
        // these structural elements won't be found in the container. Parse the
        // source instead so document-structure assertions work (see
        // parseExplicitSource for why invented elements never match). The
        // nodes are flagged `sourceOnly` so negated assertions ignore them:
        // this fallback only ever runs when the render matched nothing, which
        // is exactly when `not.exist` should pass.
        if (language === 'html' && container.querySelectorAll(selector).length === 0) {
            const nodes = Array.from(parseExplicitSource(source).querySelectorAll(selector));
            if (nodes.length > 0) {
                return cy(nodes, onResult, { sourceOnly: true, afterAction });
            }
        }
        return cy(container, onResult, { afterAction }).get(selector);
    }

    // Only this cell's own stylesheets: its CSS, its CSS addons and any <style>
    // in its markup -- never another cell's rules or the renderer's own.
    const cellStyleSheets = (): CSSStyleSheet[] => {
        const rootNode = container.getRootNode();
        const sheets = typeof ShadowRoot !== 'undefined' && rootNode instanceof ShadowRoot
            ? Array.from(rootNode.styleSheets)
            : [];
        return sheets.filter(sheet => sheet.ownerNode !== style);
    };
    function assertRule(selector: string) {
        return cy.getRule(selector, reportAssertion, cellStyleSheets());
    }
    function wrap(object: any) {
        return cy.wrap(object, reportAssertion);
    }

    function scheduleChecklistRefresh(allPassed: boolean, intervalMs: number): void | (() => void) {
        if (allPassed || intervalMs <= 0 || !value.cellUri || typeof context.postMessage !== 'function') {
            return undefined;
        }

        const timer = window.setTimeout(() => {
            postToHost({
                type: 'webnb.refreshCell',
                cellUri: value.cellUri
            });
        }, intervalMs);

        return () => window.clearTimeout(timer);
    }

    // React roots this run created, through renderReact or a direct
    // ReactDOM.createRoot; all of them unmount on the next run.
    const reactRoots = new Set<Root>();
    const reactRootOptions: RootOptions = {
        // React reports a render error here instead of throwing it to the
        // cell's code, so without this a broken component is a blank output.
        onUncaughtError: error => reportUncaught(describeAsyncError(error, 'uncaught'))
    };
    const createCellRoot = (host: Element | DocumentFragment, options?: RootOptions) => {
        const created = createRoot(host, { ...reactRootOptions, ...options });
        reactRoots.add(created);
        // Commit synchronously, so the cell's own tests (which run right
        // after its code) see what was rendered.
        const wrapped: Root = {
            render: (children: React.ReactNode) => flushSync(() => created.render(children)),
            unmount: () => {
                reactRoots.delete(created);
                created.unmount();
            }
        };
        return wrapped;
    };

    // Every exit path returns this same cleanup — a missed early return here
    // used to leak the xterm instance when compilation failed.
    const cleanup = () => {
        htmlConsoleCleanup?.();
        refreshCleanup?.();
        walkthroughHoverBridge?.dispose();
        for (const created of reactRoots) {
            created.unmount();
        }
        reactRoots.clear();
        terminalController.dispose();
        cellScope.dispose();
    };

    terminalController.mount();

    // The runtime names evaluated code can use, in every cell type.
    const ReactDOM = { createRoot: createCellRoot };
    const runtimeRequire = createRuntimeRequire(ReactDOM);
    const nodeProcess = createNodeProcess();
    // Rebound as a local because webpack rewrites import bindings — the
    // bare name must survive in scope for eval'd cell code that uses it.
    const pathModule = importedPathModule;
    const renderReact = (element: React.ReactNode, selector = '#root') => {
        const host = container.querySelector(selector);
        if (!host) {
            throw new Error(`React mount target \`${selector}\` was not found. Add matching HTML or use the default #root.`);
        }
        reactRoot?.unmount();
        reactRoot = createCellRoot(host);
        reactRoot.render(element);
    };
    const loopFailure = createLoopFailure();

    /**
     * Runs notebook or addon code with a direct eval, so it sees this
     * function's locals (see the header) plus the cell-scoped page globals
     * declared here. The sourceURL suffix lets an error the code throws later
     * be traced back to this cell.
     */
    const evalCellCode = (code: string): unknown => {
        // Unused as far as the type checker can tell: they exist for the eval.
        // (A minifier keeps every binding in a scope that contains a direct eval.)
        const { document, window, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame, cancelAnimationFrame } = cellScope;
        const __webnbNow = Date.now;
        const __webnbLoopFail = loopFailure;
        cellScope.markActive();
        return eval(code + cellScope.sourceUrlComment);
    };

    /**
     * An error thrown while a cell's test code runs. When an earlier check
     * already failed, the throw is almost always that same failure one step
     * later (an element the test needs is missing), so the learner is pointed
     * at the first failure rather than at a stack trace.
     */
    const reportScriptError = (error: unknown, what: string) => {
        const earlierFailure = Array.from(feedback.children).some(child => child.classList.contains('error'));
        appendFeedback(earlierFailure
            ? 'The remaining checks could not run until the ones above pass.'
            : `Error in ${what}: ${error}`, 'error');
    };

    // Code cells get their action strip (View solution / Reset code) before the
    // dispatch below, so a cell whose code throws still shows its actions.
    if (language === 'html' || language === 'css' || runtimeLanguageKind) {
        renderCellActions({
            host: widgetHost,
            language,
            source,
            defaultSource,
            hasDefault: hasAddon(activeAddons, 'default'),
            solution: solutionAddon?.content,
            reveal,
            onReset: value.cellUri && typeof context.postMessage === 'function'
                ? () => {
                    postToHost({
                        type: 'webnb.resetCellSource',
                        cellUri: value.cellUri
                    });
                }
                : undefined
        });
    }

    if (language === 'html') {
        container.innerHTML = source;
        htmlConsoleCleanup = attachHtmlConsoleCapture(container, recordConsoleMessage);

        if (activeAddons.some(addon => isScriptAddon(addon.type))) {
            feedback.innerHTML = '';
        }
        for (const { type, content } of activeAddons) {
            if (isScriptAddon(type)) {
                try {
                    evalCellCode(content);
                } catch (error) {
                    reportScriptError(error, 'test code');
                }
            } else if (isCssAddon(type)) {
                addStyle(content);
            }
        }

    } else if (language === 'css') {
        addStyle(source);
        for (const { type, content } of activeAddons) {
            if (isHtmlAddon(type)) {
                container.innerHTML = content;
            } else if (isCssAddon(type)) {
                addStyle(content);
            } else if (isScriptAddon(type)) {
                try {
                    evalCellCode(content);
                } catch (error) {
                    reportScriptError(error, 'test code');
                }
            }
        }
    } else if (isExternalCheckLanguage(language)) {
        const parsedChecklist = parseFileChecklistSource(source);
        const results = parsedChecklist.checks.map(parsedCheck => checkApi.createChecklistSourceResult(parsedCheck));
        for (const error of parsedChecklist.errors) {
            results.push(createFileResult(error, false, error));
        }
        for (const { type, content } of activeAddons) {
            if (isScriptAddon(type)) {
                try {
                    evalCellCode(content);
                } catch (error) {
                    results.push(createFileResult(`Error in external check test: ${error}`, false, `${error}`));
                }
            }
        }
        const deferred = checkApi.getDeferred();
        results.push(...deferred.results);

        // Re-checking needs the host; without it, do not promise a re-check.
        const canRefresh = !!value.cellUri && typeof context.postMessage === 'function';
        const shouldRefresh = results.length > 0 && !terminalConfig && canRefresh;
        const allPassed = addChecklistFeedback(results, parsedChecklist.title || deferred.title, {
            checkedAt: value.checkedAt,
            intervalMs: parsedChecklist.intervalMs,
            autoRefresh: shouldRefresh
        });

        refreshCleanup = shouldRefresh ? scheduleChecklistRefresh(allPassed, parsedChecklist.intervalMs) : undefined;
    } else if (language === 'walkthrough') {
        const parsedWalkthrough = parseWalkthroughSource(source);
        const canOpenFiles = typeof value.cellUri === 'string' && typeof context.postMessage === 'function';
        const openFile = canOpenFiles
            ? (path: string, line?: number) => {
                postToHost({
                    type: 'webnb.openWorkspaceFile',
                    cellUri: value.cellUri,
                    path,
                    line
                });
            }
            : undefined;
        // Hovering a step highlights the lines it shows in any editor that already
        // has the file open, narrowing to one line over the code; no path clears it.
        walkthroughHoverBridge = canOpenFiles
            ? createWalkthroughHoverBridge(focus => {
                postToHost({
                    type: 'webnb.highlightWorkspaceLines',
                    cellUri: value.cellUri,
                    path: focus?.path,
                    ranges: focus?.ranges,
                    line: focus?.line
                });
            })
            : undefined;
        renderParsedWalkthrough(container, parsedWalkthrough, files, {
            openFile,
            hover: walkthroughHoverBridge
        });
        if (parsedWalkthrough.watchIntervalMs > 0) {
            // Re-run the cell periodically so the snippets track the real files
            // while a learner edits them (same mechanism external checks use).
            refreshCleanup = scheduleChecklistRefresh(false, parsedWalkthrough.watchIntervalMs);
        }
    } else if (language === 'mcq') {
        renderMcqCell({
            container,
            source,
            addons: activeAddons,
            shuffleSeedSource: `${value.cellUri || ''}\n${source}`,
            reveal,
            solutionContent: solutionAddon?.content,
            addFeedback,
            persistSelection: value.cellUri && typeof context.postMessage === 'function'
                ? content => {
                    postToHost({
                        type: 'webnb.upsertCellAddon',
                        cellUri: value.cellUri,
                        addonType: 'selection',
                        content
                    });
                }
                : undefined
        });
    } else if (getRuntimeLanguageKind(language)) {
        for (const { type, content } of activeAddons) {
            if (isHtmlAddon(type)) {
                container.innerHTML = content;
            } else if (isCssAddon(type)) {
                addStyle(content);
            }
        }

        const isReactLanguage = runtimeLanguageKind === 'react';
        const isNodeLanguage = runtimeLanguageKind === 'node';
        if (isReactLanguage && !container.firstElementChild) {
            container.innerHTML = '<div id="root"></div>';
        }

        const runCompiledCode = (compiledCode: string) => {
            const nodeModule: { exports: unknown } = { exports: {} };

            // One record defines the sandbox: new Function takes its keys as the
            // parameter names and its values positionally, so the two lists
            // cannot drift out of sync.
            const sandboxScope: Record<string, unknown> = {
                console,
                document: cellScope.document,
                window: cellScope.window,
                setTimeout: cellScope.setTimeout,
                clearTimeout: cellScope.clearTimeout,
                setInterval: cellScope.setInterval,
                clearInterval: cellScope.clearInterval,
                requestAnimationFrame: cellScope.requestAnimationFrame,
                cancelAnimationFrame: cellScope.cancelAnimationFrame,
                assert,
                assertRule,
                wrap,
                check,
                checklist,
                file,
                files,
                source,
                cy: sy,
                defaultSource,
                terminal,
                renderReact,
                React,
                ReactDOM,
                require: runtimeRequire,
                process: nodeProcess,
                module: nodeModule,
                exports: nodeModule.exports,
                __dirname: '.',
                __filename: 'cell.js',
                __webnbNow: Date.now,
                __webnbLoopFail: loopFailure
            };
            const execute = new Function(...Object.keys(sandboxScope), wrapInBlock(compiledCode) + cellScope.sourceUrlComment);
            cellScope.markActive();
            execute(...Object.values(sandboxScope));

            return nodeModule.exports;
        };

        try {
            // A referenced JavaScript cell (`+id=name`) runs first, the way an
            // earlier <script> tag would: Course 3 teaches that "a library is
            // just a script file that ran before yours". Tests and other script
            // addons run after the cell's code.
            let prelude = '';
            let toEval = source;
            let hasTestAddon = false;
            for (const { type, content, id } of activeAddons) {
                if (!isScriptAddon(type)) {
                    continue;
                }
                if (id) {
                    prelude += content + '\n\n';
                } else {
                    toEval += '\n\n' + content;
                    hasTestAddon = true;
                }
            }
            toEval = prelude + toEval;
            if (hasTestAddon) {
                feedback.innerHTML = '';
            }
            const hasModuleSyntax = /(^|\n)\s*(import|export)[\s{]/m.test(toEval);
            // `import('x')` is a call expression rather than a statement, so it
            // can sit anywhere in a line (`await import(...)`) and the test
            // above misses it. Left uncompiled it reaches the browser's own
            // module resolver, which knows nothing of the notebook's `require`
            // shim and rejects every bare specifier with "Failed to resolve
            // module specifier". Compiling it routes the load through the shim
            // instead, so the modules this runtime provides resolve and an
            // unavailable one reports the runtime's own explanation.
            const hasDynamicImport = /\bimport\s*\(/.test(toEval);
            const needsModuleTransform = hasModuleSyntax || hasDynamicImport;
            const shouldCompileWithBabel = isReactLanguage || needsModuleTransform;
            // Guard every loop against running forever (see loopGuard.ts).
            const guarded = insertLoopGuards(toEval, { jsx: isReactLanguage, module: needsModuleTransform });

            if (shouldCompileWithBabel) {
                const babelOptions: Record<string, unknown> = {};
                if (isReactLanguage) {
                    // Use the classic JSX runtime so JSX compiles to
                    // `React.createElement`, resolved against the injected `React`
                    // global. Babel's default (automatic) runtime instead injects
                    // `import { jsx } from "react/jsx-runtime"`; when the cell has no
                    // other module syntax that import is never transformed to
                    // CommonJS and blows up inside `new Function` (WebKit:
                    // "import call expects one or two arguments"; V8: "Cannot use
                    // import statement outside a module").
                    babelOptions.presets = [['react', { runtime: 'classic' }]];
                }
                if (needsModuleTransform) {
                    // transform-dynamic-import turns `import(x)` into
                    // `Promise.resolve().then(() => require(x))`, keeping the
                    // promise semantics the lessons teach. It only runs
                    // alongside a modules transform, which is why both are
                    // listed together.
                    babelOptions.plugins = hasDynamicImport
                        ? ['transform-modules-commonjs', 'transform-dynamic-import']
                        : ['transform-modules-commonjs'];
                }

                const transformed = Babel.transform(guarded, babelOptions as any)?.code;
                if (!transformed) {
                    const compileTarget = isReactLanguage ? 'React' : 'module';
                    addFeedback(`${compileTarget} code could not be compiled.`, 'error');
                    return cleanup;
                }

                runCompiledCode(transformed);
            } else if (isNodeLanguage) {
                runCompiledCode(guarded);
            } else {
                evalCellCode(guarded);
            }
        } catch (error) {
            const runtimeName = runtimeLanguageKind === 'react' ? 'React' : runtimeLanguageKind === 'node' ? 'Node' : 'JavaScript';
            reportScriptError(error, `${runtimeName} code`);
        }
    } else {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = `mime type: ${mime}\n\n${JSON.stringify(value, null, 2)}`;
        pre.appendChild(code);
        container.appendChild(pre);
    }

    return cleanup;
}
