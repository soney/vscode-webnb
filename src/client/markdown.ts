/**
 * The renderer's markdown pipeline: one `marked` singleton configured with the
 * image-size extension and syntax-highlighted code fences, plus smartypants
 * typography. Everything renderer-owned that turns markdown or plain text into
 * HTML goes through here so all cell types agree.
 */
import { marked } from 'marked';
import smartypants from 'smartypants';
import { installMarkedImageSize } from './markedImageSize';
import { escapeHtml, renderCodeBlockHtml } from './syntaxHighlight';

const SMARTYPANTS_ATTR = '2';

// Teach marked the `![alt](url =WIDTHxHEIGHT)` image-size syntax.
installMarkedImageSize();

// Syntax-highlight fenced code blocks in the markdown this renderer owns —
// walkthrough commentary and notes, MCQ questions, checklist labels — with the
// same palette walkthrough snippets use.
marked.use({ renderer: { code: renderCodeBlockHtml } });

export function renderMarkdownInline(text: string): string {
    const html = marked.parseInline(text) as string;
    return smartypants(html, SMARTYPANTS_ATTR);
}

export function renderMarkdownBlock(text: string): string {
    const html = marked.parse(text) as string;
    return smartypants(html, SMARTYPANTS_ATTR);
}

export function renderSmartText(text: string): string {
    const escaped = escapeHtml(text);
    // Turn markdown-style `code` spans into <code>, which smartypants skips.
    // Without this, literals a learner is meant to type get typographic
    // substitutions applied to them: "<!--" would render as "<!-" with an en
    // dash, and `map(...)` would render with an ellipsis character. Escaping
    // already ran, so backticks here can only have come from the message.
    const withCode = escaped.replace(/(`+)([\s\S]+?)\1/g, (_match, _ticks, code) => `<code>${code}</code>`);
    return smartypants(withCode, SMARTYPANTS_ATTR);
}
