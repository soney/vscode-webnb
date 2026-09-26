/**
 * The DOM contract between a cell-output host and render(): a shadow root
 * carrying the renderer stylesheets, a #root holding the four elements
 * render() draws into (#html-output, .widget-host, .feedback, .console), and
 * cleanup bookkeeping between renders. The VS Code entrypoint (index.ts) and
 * the preview harness (rendererHost.ts) both mount through this, so the
 * structure cannot drift between them.
 */
import { render, type RendererHostContext } from './render';
import type { WebnbOutputValue } from '../shared/protocol';

export interface CellMountOptions {
    /** Full stylesheet text, injected once into the shadow root. */
    cssText: string;
    /**
     * Wraps each render pass; hosts surface thrown errors their own way. The
     * default shows the error inside the output (see showRenderError).
     */
    wrapRender?: (root: HTMLElement, fn: () => void) => void;
}

export interface CellMount {
    render(value: WebnbOutputValue, mime: string, context: RendererHostContext): void;
    dispose(): void;
}

/**
 * Shows a render failure where the output would have been. A throw that
 * reaches VS Code instead is written into the host element's light DOM, which
 * the shadow root hides: the learner would see a half-drawn output and nothing
 * to explain it.
 */
export function showRenderError(root: HTMLElement, error: unknown): void {
    const box = document.createElement('pre');
    box.className = 'webnb-render-error';
    box.textContent = `This output could not be displayed:\n${error instanceof Error ? error.message : String(error)}`;
    root.append(box);
    console.error('[webnb] render failed', error);
}

function renderShowingErrors(root: HTMLElement, fn: () => void): void {
    try {
        fn();
    } catch (error) {
        showRenderError(root, error);
    }
}

export function createCellMount(host: HTMLElement, { cssText, wrapRender }: CellMountOptions): CellMount {
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.textContent = cssText;
    shadow.append(style);

    const root = document.createElement('div');
    root.id = 'root';
    shadow.append(root);

    // The feedback pane outlives each render: it is a live region, and a
    // screen reader only announces changes to a region that was already on
    // the page, not a freshly inserted one.
    const feedback = document.createElement('div');
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    root.append(feedback);

    let cleanup: (() => void) | undefined;
    let drawn: Element[] = [];
    let addedStyles: HTMLStyleElement[] = [];

    const clear = () => {
        cleanup?.();
        cleanup = undefined;
        for (const element of drawn) {
            element.remove();
        }
        drawn = [];
        // A stylesheet the previous run added must not keep styling this one:
        // deleting a rule from the cell has to take effect on the next run.
        for (const element of addedStyles) {
            element.remove();
        }
        addedStyles = [];
        for (const stray of Array.from(root.children)) {
            if (stray !== feedback) {
                stray.remove();
            }
        }
        feedback.replaceChildren();
    };

    const renderInto = (value: WebnbOutputValue, mime: string, context: RendererHostContext): void => {
        clear();
        // A host's error handler may have emptied #root wholesale.
        if (feedback.parentNode !== root) {
            root.append(feedback);
        }

        const widgetHost = document.createElement('div');
        widgetHost.classList.add('widget-host');
        const consoleElement = document.createElement('div');
        consoleElement.classList.add('console');
        const node = document.createElement('div');
        node.setAttribute('id', 'html-output');
        root.insertBefore(node, feedback);
        root.insertBefore(widgetHost, feedback);
        root.append(consoleElement);
        drawn = [node, widgetHost, consoleElement];

        const addStyle = (css: string) => {
            const styleEl = document.createElement('style');
            styleEl.setAttribute('type', 'text/css');
            styleEl.textContent = css;
            shadow.insertBefore(styleEl, root);
            addedStyles.push(styleEl);
        };

        const next = render({
            feedback,
            container: node,
            mime,
            style,
            value,
            context,
            console: consoleElement,
            widgetHost,
            addStyle
        });
        if (typeof next === 'function') {
            cleanup = next;
        }
    };

    return {
        render(value, mime, context) {
            (wrapRender ?? renderShowingErrors)(root, () => renderInto(value, mime, context));
        },
        dispose() {
            clear();
        }
    };
}
