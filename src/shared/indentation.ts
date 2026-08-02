/**
 * Shared indentation rules.
 *
 * A .webnb cell nested inside a list item is indented to sit inside it, and
 * that indentation belongs to the document's layout rather than to the cell:
 * left in the content it makes Markdown read prose as an indented code block,
 * and it makes editing the cell a game of retyping the right number of spaces.
 *
 * Only the SHARED indent is ever removed, never a fixed amount, so indentation
 * an author added on top of it -- an example snippet inside a question, say --
 * still means what it meant. The serializer (markdownParser.ts) and the MCQ
 * renderer (client/mcq.ts) both work from these, so a cell and a question
 * cannot disagree about what their indentation was.
 *
 * Dependency-free: imported by the extension host and the renderer alike.
 */

/** The whitespace every non-blank line starts with. Blank lines are ignored. */
export function commonIndentation(lines: readonly string[]): string {
    let common: string | undefined;
    for (const line of lines) {
        if (line.trim() === '') {
            continue;
        }
        const indentation = line.match(/^[ \t]*/)![0];
        if (common === undefined) {
            common = indentation;
            continue;
        }
        let shared = 0;
        while (shared < common.length && shared < indentation.length && common[shared] === indentation[shared]) {
            shared++;
        }
        common = common.slice(0, shared);
        if (common === '') {
            break;
        }
    }
    return common ?? '';
}

/**
 * Remove `indentation` from the front of a line.
 *
 * A line that carries the prefix simply loses it, residual spaces and all -- a
 * fence's body is code, and this must not quietly rewrite it. A line that does
 * NOT carry the prefix is kept, unless it is whitespace-only, in which case it
 * is emptied: it cannot be under-indented content, only a blank line someone
 * left spaces on.
 */
export function stripIndentation(line: string, indentation: string): string {
    if (!indentation) {
        return line;
    }
    if (line.startsWith(indentation)) {
        return line.slice(indentation.length);
    }
    return line.trim() === '' ? '' : line;
}

/** Strip whatever indentation a block of text shares. */
export function dedent(text: string): string {
    const lines = text.split(/\r?\n/g);
    const indentation = commonIndentation(lines);
    if (!indentation) {
        return text;
    }
    return lines.map(line => stripIndentation(line, indentation)).join('\n');
}

/** Put an indentation back, leaving blank lines blank. */
export function applyIndentation(text: string, indentation: string): string {
    if (!indentation) {
        return text;
    }
    return text.split(/\r?\n/g)
        .map(line => (line === '' ? '' : indentation + line))
        .join('\n');
}
