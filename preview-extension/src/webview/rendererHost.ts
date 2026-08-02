/**
 * Hosts the notebook renderer for one cell output.
 *
 * This mounts through the extension's own createCellMount -- the same shadow
 * root, the same stylesheets, the same #root/#html-output/.feedback/.console
 * structure the VS Code renderer entrypoint builds -- and so calls the same
 * render(). That is what makes the preview match the notebook editor instead of
 * merely resembling it.
 */
import { createCellMount, type CellMount } from '@webnb/client/mountRenderer';
import { WEBNB_OUTPUT_MIME, type WebnbOutputValue, type WebNbRendererMessage } from '@webnb/shared/protocol';
import styleCss from '@webnb/client/style.css';
import highlightCss from '@webnb/client/syntaxHighlight.css';
import xtermCss from '@xterm/xterm/css/xterm.css';

export interface PreviewRendererContext {
    postMessage(message: WebNbRendererMessage): void;
}

function renderError(root: HTMLElement, error: unknown): void {
    root.innerHTML = '';
    const box = document.createElement('pre');
    box.className = 'webnb-render-error';
    box.textContent = `Renderer error:\n${error instanceof Error ? (error.stack || error.message) : String(error)}`;
    root.append(box);
}

/** Surface a thrown render inline, instead of breaking the rest of the page. */
function wrapErrors(root: HTMLElement, fn: () => void): void {
    try {
        fn();
    } catch (error) {
        renderError(root, error);
        console.error('[webnb-preview] render failed', error);
    }
}

export class CellOutputHost {
    private readonly mount: CellMount;

    constructor(host: HTMLElement, private readonly context: PreviewRendererContext) {
        this.mount = createCellMount(host, {
            cssText: `${xtermCss}\n${highlightCss}\n${styleCss}`,
            wrapRender: wrapErrors
        });
    }

    render(value: WebnbOutputValue): void {
        this.mount.render(value, WEBNB_OUTPUT_MIME, this.context);
    }

    dispose(): void {
        this.mount.dispose();
    }
}
