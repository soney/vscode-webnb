/**
 * Syntax highlighting for walkthrough snippets and markdown code fences.
 *
 * highlight.js highlights a whole document in one pass, but a walkthrough
 * renders one DOM row per line — with a line-number gutter beside each row and
 * notes wedged between them — so the highlighted HTML is split back into
 * per-line fragments here, reopening any spans that straddle a line break.
 *
 * Snippets are highlighted in the context of the entire file (not just the
 * shown ranges) so a slice that starts inside a template literal or a comment
 * still gets the right colors.
 *
 * This module is DOM-free so the renderer, the preview harness, and tests can
 * all share it.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import less from 'highlight.js/lib/languages/less';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// Registering a language also registers the aliases it declares, so `html`
// resolves through `xml`, `js` through `javascript`, and so on.
for (const [name, definition] of Object.entries({
    bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, less,
    markdown, php, python, ruby, rust, scss, sql, typescript, xml, yaml
})) {
    hljs.registerLanguage(name, definition);
}

/**
 * Extra file extensions highlight.js does not already know as aliases (`js`,
 * `tsx`, `yml`, `patch`, and friends resolve on their own).
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
    htm: 'xml',
    vue: 'xml',
    webnb: 'markdown',
    cfg: 'ini',
    conf: 'ini',
    env: 'ini'
};

/** Files whose language comes from the whole name rather than an extension. */
const FILENAME_LANGUAGES: Record<string, string> = {
    dockerfile: 'dockerfile',
    '.bashrc': 'bash',
    '.zshrc': 'bash',
    '.profile': 'bash',
    '.env': 'ini',
    '.gitignore': 'ini'
};

/** Values an author can pass to `language:` to turn highlighting off. */
const PLAIN_LANGUAGE_NAMES = new Set(['none', 'off', 'plain', 'plaintext', 'text', 'txt']);

/**
 * Past this size, highlighting a whole file costs more than the color is
 * worth (snapshots themselves are capped at 1 MB).
 */
const MAX_HIGHLIGHT_CHARS = 200000;

/** Escapes text for insertion into HTML, matching highlight.js's own escaping. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Whether an author asked for plain text rather than naming a language. */
export function isPlainLanguageName(name: string): boolean {
    return PLAIN_LANGUAGE_NAMES.has(name.trim().toLowerCase().split(/\s+/)[0]);
}

/**
 * Resolves a language name an author wrote (a `language:` step key, a markdown
 * fence info string) to a registered highlight.js language, or `undefined` when
 * it is unknown or explicitly plain text.
 */
export function resolveHighlightLanguage(name: string | undefined): string | undefined {
    if (!name) {
        return undefined;
    }
    // Fence info strings can carry extra words: ```js some-other-attribute
    const normalized = name.trim().toLowerCase().split(/\s+/)[0];
    if (!normalized || PLAIN_LANGUAGE_NAMES.has(normalized)) {
        return undefined;
    }
    return hljs.getLanguage(normalized) ? normalized : EXTENSION_LANGUAGES[normalized];
}

/** Guesses a language from a file path, e.g. `src/app.ts` → `typescript`. */
export function detectHighlightLanguage(path: string): string | undefined {
    const name = path.trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    if (!name) {
        return undefined;
    }
    if (FILENAME_LANGUAGES[name]) {
        return FILENAME_LANGUAGES[name];
    }

    const dot = name.lastIndexOf('.');
    if (dot < 1) {
        return undefined;
    }
    return resolveHighlightLanguage(name.slice(dot + 1));
}

/** Highlights a whole document, returning HTML, or `undefined` if it cannot. */
export function highlightToHtml(code: string, language: string | undefined): string | undefined {
    if (!language || code.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(language)) {
        return undefined;
    }

    try {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
        // A broken language definition should never cost the reader the snippet.
        return undefined;
    }
}

/**
 * Highlights a whole document and returns one HTML fragment per line, indexed
 * by `lineNumber - 1`. Returns `undefined` when the text should render plain.
 */
export function highlightToLines(code: string, language: string | undefined): string[] | undefined {
    // `\r\n` collapses to `\n` so fragments line up with the way walkthrough.ts
    // splits files; a lone `\r` is not a line break for either of us.
    const normalized = code.replace(/\r\n/g, '\n');
    const html = highlightToHtml(normalized, language);
    if (html === undefined) {
        return undefined;
    }

    const lines = splitHighlightedLines(html);
    // Defensive: highlighting must never shift which line a fragment belongs to.
    return lines.length === normalized.split('\n').length ? lines : undefined;
}

/**
 * Splits highlight.js output into per-line fragments. Spans that span a line
 * break are closed at the end of the line and reopened on the next one, so each
 * fragment stands alone as valid HTML.
 */
function splitHighlightedLines(html: string): string[] {
    const lines: string[] = [];
    const openTags: string[] = [];
    let current = '';
    let index = 0;

    const endLine = () => {
        lines.push(current + '</span>'.repeat(openTags.length));
        current = openTags.join('');
    };

    while (index < html.length) {
        const nextTag = html.indexOf('<', index);
        const nextBreak = html.indexOf('\n', index);

        if (nextTag === -1 && nextBreak === -1) {
            current += html.slice(index);
            break;
        }

        if (nextBreak !== -1 && (nextTag === -1 || nextBreak < nextTag)) {
            current += html.slice(index, nextBreak);
            endLine();
            index = nextBreak + 1;
            continue;
        }

        current += html.slice(index, nextTag);
        const tagEnd = html.indexOf('>', nextTag);
        if (tagEnd === -1) {
            current += html.slice(nextTag);
            break;
        }

        const tag = html.slice(nextTag, tagEnd + 1);
        if (tag.startsWith('</')) {
            openTags.pop();
        } else if (!tag.endsWith('/>')) {
            openTags.push(tag);
        }
        current += tag;
        index = tagEnd + 1;
    }

    lines.push(current + '</span>'.repeat(openTags.length));
    return lines;
}
