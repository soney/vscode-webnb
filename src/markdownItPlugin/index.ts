/**
 * Extends VS Code's built-in notebook markdown renderer with image sizing.
 *
 * Notebook markup cells are rendered by VS Code's own markdown-it instance
 * (`vscode.markdown-it-renderer`), not by this extension's `marked` setup. This
 * renderer entrypoint hooks into that instance and teaches it the same
 * `![alt](url =WIDTHxHEIGHT)` size syntax the preview / output renderer supports
 * via `src/client/markedImageSize.ts`. Keep the two implementations in sync.
 *
 * Either dimension may be omitted to preserve the aspect ratio:
 *   ![alt](img.png =200x100)   ![alt](img.png =200x)   ![alt](img.png =x100)
 *   ![alt](img.png =200)       ![alt](img.png "title" =200x100)
 */
import type { RendererContext } from 'vscode-notebook-renderer';

// --- size parsing (kept dependency-free; mirrors markedImageSize.ts) ---------

interface SizedImage {
    alt: string;
    href: string;
    title?: string;
    width?: string;
    height?: string;
    length: number;
}

// The alt branch `[^\\\]]` excludes backslash (as well as `]`) so an escaped
// char is only ever consumed by the `\\.` branch — without that exclusion a run
// of backslashes has 2^n ambiguous parses (catastrophic backtracking).
const SIZED_IMAGE_RE =
    /^!\[((?:\\.|[^\\\]])*)\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s+=(?:(\d*)x(\d*)|(\d+))\s*\)/;

function parseSizedImage(src: string): SizedImage | null {
    const match = SIZED_IMAGE_RE.exec(src);
    if (!match) {
        return null;
    }

    let href = match[2];
    if (href.startsWith('<') && href.endsWith('>')) {
        href = href.slice(1, -1);
    }

    // Regex capture groups: 1=alt, 2=href, 3="title", 4='title',
    // 5=W (of WxH), 6=H (of WxH), 7=plain-N shorthand.
    let width: string | undefined;
    let height: string | undefined;
    if (match[7] !== undefined) {
        width = match[7];
    } else {
        width = match[5] || undefined;
        height = match[6] || undefined;
    }
    if (width === undefined && height === undefined) {
        return null;
    }

    return {
        alt: match[1],
        href,
        title: match[3] ?? match[4],
        width,
        height,
        length: match[0].length
    };
}

// --- markdown-it plugin ------------------------------------------------------
// Minimal structural typing for the markdown-it pieces we touch, so the plugin
// stays free of a hard `markdown-it` type dependency.

interface InlineToken {
    attrs: [string, string][] | null;
    children: unknown[] | null;
    content: string;
}

interface InlineState {
    src: string;
    pos: number;
    env: unknown;
    md: MarkdownItLike;
    push(type: string, tag: string, nesting: number): InlineToken;
}

type InlineRule = (state: InlineState, silent: boolean) => boolean;

interface MarkdownItLike {
    inline: {
        ruler: {
            before(beforeName: string, ruleName: string, rule: InlineRule): void;
        };
        parse(src: string, md: MarkdownItLike, env: unknown, tokens: unknown[]): void;
    };
}

const EXCLAMATION = 0x21; // !
const OPEN_BRACKET = 0x5b; // [

function imageSizePlugin(md: MarkdownItLike): void {
    const rule: InlineRule = (state, silent) => {
        const start = state.pos;
        if (state.src.charCodeAt(start) !== EXCLAMATION) {
            return false;
        }
        if (state.src.charCodeAt(start + 1) !== OPEN_BRACKET) {
            return false;
        }

        const parsed = parseSizedImage(state.src.slice(start));
        if (!parsed) {
            return false; // let markdown-it's built-in image rule handle it
        }

        if (!silent) {
            const token = state.push('image', 'img', 0);
            const attrs: [string, string][] = [['src', parsed.href], ['alt', '']];
            if (parsed.title) {
                attrs.push(['title', parsed.title]);
            }
            if (parsed.width) {
                attrs.push(['width', parsed.width]);
            }
            if (parsed.height) {
                attrs.push(['height', parsed.height]);
            }
            token.attrs = attrs;
            // The built-in image renderer fills `alt` from the parsed children.
            token.children = [];
            state.md.inline.parse(parsed.alt, state.md, state.env, token.children);
            token.content = parsed.alt;
        }

        state.pos = start + parsed.length;
        return true;
    };

    md.inline.ruler.before('image', 'image_size', rule);
}

// --- renderer entrypoint -----------------------------------------------------

interface MarkdownItRenderer {
    extendMarkdownIt(fn: (md: MarkdownItLike) => void): void;
}

export async function activate(context: RendererContext<void>): Promise<void> {
    if (typeof context.getRenderer !== 'function') {
        return;
    }

    const renderer = await context.getRenderer('vscode.markdown-it-renderer');
    if (!renderer) {
        throw new Error('Web Notebook image sizing: could not load vscode.markdown-it-renderer');
    }

    (renderer as unknown as MarkdownItRenderer).extendMarkdownIt((md) => {
        imageSizePlugin(md);
    });
}
