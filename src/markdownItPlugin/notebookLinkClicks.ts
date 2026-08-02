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
 */
import { parseNotebookLinkHref, OPEN_NOTEBOOK_LINK_MESSAGE } from '../shared/notebookLinks';

const PRIMARY_BUTTON = 0;

export function installNotebookLinkClicks(postMessage: (message: unknown) => void): void {
    document.addEventListener('click', (event) => {
        if (event.button !== PRIMARY_BUTTON || event.defaultPrevented) {
            return;
        }

        // A markup cell renders inside a shadow root, so the anchor is only
        // reachable through the composed path -- `event.target` is the host.
        const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
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
