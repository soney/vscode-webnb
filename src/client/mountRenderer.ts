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
    /** Wraps each render pass; hosts surface thrown errors their own way. */
    wrapRender?: (root: HTMLElement, fn: () => void) => void;
}

export interface CellMount {
    render(value: WebnbOutputValue, mime: string, context: RendererHostContext): void;
    dispose(): void;
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

    let cleanup: (() => void) | undefined;

    const renderInto = (value: WebnbOutputValue, mime: string, context: RendererHostContext): void => {
        cleanup?.();
        cleanup = undefined;
        root.innerHTML = '';

        const feedback = document.createElement('div');
        feedback.classList.add('feedback');
        const widgetHost = document.createElement('div');
        widgetHost.classList.add('widget-host');
        const consoleElement = document.createElement('div');
        consoleElement.classList.add('console');
        const node = document.createElement('div');
        node.setAttribute('id', 'html-output');
        root.append(node, widgetHost, feedback, consoleElement);

        const addStyle = (css: string) => {
            const styleEl = document.createElement('style');
            styleEl.setAttribute('type', 'text/css');
            styleEl.textContent = css;
            shadow.insertBefore(styleEl, root);
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
            (wrapRender ?? ((_root, fn) => fn()))(root, () => renderInto(value, mime, context));
        },
        dispose() {
            cleanup?.();
            cleanup = undefined;
            root.innerHTML = '';
        }
    };
}
