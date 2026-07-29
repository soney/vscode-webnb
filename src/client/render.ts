/**
 * The notebook renderer: turns a cell's output payload into DOM inside the
 * webview. render() dispatches on the cell language to the per-cell-type
 * modules (mcq, checks, terminal, walkthroughRender, ...) and owns the
 * lexical scope that evaluated notebook code sees.
 *
 * IMPORTANT: the bare eval() calls in the branches below deliberately expose
 * this function's local bindings (console, document, assert, assertRule, wrap,
 * check, checklist, file, createFileResult, files, source, cy, sy,
 * defaultSource, terminal, renderReact, pathModule, ...) to notebook and addon
 * code. Deep internals that were incidentally visible before the split
 * (terminal/console/check-DSL implementation helpers) are intentionally no
 * longer in scope. Renaming, moving, or removing
 * any of those locals is an API change for existing notebooks, invisible to
 * the type checker — keep the preview harness green across all languages.
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
import { createTerminalController, parseTerminalAddon } from './terminal';
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
    isCssAddon,
    isExternalCheckLanguage,
    isHtmlAddon,
    isScriptAddonType as isScriptAddon,
    isSolutionAddon,
    isTerminalAddon
} from '../shared/addons';
import * as Babel from '@babel/standalone';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
    // Solution addons never execute and stay hidden unless the cell's `reveal`
    // attribute opts into the reader-facing "View solution" control.
    const solutionAddon = Array.isArray(addons)
        ? addons.find((addon: Addon) => isSolutionAddon(addon.type))
        : undefined;
    const reveal = value.reveal === true;
    const activeAddons: Addon[] = Array.isArray(addons)
        ? addons.filter((addon: Addon) => !isSolutionAddon(addon.type))
        : [];
    const hasHtmlAddon = activeAddons.some(addon => isHtmlAddon(addon.type));
    const runtimeLanguageKind = getRuntimeLanguageKind(language);
    const shouldShowOutputContainer =
        language === 'css' ? hasHtmlAddon
            : runtimeLanguageKind === 'javascript' || runtimeLanguageKind === 'node' ? hasHtmlAddon
                : true;
    container.classList.toggle('webnb-output-empty', !shouldShowOutputContainer);
    const defaultSource = getAddonContent(activeAddons, 'default') ?? '';
    const deferChecklistRendering = isExternalCheckLanguage(language);
    const terminalAddon = activeAddons.find(addon => isTerminalAddon(addon.type));
    const terminalConfig = terminalAddon ? parseTerminalAddon(terminalAddon.content) : undefined;
    const terminalCellKey = typeof value.cellUri === 'string' ? value.cellUri : `webnb:${language}`;
    const terminalController = createTerminalController({
        widgetHost,
        cellKey: terminalCellKey,
        config: terminalConfig,
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
    const { console, recordConsoleMessage } = createCellConsole(consoleElement);
    const addChecklistFeedback = createChecklistFeedback(feedback);
    const checkApi = createCheckApi({
        files,
        terminal,
        didLog: expected => console.didLog(expected),
        addFeedback,
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
    function assert(selector: string) {
        const onResult = reportAssertion;
        // Browsers strip <html> and <body> when setting innerHTML on a div, so
        // these structural elements won't be found in the container. Parse the
        // source with DOMParser instead so document-structure assertions work.
        // The nodes are flagged `sourceOnly` so negated assertions ignore them:
        // this fallback only ever runs when the render matched nothing, which is
        // exactly when `not.exist` should pass, so letting it match would turn a
        // correct answer into a failure. DOMParser also synthesizes
        // <html>/<head>/<body> even when the source has none, so source matches
        // are no evidence at all that the learner wrote the element.
        if (language === 'html' && container.querySelectorAll(selector).length === 0) {
            const doc = new DOMParser().parseFromString(source, 'text/html');
            const nodes = Array.from(doc.querySelectorAll(selector)) as Element[];
            if (nodes.length > 0) {
                return cy(nodes, onResult, { sourceOnly: true });
            }
        }
        return cy(container, onResult).get(selector);
    }

    function assertRule(selector: string) {
        return cy.getRule(selector, reportAssertion);
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

    // Every exit path returns this same cleanup — a missed early return here
    // used to leak the xterm instance when compilation failed.
    const cleanup = () => {
        htmlConsoleCleanup?.();
        refreshCleanup?.();
        walkthroughHoverBridge?.dispose();
        reactRoot?.unmount();
        terminalController.dispose();
    };

    terminalController.mount();

    // Code cells get their action strip (View solution / Reset code) before the
    // dispatch below, so a cell whose code throws still shows its actions.
    if (language === 'html' || language === 'css' || runtimeLanguageKind) {
        renderCellActions({
            host: widgetHost,
            language,
            source,
            defaultSource,
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

        for (const { type, content } of activeAddons) {
            if (isScriptAddon(type)) {
                feedback.innerHTML = '';
                eval(content);
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
                eval(content);
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
                    eval(content);
                } catch (error) {
                    results.push(createFileResult(`Error in external check test: ${error}`, false, `${error}`));
                }
            }
        }
        const deferred = checkApi.getDeferred();
        results.push(...deferred.results);

        const shouldRefresh = results.length > 0 && !terminalConfig;
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

        const document = container;
        (document as any).body = container;

        const ReactDOM = { createRoot };
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
            reactRoot = createRoot(host as Element);
            reactRoot.render(element);
        };

        const runCompiledCode = (compiledCode: string) => {
            const nodeModule: { exports: unknown } = { exports: {} };

            // One record defines the sandbox: new Function takes its keys as the
            // parameter names and its values positionally, so the two lists
            // cannot drift out of sync.
            const sandboxScope: Record<string, unknown> = {
                console,
                document,
                window,
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
                __filename: 'cell.js'
            };
            const execute = new Function(...Object.keys(sandboxScope), compiledCode);
            execute(...Object.values(sandboxScope));

            return nodeModule.exports;
        };

        try {
            let toEval = source;
            let hasTestAddon = false;
            for (const { type, content } of activeAddons) {
                if (isScriptAddon(type)) {
                    toEval += '\n\n' + content;
                    hasTestAddon = true;
                }
            }
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

                const transformed = Babel.transform(toEval, babelOptions as any).code;
                if (!transformed) {
                    const compileTarget = isReactLanguage ? 'React' : 'module';
                    addFeedback(`${compileTarget} code could not be compiled.`, 'error');
                    return cleanup;
                }

                runCompiledCode(transformed);
            } else if (isNodeLanguage) {
                runCompiledCode(toEval);
            } else {
                eval(toEval);
            }
        } catch (error) {
            const runtimeName = runtimeLanguageKind === 'react' ? 'React' : runtimeLanguageKind === 'node' ? 'Node' : 'JavaScript';
            addFeedback(`Error in ${runtimeName} code: ${error}`, 'error');
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
