/**
 * Hosts the extension's notebook renderer for a single cell output.
 *
 * This mirrors index.ts (the extension's renderer entrypoint): it attaches a
 * shadow root, injects the same CSS, builds the #root / #html-output / feedback
 * / console / widget-host structure, and calls the *same* render() function the
 * VS Code notebook uses. That is what makes the preview match VS Code exactly.
 */
import { render } from '../../src/client/render';
import styleCss from '../../src/client/style.css?raw';
import xtermCss from '@xterm/xterm/css/xterm.css?raw';
import type { RendererMessage, WebnbOutputValue } from './types';

export const WEBNB_MIME = 'x-application/webnb-output';

export interface PreviewRendererContext {
    postMessage(message: RendererMessage): void;
}

function renderError(root: HTMLElement, error: unknown): void {
    root.innerHTML = '';
    const box = document.createElement('pre');
    box.className = 'webnb-render-error';
    box.textContent = `Renderer error:\n${error instanceof Error ? (error.stack || error.message) : String(error)}`;
    root.append(box);
}

/** Run renderer work, surfacing thrown errors inline instead of breaking the page. */
function wrapErrors(root: HTMLElement, fn: () => void): void {
    try {
        fn();
    } catch (error) {
        renderError(root, error);
        // eslint-disable-next-line no-console
        console.error('[webnb-preview] render failed', error);
    }
}

export class CellOutputHost {
    private readonly shadow: ShadowRoot;
    private readonly root: HTMLElement;
    private readonly style: HTMLStyleElement;
    private cleanup?: () => void;

    constructor(private readonly host: HTMLElement, private readonly context: PreviewRendererContext) {
        this.shadow = host.attachShadow({ mode: 'open' });
        this.style = document.createElement('style');
        this.style.setAttribute('type', 'text/css');
        this.style.textContent = `${xtermCss}\n${styleCss}`;
        this.shadow.append(this.style);

        const root = document.createElement('div');
        root.id = 'root';
        this.shadow.append(root);
        this.root = root;
    }

    render(value: WebnbOutputValue): void {
        wrapErrors(this.root, () => {
            this.cleanup?.();
            this.cleanup = undefined;
            this.root.innerHTML = '';

            const feedback = document.createElement('div');
            feedback.classList.add('feedback');
            const widgetHost = document.createElement('div');
            widgetHost.classList.add('widget-host');
            const consoleElement = document.createElement('div');
            consoleElement.classList.add('console');
            const node = document.createElement('div');
            node.setAttribute('id', 'html-output');
            this.root.append(node, widgetHost, feedback, consoleElement);

            const addStyle = (css: string) => {
                const styleEl = document.createElement('style');
                styleEl.setAttribute('type', 'text/css');
                styleEl.textContent = css;
                this.shadow.insertBefore(styleEl, this.root);
            };

            const next = render({
                feedback,
                container: node,
                mime: WEBNB_MIME,
                style: this.style,
                value,
                context: this.context as never,
                console: consoleElement,
                widgetHost,
                addStyle
            } as never);

            if (typeof next === 'function') {
                this.cleanup = next;
            }
        });
    }

    /** Whether this host currently shows any output. */
    hasOutput(): boolean {
        return !!this.root.querySelector('#html-output');
    }

    dispose(): void {
        this.cleanup?.();
        this.cleanup = undefined;
        this.root.innerHTML = '';
    }
}
