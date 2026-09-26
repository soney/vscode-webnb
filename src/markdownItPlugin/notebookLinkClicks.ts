/**
 * Takes over clicks on links between notebooks.
 *
 * VS Code already opens a plain `[text](other.webnb)` link, but on its own terms:
 * the `#section` part is dropped, and the target opens under a URI carrying the
 * fragment, which leaves two notebook documents alive for one file. A `#section`
 * link inside one notebook fares worse -- VS Code scrolls the webview by an
 * offset computed from its own absolute layout, which overshoots the cell list.
 *
 * So the click is caught here instead and handed to the extension host, which
 * opens the notebook and reveals the section through the notebook editor API.
 * The listener is capture-phase on `document` and VS Code's is bubble-phase on
 * `document.body`, so this one runs first and stops the click from reaching it.
 *
 * Two kinds of click are left alone:
 *  - Anything in a notebook that is not a Web Notebook. This renderer extends
 *    VS Code's markdown renderer, which every notebook type uses, so nothing is
 *    intercepted until the extension host confirms the notebook type (see
 *    LINK_HANDLER_HELLO_MESSAGE). A Jupyter notebook keeps VS Code's behavior.
 *  - Links inside a learner's own rendered output (`data-webnb-learner-output`,
 *    set by render()): a tab widget's `<a href="#settings">` belongs to the
 *    learner's page, not to the notebook.
 */
import {
    isLinkHandlerConfigMessage,
    LEARNER_OUTPUT_ATTRIBUTE,
    LINK_HANDLER_HELLO_MESSAGE,
    OPEN_NOTEBOOK_LINK_MESSAGE,
    parseNotebookLinkHref
} from '../shared/notebookLinks';

const PRIMARY_BUTTON = 0;

type MessageEvent = (listener: (message: unknown) => void) => { dispose(): void } | void;

export function installNotebookLinkClicks(postMessage: (message: unknown) => void, onDidReceiveMessage?: MessageEvent): void {
    let enabled = false;
    onDidReceiveMessage?.(message => {
        if (isLinkHandlerConfigMessage(message)) {
            enabled = message.enabled;
        }
    });
    postMessage({ type: LINK_HANDLER_HELLO_MESSAGE });

    document.addEventListener('click', (event) => {
        if (!enabled || event.button !== PRIMARY_BUTTON || event.defaultPrevented) {
            return;
        }

        // A markup cell renders inside a shadow root, so the anchor is only
        // reachable through the composed path -- `event.target` is the host.
        const path = event.composedPath();
        if (path.some(node => node instanceof Element && node.hasAttribute(LEARNER_OUTPUT_ATTRIBUTE))) {
            return;
        }
        const anchor = path.find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
        if (!anchor) {
            return;
        }

        // The attribute, not `.href`: the DOM property is already resolved
        // against the webview's own origin, which says nothing about the link.
        const target = parseNotebookLinkHref(anchor.getAttribute('href') ?? '');
        if (!target) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        // VS Code's handler is on `document.body`; a renderer that also listens
        // in capture must not get this click either.
        event.stopImmediatePropagation();

        postMessage({
            type: OPEN_NOTEBOOK_LINK_MESSAGE,
            href: anchor.getAttribute('href') ?? '',
            path: target.path,
            section: target.section
        });
    }, true);
}
