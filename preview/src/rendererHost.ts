/**
 * Hosts the extension's notebook renderer for a single cell output.
 *
 * This uses the extension's own mountRenderer (the same shadow-root + CSS +
 * element structure index.ts mounts in VS Code) and calls the *same* render()
 * function the VS Code notebook uses. That is what makes the preview match
 * VS Code exactly.
 */
import { createCellMount, type CellMount } from '../../src/client/mountRenderer';
import { WEBNB_OUTPUT_MIME } from '../../src/shared/protocol';
import styleCss from '../../src/client/style.css?raw';
import highlightCss from '../../src/client/syntaxHighlight.css?raw';
import xtermCss from '@xterm/xterm/css/xterm.css?raw';
import type { RendererMessage, WebnbOutputValue } from './types';

export interface PreviewRendererContext {
    postMessage(message: RendererMessage): void;
}

/**
 * Adds the error below whatever the failed render drew. The root is not
 * cleared: the mount owns its children (the feedback pane may persist across
 * renders) and removes this box itself on the next render.
 */
function renderError(root: HTMLElement, error: unknown): void {
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
