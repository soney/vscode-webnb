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

/**
 * The markdown-it extension runs in EVERY notebook's webview (it extends VS
 * Code's own markdown renderer, which Jupyter notebooks use too), so it must
 * not take over link clicks until the extension host confirms the notebook is
 * a Web Notebook. The renderer says hello on activation; the host answers that
 * one editor with whether link handling is on.
 */
export const LINK_HANDLER_HELLO_MESSAGE = 'webnb.linkHandlerHello';
export const LINK_HANDLER_CONFIG_MESSAGE = 'webnb.linkHandlerConfig';

export interface WebNbLinkHandlerHelloMessage {
    type: 'webnb.linkHandlerHello';
}

export interface WebNbLinkHandlerConfigMessage {
    type: 'webnb.linkHandlerConfig';
    /** True only for a `web-notebook` document. */
    enabled: boolean;
}

/**
 * Marks the output container of a cell whose markup the learner writes (html,
 * css, js, node, react). Links inside it belong to the learner's page -- a tab
 * widget's `<a href="#settings">` -- so the notebook link handler leaves them be.
 */
export const LEARNER_OUTPUT_ATTRIBUTE = 'data-webnb-learner-output';

export function isLinkHandlerHelloMessage(message: unknown): message is WebNbLinkHandlerHelloMessage {
    return !!message && typeof message === 'object'
        && (message as Partial<WebNbLinkHandlerHelloMessage>).type === LINK_HANDLER_HELLO_MESSAGE;
}

export function isLinkHandlerConfigMessage(message: unknown): message is WebNbLinkHandlerConfigMessage {
    return !!message && typeof message === 'object'
        && (message as Partial<WebNbLinkHandlerConfigMessage>).type === LINK_HANDLER_CONFIG_MESSAGE
        && typeof (message as Partial<WebNbLinkHandlerConfigMessage>).enabled === 'boolean';
}

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
 * Stand-ins for text that must come through markup stripping untouched: a
 * backslash-escaped character, and a code span's literal content. Private-use
 * code points, so they can never collide with real heading text.
 */
const ESCAPED = '\uE000';
const CODE_SPAN = '\uE001';

/** The HTML entities a heading realistically contains, decoded as markdown-it does. */
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00A0',
    copy: '\u00A9', reg: '\u00AE', trade: '\u2122', hellip: '\u2026',
    mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
    ldquo: '\u201C', rdquo: '\u201D', laquo: '\u00AB', raquo: '\u00BB'
};

function decodeEntity(entity: string, name: string): string {
    if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[name] ?? entity;
}

/**
 * A heading's slug is built from the same text VS Code builds its heading `id`
 * from: the concatenated content of markdown-it's inline tokens. So a code
 * span's text counts literally (`## The \`<style>\` Element` is anchored at
 * `#the-style-element`), emphasis markers and link syntax come off, an image
 * contributes its alt text, escapes and entities become the character they
 * stand for, and raw HTML stays as written (the slug then drops its brackets).
 */
export function headingDisplayText(markdown: string): string {
    const codeSpans: string[] = [];
    const park = (text: string) => CODE_SPAN + (codeSpans.push(text) - 1) + CODE_SPAN;
    return markdown
        // Escaped punctuation is literal text. Park it out of reach first, or
        // the emphasis rule below eats the asterisks in `\*not emphasis\*`.
        .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_match, character: string) =>
            ESCAPED + character.charCodeAt(0).toString(16).padStart(4, '0'))
        // Code spans next: nothing inside one is markup, so emphasis-looking
        // `__proto__` and tag-looking `<style>` both survive as written.
        .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_match, _ticks: string, content: string) => {
            const text = content.replace(/\r?\n/g, ' ');
            // CommonMark trims one space from each side when both are present.
            return park(/^ .*[^ ].* $/.test(text) ? text.slice(1, -1) : text);
        })
        // An image contributes its alt text; a link contributes its label.
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Emphasis: asterisks anywhere; underscores only at word boundaries,
        // since `snake_case_name` is not emphasis.
        .replace(/(\*\*|\*)(?=\S)([\s\S]*?\S)\1/g, '$2')
        .replace(/(^|[^\p{L}\p{N}_])(__|_)(?=\S)([\s\S]*?\S)\2(?![\p{L}\p{N}_])/gu, '$1$3')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
        .replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, decodeEntity)
        .replace(new RegExp(ESCAPED + '([0-9a-f]{4})', 'g'), (_match, code: string) =>
            String.fromCharCode(parseInt(code, 16)))
        .replace(new RegExp(CODE_SPAN + '(\\d+)' + CODE_SPAN, 'g'), (_match, index: string) =>
            codeSpans[Number(index)])
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The text of an ATX heading line (`## Title ##`), or undefined when the line is
 * not one. Written with string operations rather than one regex: the obvious
 * pattern backtracks cubically on a long run of spaces, and this runs in the
 * extension host on every section-link click.
 */
export function atxHeading(line: string): { level: number; content: string } | undefined {
    const opener = /^\s{0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
    if (!opener) {
        return undefined;
    }
    const isBlank = (character: string) => character === ' ' || character === '\t';
    let text = line.slice(opener[0].length);
    let end = text.length;
    while (end > 0 && isBlank(text[end - 1])) {
        end--;
    }
    // A closing run of `#` counts only when a space separates it from the text
    // (or it is all there is): `## C#` keeps its `#`.
    let hashes = end;
    while (hashes > 0 && text[hashes - 1] === '#') {
        hashes--;
    }
    if (hashes < end && (hashes === 0 || isBlank(text[hashes - 1]))) {
        end = hashes;
        while (end > 0 && isBlank(text[end - 1])) {
            end--;
        }
    }
    text = text.slice(0, end);
    let start = 0;
    while (start < text.length && isBlank(text[start])) {
        start++;
    }
    return { level: opener[1].length, content: text.slice(start) };
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
        // VS Code de-duplicates heading ids within one rendered markdown cell:
        // the second "Intro" is `#intro-1`, the third `#intro-2`.
        const seen = new Map<string, number>();
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
            const heading = atxHeading(line);
            if (!heading) {
                continue;
            }

            const text = headingDisplayText(heading.content);
            let slug = slugifySection(text);
            const count = seen.get(slug);
            if (count === undefined) {
                seen.set(slug, 0);
            } else {
                seen.set(slug, count + 1);
                slug = slugifySection(`${slug}-${count + 1}`);
            }
            if (slug) {
                sections.push({ cellIndex, slug, text, level: heading.level });
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
