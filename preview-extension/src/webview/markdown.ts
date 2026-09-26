/**
 * Markdown rendering for markup cells.
 *
 * VS Code renders markup cells with its built-in engine; here we reuse the
 * renderer's own markdown pipeline (image-size syntax, highlighted fences,
 * smartypants), so a markup cell in the preview looks like the one in the
 * notebook. Relative media then has to be pointed at the workspace, because a
 * webview cannot load a file path directly.
 */
import { marked } from 'marked';

export { renderMarkdownBlock } from '@webnb/client/markdown';

/**
 * The attribute a clickable element carries its source line in, counted from
 * the cell's first line. Relative on purpose: a cell whose text is unchanged
 * keeps its DOM when lines are added above it, and an absolute line baked in
 * at render time would then point at the wrong place. The click adds the
 * cell's current start line.
 */
export const SOURCE_LINE_OFFSET_ATTRIBUTE = 'data-webnb-line-offset';

/**
 * The source line each rendered block starts on, relative to the cell, so a
 * click lands on the paragraph you pointed at rather than the top of the cell.
 *
 * The lexer walks the same markdown `marked` just rendered, and every token
 * carries the `raw` text it consumed -- so counting newlines across tokens
 * gives each block's offset without re-implementing any markdown parsing. The
 * rendered children line up with the non-`space` tokens in order; if that
 * correspondence ever breaks, the unmatched elements simply go untagged and
 * fall back to the cell's own line.
 */
export function blockSourceLines(source: string): number[] {
    let tokens;
    try {
        tokens = marked.lexer(source);
    } catch {
        return []; // never let a lexer hiccup cost us the rendered cell
    }

    const offsets: number[] = [];
    let line = 0;
    for (const token of tokens) {
        const raw: string = (token as { raw?: string }).raw ?? '';
        // `space` tokens are the blank lines between blocks: they consume source
        // but render nothing, so they advance the counter without taking a slot.
        if (token.type !== 'space') {
            offsets.push(line);
        }
        line += (raw.match(/\n/g) ?? []).length;
    }
    return offsets;
}

/** Apply those offsets to the rendered blocks, in order. */
export function annotateBlockLines(container: HTMLElement, source: string): void {
    const offsets = blockSourceLines(source);
    const elements = Array.from(container.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement
    );
    elements.forEach((element, index) => {
        if (index < offsets.length) {
            element.setAttribute(SOURCE_LINE_OFFSET_ATTRIBUTE, String(offsets[index]));
        }
    });
}

export interface AssetResolver {
    /** Webview URI of the folder holding the notebook, without a trailing slash. */
    base: string;
    /** Bumped when workspace files change, to bust the webview's image cache. */
    version: number;
}

function isExternalUrl(url: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#');
}

/** Resolve a notebook-relative path against the webview's asset base. */
function resolveAssetUrl(resolver: AssetResolver, relativePath: string): string {
    try {
        const url = new URL(relativePath, `${resolver.base}/`);
        url.searchParams.set('webnbAssetVersion', String(resolver.version));
        return url.toString();
    } catch {
        return relativePath;
    }
}

/**
 * Point relative media at the workspace through the webview asset base, and tag
 * relative links -- another notebook (`other.webnb#section`, `../x.webnb`,
 * `%20`-encoded names), a section of this one (`#section`), a workspace file --
 * so a click is handed to the extension host, which resolves it the way the
 * notebook does (src/shared/notebookLinks.ts), instead of navigating the
 * preview away from itself.
 */
export function resolveRelativeAssets(container: HTMLElement, resolver: AssetResolver): void {
    const mediaSelectors = 'img[src], source[src], video[src], audio[src], track[src]';
    container.querySelectorAll<HTMLElement>(mediaSelectors).forEach(element => {
        const src = element.getAttribute('src');
        if (!src || isExternalUrl(src) || src.startsWith('/')) {
            return;
        }
        element.setAttribute('src', resolveAssetUrl(resolver, src));
        if (element instanceof HTMLImageElement) {
            element.loading = 'lazy';
        }
    });

    container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(element => {
        const href = element.getAttribute('href') || '';
        if (/^https?:/i.test(href)) {
            element.target = '_blank';
            element.rel = 'noopener noreferrer';
            return;
        }
        // Other schemes (mailto:, command:, ...) keep the webview's behavior.
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
            return;
        }
        element.dataset.webnbLink = href;
        element.removeAttribute('href');
        element.classList.add('webnb-workspace-link');
        element.tabIndex = 0;
    });
}
