/**
 * Markdown rendering for markup cells.
 *
 * In VS Code, markup cells are rendered by the built-in markdown engine. Here we
 * use the same `marked` + `smartypants` combination the renderer uses for inline
 * markdown, then rewrite relative media URLs (e.g. images) to the dev server's
 * asset endpoint so they load.
 */
import { marked } from 'marked';
import smartypants from 'smartypants';
import { assetUrl } from './api';
import { installMarkedImageSize } from '../../src/client/markedImageSize';
import { renderCodeBlockHtml } from '../../src/client/syntaxHighlight';

const SMARTYPANTS_ATTR = '2';

// Teach marked the `![alt](url =WIDTHxHEIGHT)` image-size syntax.
installMarkedImageSize();

// Syntax-highlight fenced code blocks, which VS Code's built-in markdown
// engine does for markup cells. A non-runnable fence (```js without braces)
// parses into a markup cell holding just that fence, so this is what colors
// the read-only code samples a notebook shows.
//
// render.ts registers the same renderer on this shared `marked` instance; both
// are declared because either module may be the one loaded, and re-registering
// an identical renderer is a no-op in effect.
marked.use({ renderer: { code: renderCodeBlockHtml } });

export function renderMarkdownBlock(text: string): string {
    const html = marked.parse(text) as string;
    return smartypants(html, SMARTYPANTS_ATTR);
}

function isAbsoluteUrl(url: string): boolean {
    return (
        /^[a-z][a-z0-9+.-]*:/i.test(url) || // scheme: http:, data:, mailto:, etc.
        url.startsWith('//') ||
        url.startsWith('/') ||
        url.startsWith('#')
    );
}

/** Join a notebook-relative directory with a relative path, collapsing ./ and ../ */
function posixJoin(dir: string, rel: string): string {
    const parts: string[] = [];
    for (const segment of `${dir}/${rel}`.split('/')) {
        if (!segment || segment === '.') { continue; }
        if (segment === '..') { parts.pop(); } else { parts.push(segment); }
    }
    return parts.join('/');
}

/**
 * Rewrite relative media URLs inside a rendered markup container to load assets
 * from the workspace via the dev server. `notebookDir` is the notebook's
 * workspace-relative directory.
 */
export function resolveRelativeAssets(container: HTMLElement, notebookDir: string): void {
    const mediaSelectors = 'img[src], source[src], video[src], audio[src], track[src]';
    container.querySelectorAll<HTMLElement>(mediaSelectors).forEach(el => {
        const src = el.getAttribute('src');
        if (!src || isAbsoluteUrl(src)) { return; }
        el.setAttribute('src', assetUrl(posixJoin(notebookDir, src)));
        if (el instanceof HTMLImageElement) {
            el.loading = 'lazy';
        }
    });

    // Open external links in a new tab; neutralize relative links (they would
    // otherwise navigate away from the single-page preview).
    container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(el => {
        const href = el.getAttribute('href') || '';
        if (/^https?:/i.test(href)) {
            el.target = '_blank';
            el.rel = 'noopener noreferrer';
        }
    });
}
