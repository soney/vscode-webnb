/**
 * Links from one notebook to another: the `[text](other.webnb#section)` grammar,
 * the section anchors those links point at, and the message the markdown
 * renderer sends the extension host when a reader clicks one.
 *
 * Dependency-free (no vscode, no DOM) on purpose. The renderer decides *whether*
 * a click is a notebook link with `parseNotebookLinkHref`, and the extension
 * host decides *where it goes* with `findSectionCell`; both sides read this file,
 * so a link can never mean one thing at click time and another at open time.
 */

export const WEBNB_FILE_EXTENSION = '.webnb';

/** Where a notebook link points. */
export interface NotebookLinkTarget {
    /**
     * The notebook the link names, as the author wrote it: relative to the
     * linking notebook, or absolute from the workspace root when it starts with
     * `/`. Empty for a link into the notebook the reader is already in.
     */
    path: string;
    /** The `#...` part, slugified; empty when the link names no section. */
    section: string;
}

/** The renderer asking the extension host to follow a notebook link. */
export interface WebNbOpenNotebookLinkMessage extends NotebookLinkTarget {
    type: 'webnb.openNotebookLink';
    /** The href as written, for error messages that quote the author's own text. */
    href: string;
}

export const OPEN_NOTEBOOK_LINK_MESSAGE = 'webnb.openNotebookLink';

export function isOpenNotebookLinkMessage(message: unknown): message is WebNbOpenNotebookLinkMessage {
    if (!message || typeof message !== 'object') {
        return false;
    }

    const candidate = message as Partial<WebNbOpenNotebookLinkMessage>;
    return candidate.type === OPEN_NOTEBOOK_LINK_MESSAGE
        && typeof candidate.path === 'string'
        && typeof candidate.section === 'string'
        && typeof candidate.href === 'string';
}

/**
 * VS Code's own heading-slug function, character for character (its notebook
 * markdown renderer uses this to build heading `id`s and to rewrite `#...`
 * links). Section anchors are matched against it, so a link written by hand and
 * the anchor VS Code renders can never disagree.
 */
export function slugifySection(text: string): string {
    return encodeURI(
        text.trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[\]\[\!\/\'\"\#\$\%\&\(\)\*\+\,\.\/\:\;\<\=\>\?\@\\\^\{\|\}\~\`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g, '')
            .replace(/^\-+/, '')
            .replace(/\-+$/, '')
    );
}

/**
 * Stands in for a backslash-escaped character while markup is being stripped.
 * A private-use code point, so it can never collide with real heading text.
 */
const ESCAPED = '\uE000';

/**
 * A heading's slug is built from the text a reader *sees*, so the markdown that
 * produced it has to come off first: `## The \`fetch\` API` is anchored at
 * `#the-fetch-api`, not at something containing backticks.
 */
export function headingDisplayText(markdown: string): string {
    return markdown
        // Escaped punctuation is literal text. Park it out of reach first, or
        // the emphasis rule below eats the asterisks in `\*not emphasis\*`.
        .replace(/\\([\\`*_{}[\]()#+\-.!])/g, (_match, character: string) =>
            ESCAPED + character.charCodeAt(0).toString(16).padStart(4, '0'))
        // Images contribute no text to a heading; links contribute their label.
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        // Code spans, then emphasis: `**bold**`, `*em*`, `__bold__`, `_em_`.
        .replace(/(`+)([\s\S]*?)\1/g, '$2')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(\*|_)(.*?)\1/g, '$2')
        .replace(new RegExp(ESCAPED + '([0-9a-f]{4})', 'g'), (_match, code: string) =>
            String.fromCharCode(parseInt(code, 16)))
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Splits a link's href into a notebook path and a section, or returns undefined
 * for anything that is not a notebook link -- an http URL, a link to a source
 * file, a `mailto:`. Those keep VS Code's own behavior; only what this returns
 * is taken over.
 */
export function parseNotebookLinkHref(href: string): NotebookLinkTarget | undefined {
    const trimmed = href.trim();
    if (!trimmed) {
        return undefined;
    }

    // Anything with a scheme (http:, mailto:, command:, file:) belongs to VS Code.
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        return undefined;
    }

    const hashIndex = trimmed.indexOf('#');
    const rawPath = hashIndex < 0 ? trimmed : trimmed.slice(0, hashIndex);
    const rawSection = hashIndex < 0 ? '' : trimmed.slice(hashIndex + 1);

    // A bare `#section` points inside the notebook the reader is already in.
    if (!rawPath) {
        return rawSection ? { path: '', section: slugifySection(decodeHref(rawSection)) } : undefined;
    }

    const path = decodeHref(rawPath);
    if (!path.toLowerCase().endsWith(WEBNB_FILE_EXTENSION)) {
        return undefined;
    }

    return { path, section: rawSection ? slugifySection(decodeHref(rawSection)) : '' };
}

/**
 * Markdown link destinations are percent-encoded by the time they reach the DOM
 * -- every notebook filename with a space in it arrives as `%20`. A destination
 * that is not valid encoding is taken at face value rather than thrown away.
 */
function decodeHref(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export interface NotebookSection {
    /** Index of the cell the heading is in. */
    cellIndex: number;
    slug: string;
    text: string;
    level: number;
}

/**
 * Every section a notebook offers as a link target: one per markdown heading, in
 * document order. `cellSources` is the notebook's cells in order, with a code
 * cell's entry left undefined -- headings only come from markdown.
 */
export function findSections(cellSources: ReadonlyArray<string | undefined>): NotebookSection[] {
    const sections: NotebookSection[] = [];

    cellSources.forEach((source, cellIndex) => {
        if (source === undefined) {
            return;
        }

        let inFence = false;
        let fenceMarker = '';
        for (const line of source.split(/\r?\n/g)) {
            const fence = line.match(/^\s*(`{3,}|~{3,})/);
            if (fence) {
                if (!inFence) {
                    inFence = true;
                    fenceMarker = fence[1][0];
                } else if (fence[1][0] === fenceMarker) {
                    inFence = false;
                }
                continue;
            }
            if (inFence) {
                continue;
            }

            // ATX headings only: `## Title`. Setext underlines are not used in
            // any notebook this format has seen, and supporting them would make
            // a line's meaning depend on the line after it.
            const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
            if (!heading) {
                continue;
            }

            const text = headingDisplayText(heading[2]);
            const slug = slugifySection(text);
            if (slug) {
                sections.push({ cellIndex, slug, text, level: heading[1].length });
            }
        }
    });

    return sections;
}

/**
 * The cell a `#section` link should scroll to, or undefined when the notebook
 * has no such section. The first match wins: duplicate headings anchor to the
 * earlier one, which is what VS Code's own `id`s do.
 */
export function findSectionCell(cellSources: ReadonlyArray<string | undefined>, section: string): number | undefined {
    if (!section) {
        return undefined;
    }

    const wanted = slugifySection(decodeHref(section));
    return findSections(cellSources).find(candidate => candidate.slug === wanted)?.cellIndex;
}
