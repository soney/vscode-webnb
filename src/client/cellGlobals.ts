/**
 * The page globals a cell's code sees: `document`, `window`, and the timer
 * functions.
 *
 * A cell's output lives in a shadow root inside a webview that every other
 * cell shares, so the real globals are wrong for cell code in three ways:
 *  - the real document cannot see into the cell, so `document.querySelector`
 *    finds nothing and `window.document === document` is false;
 *  - whatever the code leaves running (an interval, a window listener, an
 *    animation loop) outlives the run and piles up again on every re-run;
 *  - an error thrown later, from a timer or a listener or a rejected promise,
 *    lands in the webview's devtools, where no learner will ever look.
 *
 * These stand-ins fix all three: DOM queries resolve inside the cell (element
 * creation still uses the real document), every timer and global listener is
 * tracked so the next run or disposal clears it, and asynchronous errors are
 * routed to the cell's own console. Writes to `window` still reach the real
 * global, because inline handlers in a cell's markup (`oninput="f(this)"`)
 * look names up there.
 */

export type AsyncErrorKind = 'uncaught' | 'promise';

export interface CellGlobalsOptions {
    /** The cell's output container: DOM queries resolve inside it. */
    root: HTMLElement;
    /** Shows an error thrown asynchronously by this cell's code. */
    reportError: (error: unknown, kind: AsyncErrorKind) => void;
    /** The cell's console, which `window.console` should also be. */
    console?: unknown;
}

export interface CellGlobals {
    document: Document;
    window: Window & typeof globalThis;
    setTimeout: typeof window.setTimeout;
    // Spelled out rather than `typeof window.clearTimeout`: under @types/node
    // (which the preview extension compiles this with) that type is Node's.
    clearTimeout: (id?: number) => void;
    setInterval: typeof window.setInterval;
    clearInterval: (id?: number) => void;
    requestAnimationFrame: typeof window.requestAnimationFrame;
    cancelAnimationFrame: typeof window.cancelAnimationFrame;
    /**
     * Appended to every piece of code the cell evaluates, so a stack trace
     * from an asynchronous error can be traced back to this cell.
     */
    sourceUrlComment: string;
    /** Marks this cell as the one currently running code. */
    markActive(): void;
    /** Clears every timer and global listener; asynchronous errors stop routing here. */
    dispose(): void;
}

/** Events that happen to the page as a whole rather than to one element. */
const PAGE_EVENT_TYPES = new Set([
    'keydown', 'keyup', 'keypress',
    'mousemove', 'pointermove', 'touchmove', 'wheel', 'scroll',
    'visibilitychange', 'selectionchange', 'readystatechange', 'fullscreenchange',
    'copy', 'cut', 'paste'
]);

/** Already past by the time any cell code runs; a listener for one is called right away. */
const LOADED_EVENT_TYPES = new Set(['DOMContentLoaded', 'load']);

/** UI events that mark a cell active, so a rejection from its handler routes to it. */
const ACTIVITY_EVENT_TYPES = ['click', 'input', 'change', 'submit', 'keydown', 'pointerdown'];

const SOURCE_URL_PATTERN = /webnb-cell-(\d+)\.js/;

let nextScopeId = 0;
let lastActiveScopeId: string | undefined;
const reporters = new Map<string, (error: unknown, kind: AsyncErrorKind) => void>();
let routingInstalled = false;

function scopeIdFrom(text: unknown): string | undefined {
    return typeof text === 'string' ? SOURCE_URL_PATTERN.exec(text)?.[1] : undefined;
}

function stackOf(value: unknown): unknown {
    return value && typeof value === 'object' && 'stack' in value ? (value as { stack?: unknown }).stack : undefined;
}

/**
 * One pair of window listeners for the whole webview, routing each error to
 * the cell whose code threw it. An Error carries a stack naming the cell's
 * `sourceURL`; a bare rejected value (`Promise.reject('network down')`) carries
 * nothing, and goes to the cell that most recently ran code.
 */
function installErrorRouting(): void {
    if (routingInstalled) {
        return;
    }
    routingInstalled = true;

    window.addEventListener('error', event => {
        const id = scopeIdFrom(stackOf(event.error)) ?? scopeIdFrom(event.filename);
        const report = id === undefined ? undefined : reporters.get(id);
        if (report) {
            event.preventDefault();
            report(event.error ?? event.message, 'uncaught');
        }
    });

    window.addEventListener('unhandledrejection', event => {
        const id = scopeIdFrom(stackOf(event.reason)) ?? lastActiveScopeId;
        const report = id === undefined ? undefined : reporters.get(id);
        if (report) {
            event.preventDefault();
            report(event.reason, 'promise');
        }
    });
}

type Listener = EventListenerOrEventListenerObject;

interface TrackedListener {
    target: EventTarget;
    type: string;
    listener: Listener;
    wrapped: EventListener;
    capture: boolean;
}

function isCapture(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
    return typeof options === 'boolean' ? options : !!options?.capture;
}

/** Names of window/document functions that must not be bound: constructors keep their prototype. */
function isConstructorName(property: PropertyKey): boolean {
    return typeof property === 'string' && /^[A-Z]/.test(property);
}

/** Own keys only: a lookup must never land on `Object.prototype.toString`. */
function ownOverride(overrides: Record<string, () => unknown>, property: PropertyKey): (() => unknown) | undefined {
    return typeof property === 'string' && Object.prototype.hasOwnProperty.call(overrides, property)
        ? overrides[property]
        : undefined;
}

export function createCellGlobals({ root, reportError, console: cellConsole }: CellGlobalsOptions): CellGlobals {
    installErrorRouting();

    const scopeId = String(nextScopeId++);
    reporters.set(scopeId, reportError);
    const markActive = () => {
        lastActiveScopeId = scopeId;
    };

    let disposed = false;
    const timeouts = new Set<number>();
    const intervals = new Set<number>();
    const frames = new Set<number>();
    const listeners: TrackedListener[] = [];
    const realWindow = window;
    const realDocument = window.document;

    const invoke = (callback: Function, thisArg: unknown, args: unknown[]) => {
        if (disposed) {
            return undefined;
        }
        markActive();
        try {
            return callback.apply(thisArg, args);
        } catch (error) {
            reportError(error, 'uncaught');
            return undefined;
        }
    };

    const scopedSetTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (disposed) {
            return 0;
        }
        if (typeof handler !== 'function') {
            return realWindow.setTimeout(handler, timeout, ...args);
        }
        const id = realWindow.setTimeout(() => {
            timeouts.delete(id);
            invoke(handler, realWindow, args);
        }, timeout);
        timeouts.add(id);
        return id;
    }) as typeof window.setTimeout;

    const scopedSetInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (disposed) {
            return 0;
        }
        if (typeof handler !== 'function') {
            return realWindow.setInterval(handler, timeout, ...args);
        }
        const id = realWindow.setInterval(() => invoke(handler, realWindow, args), timeout);
        intervals.add(id);
        return id;
    }) as typeof window.setInterval;

    // Timeouts and intervals share one id space, so either clear works on both.
    const scopedClearTimeout = (id?: number) => {
        if (id !== undefined) {
            timeouts.delete(id);
            intervals.delete(id);
        }
        realWindow.clearTimeout(id);
    };
    const scopedClearInterval = (id?: number) => {
        if (id !== undefined) {
            timeouts.delete(id);
            intervals.delete(id);
        }
        realWindow.clearInterval(id);
    };

    const scopedRequestAnimationFrame = (callback: FrameRequestCallback) => {
        if (disposed) {
            return 0;
        }
        const id = realWindow.requestAnimationFrame(time => {
            frames.delete(id);
            invoke(callback, realWindow, [time]);
        });
        frames.add(id);
        return id;
    };
    const scopedCancelAnimationFrame = (id: number) => {
        frames.delete(id);
        realWindow.cancelAnimationFrame(id);
    };

    const wrapListener = (listener: Listener): EventListener => function (this: unknown, event: Event) {
        const callback = typeof listener === 'function' ? listener : listener.handleEvent;
        const thisArg = typeof listener === 'function' ? this : listener;
        return invoke(callback, thisArg, [event]);
    };

    const addListener = (target: EventTarget, type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) => {
        if (!listener || disposed) {
            return;
        }
        const capture = isCapture(options);
        if (listeners.some(entry => entry.target === target && entry.type === type && entry.listener === listener && entry.capture === capture)) {
            return;
        }
        const wrapped = wrapListener(listener);
        listeners.push({ target, type, listener, wrapped, capture });
        target.addEventListener(type, wrapped, options);
    };

    const removeListener = (target: EventTarget, type: string, listener: Listener | null, options?: boolean | EventListenerOptions) => {
        if (!listener) {
            return;
        }
        const capture = isCapture(options);
        const index = listeners.findIndex(entry => entry.target === target && entry.type === type && entry.listener === listener && entry.capture === capture);
        if (index >= 0) {
            const [entry] = listeners.splice(index, 1);
            target.removeEventListener(type, entry.wrapped, options);
        }
    };

    /** The page has loaded long before any cell code runs, so call the listener now. */
    const callSoon = (type: string, listener: Listener) => {
        queueMicrotask(() => {
            if (!disposed) {
                const wrapped = wrapListener(listener);
                wrapped.call(realDocument, new Event(type));
            }
        });
    };

    const shadow = root.getRootNode() as ShadowRoot | Document;
    // Read lazily: an HTML cell's markup is inserted after these are made.
    let assignedTitle: string | undefined;
    const scopedCollection = (selector: string) => () => root.querySelectorAll(selector);

    const documentOverrides: Record<string, () => unknown> = {
        querySelector: () => (selectors: string) => root.querySelector(selectors),
        querySelectorAll: () => (selectors: string) => root.querySelectorAll(selectors),
        getElementById: () => (id: string) => root.querySelector(`#${CSS.escape(id)}`),
        getElementsByClassName: () => (names: string) => root.getElementsByClassName(names),
        getElementsByTagName: () => (name: string) => root.getElementsByTagName(name),
        getElementsByTagNameNS: () => (namespace: string | null, name: string) => root.getElementsByTagNameNS(namespace, name),
        getElementsByName: () => (name: string) => root.querySelectorAll(`[name="${CSS.escape(name)}"]`),
        // The cell's output stands in for <html>, <head> and <body>: what a
        // cell appends to the page shows up in its own output.
        body: () => root,
        head: () => root,
        documentElement: () => root,
        forms: scopedCollection('form'),
        images: scopedCollection('img'),
        links: scopedCollection('a[href], area[href]'),
        scripts: scopedCollection('script'),
        title: () => assignedTitle ?? root.querySelector('title')?.textContent ?? '',
        // A page with nothing focused reports its body; the cell is the body.
        activeElement: () => shadow.activeElement ?? root,
        elementFromPoint: () => (x: number, y: number) => shadow.elementFromPoint(x, y),
        elementsFromPoint: () => (x: number, y: number) => shadow.elementsFromPoint(x, y),
        getSelection: () => () => (shadow as unknown as { getSelection?: () => Selection | null }).getSelection?.() ?? realDocument.getSelection(),
        contains: () => (node: Node | null) => !!node && root.contains(node),
        defaultView: () => cellWindow,
        // document.write after load would wipe the whole webview, every cell
        // with it; appending to the cell is what a learner means by it.
        write: () => (...markup: string[]) => root.insertAdjacentHTML('beforeend', markup.join('')),
        writeln: () => (...markup: string[]) => root.insertAdjacentHTML('beforeend', markup.join('') + '\n'),
        open: () => () => cellDocument,
        close: () => () => undefined,
        addEventListener: () => (type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) => {
            if (listener && LOADED_EVENT_TYPES.has(type)) {
                callSoon(type, listener);
                return;
            }
            addListener(PAGE_EVENT_TYPES.has(type) ? realDocument : root, type, listener, options);
        },
        removeEventListener: () => (type: string, listener: Listener | null, options?: boolean | EventListenerOptions) => {
            removeListener(PAGE_EVENT_TYPES.has(type) ? realDocument : root, type, listener, options);
        }
    };

    const boundDocumentFunctions = new Map<PropertyKey, Function>();
    const cellDocument = new Proxy(realDocument, {
        get(target, property) {
            const override = ownOverride(documentOverrides, property);
            if (override) {
                return override();
            }
            const value = Reflect.get(target, property, target);
            if (typeof value === 'function' && !isConstructorName(property)) {
                let bound = boundDocumentFunctions.get(property);
                if (!bound) {
                    bound = value.bind(target);
                    boundDocumentFunctions.set(property, bound!);
                }
                return bound;
            }
            return value;
        },
        set(target, property, value) {
            if (property === 'title') {
                assignedTitle = String(value);
                return true;
            }
            return Reflect.set(target, property, value, target);
        }
    }) as Document;

    const windowOverrides: Record<string, () => unknown> = {
        document: () => cellDocument,
        window: () => cellWindow,
        self: () => cellWindow,
        globalThis: () => cellWindow,
        frames: () => cellWindow,
        setTimeout: () => scopedSetTimeout,
        clearTimeout: () => scopedClearTimeout,
        setInterval: () => scopedSetInterval,
        clearInterval: () => scopedClearInterval,
        requestAnimationFrame: () => scopedRequestAnimationFrame,
        cancelAnimationFrame: () => scopedCancelAnimationFrame,
        addEventListener: () => (type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) => {
            if (listener && LOADED_EVENT_TYPES.has(type)) {
                callSoon(type, listener);
                return;
            }
            addListener(realWindow, type, listener, options);
        },
        removeEventListener: () => (type: string, listener: Listener | null, options?: boolean | EventListenerOptions) => {
            removeListener(realWindow, type, listener, options);
        }
    };
    if (cellConsole) {
        windowOverrides.console = () => cellConsole;
    }

    const boundWindowFunctions = new Map<PropertyKey, Function>();
    const cellWindow = new Proxy(realWindow, {
        get(target, property) {
            const override = ownOverride(windowOverrides, property);
            if (override) {
                return override();
            }
            const value = Reflect.get(target, property, target);
            if (typeof value === 'function' && !isConstructorName(property)) {
                let bound = boundWindowFunctions.get(property);
                if (!bound) {
                    bound = value.bind(target);
                    boundWindowFunctions.set(property, bound!);
                }
                return bound;
            }
            return value;
        },
        set(target, property, value) {
            // Reaches the real global on purpose: inline handlers in a cell's
            // markup resolve names there (`oninput="colorLab(this)"`).
            return Reflect.set(target, property, value, target);
        }
    }) as Window & typeof globalThis;

    // A handler the learner attached straight to an element is not wrapped, so
    // note which cell the interaction belongs to; a rejection it causes with a
    // bare value then still reaches the right console.
    for (const type of ACTIVITY_EVENT_TYPES) {
        root.addEventListener(type, markActive, true);
    }

    return {
        document: cellDocument,
        window: cellWindow,
        setTimeout: scopedSetTimeout,
        clearTimeout: scopedClearTimeout,
        setInterval: scopedSetInterval,
        clearInterval: scopedClearInterval,
        requestAnimationFrame: scopedRequestAnimationFrame,
        cancelAnimationFrame: scopedCancelAnimationFrame,
        sourceUrlComment: `\n//# sourceURL=webnb-cell-${scopeId}.js`,
        markActive,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const id of timeouts) {
                realWindow.clearTimeout(id);
            }
            for (const id of intervals) {
                realWindow.clearInterval(id);
            }
            for (const id of frames) {
                realWindow.cancelAnimationFrame(id);
            }
            timeouts.clear();
            intervals.clear();
            frames.clear();
            for (const entry of listeners.splice(0)) {
                entry.target.removeEventListener(entry.type, entry.wrapped, entry.capture);
            }
            for (const type of ACTIVITY_EVENT_TYPES) {
                root.removeEventListener(type, markActive, true);
            }
            reporters.delete(scopeId);
            if (lastActiveScopeId === scopeId) {
                lastActiveScopeId = undefined;
            }
        }
    };
}

/** How an asynchronous error reads in the cell's console, the way a browser prints it. */
export function describeAsyncError(error: unknown, kind: AsyncErrorKind): string {
    const prefix = kind === 'promise' ? 'Uncaught (in promise)' : 'Uncaught';
    if (error instanceof Error) {
        return `${prefix} ${error.name}: ${error.message}`;
    }
    if (typeof error === 'string') {
        return `${prefix} ${error}`;
    }
    try {
        return `${prefix} ${JSON.stringify(error)}`;
    } catch {
        return `${prefix} ${String(error)}`;
    }
}
