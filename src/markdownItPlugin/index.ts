/**
 * Everything this extension adds to VS Code's built-in notebook markdown
 * renderer: image sizing, and links between notebooks.
 *
 * Notebook markup cells are rendered by VS Code's own markdown-it instance
 * (`vscode.markdown-it-renderer`), not by this extension's `marked` setup. This
 * renderer entrypoint hooks into that instance and teaches it the same
 * `![alt](url =WIDTHxHEIGHT)` size syntax the preview / output renderer supports
 * via `src/client/markedImageSize.ts`; both import the parser from
 * `src/shared/imageSize.ts`, so there is one implementation to maintain.
 *
 * Either dimension may be omitted to preserve the aspect ratio:
 *   ![alt](img.png =200x100)   ![alt](img.png =200x)   ![alt](img.png =x100)
 *   ![alt](img.png =200)       ![alt](img.png "title" =200x100)
 *
 * It also owns clicks on `[text](other.webnb#section)` links -- see
 * `notebookLinkClicks.ts`. That listener is on the whole webview document, so it
 * covers links in output cells (MCQ prompts, walkthrough notes) too.
 */
import type { RendererContext } from 'vscode-notebook-renderer';
import { parseSizedImage } from '../shared/imageSize';
import { installNotebookLinkClicks } from './notebookLinkClicks';

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
    // Messaging is declared `optional`, so a host that does not grant it still
    // gets image sizing -- links just fall back to VS Code's own handling.
    const postMessage = context.postMessage;
    if (postMessage) {
        installNotebookLinkClicks(message => postMessage(message));
    }

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
