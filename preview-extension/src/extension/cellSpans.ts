/**
 * Where each parsed cell sits in the source document.
 *
 * parseMarkdown reports what the cells ARE, not where they came from, and this
 * extension deliberately does not patch the notebook extension to add line
 * numbers. Instead we recover the spans from the parser's own output: a cell's
 * body is a verbatim run of document lines (dedented, for an indented fence),
 * so walking the document with a forward cursor and matching each cell's body
 * in turn finds every cell's position without re-implementing the parser's
 * fence grammar.
 *
 * The rules that make this exact:
 *  - Cells come back in document order, so a forward-only cursor can never
 *    match the wrong copy of a repeated block.
 *  - Addon blocks (```+test) produce no cell of their own, so they simply fall
 *    into the gap after a cell -- and the final pass grows every span up to the
 *    next cell's start, which is what puts them back with the cell they
 *    decorate.
 *  - A fenced cell's body is bracketed by its two fence lines, so its span is
 *    one line wider than the run that matched.
 */

/** What a span needs to know about a parsed cell. */
export interface SpanInput {
    kind: 'markup' | 'code';
    /** The cell's text as the parser reported it. */
    content: string;
    /** Set for anything that came from a fence: the body without the fences. */
    rawCode?: string;
    /** Leading whitespace stripped from an indented fence's body. */
    indentation?: string;
}

export interface CellSpan {
    /** 0-based, inclusive. */
    startLine: number;
    endLine: number;
}

/**
 * A document line matches a body line when they are equal, or when the document
 * line is the body line under an indent that the parser stripped. Whitespace-only
 * lines are stripped to '' by the parser, so they compare equal to a blank body
 * line whatever they contain.
 */
function lineMatches(documentLine: string, bodyLine: string): boolean {
    if (documentLine === bodyLine) {
        return true;
    }
    if (bodyLine === '') {
        return documentLine.trim() === '';
    }
    return documentLine.endsWith(bodyLine)
        && documentLine.slice(0, documentLine.length - bodyLine.length).trim() === '';
}

/** First index at or after `from` where every line of `body` matches in order. */
function findRun(lines: string[], body: string[], from: number): number {
    const last = lines.length - body.length;
    for (let start = Math.max(0, from); start <= last; start++) {
        let matched = true;
        for (let offset = 0; offset < body.length; offset++) {
            if (!lineMatches(lines[start + offset], body[offset])) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return start;
        }
    }
    return -1;
}

function isFence(line: string): boolean {
    return /^\s*```/.test(line);
}

/** Span of the next fenced block at or after `from`, for cells with an empty body. */
function findEmptyFencedBlock(lines: string[], from: number): CellSpan | undefined {
    for (let start = Math.max(0, from); start < lines.length; start++) {
        if (!isFence(lines[start])) {
            continue;
        }
        for (let end = start + 1; end < lines.length; end++) {
            if (isFence(lines[end])) {
                return { startLine: start, endLine: end };
            }
        }
        return { startLine: start, endLine: lines.length - 1 };
    }
    return undefined;
}

/**
 * The body lines to look for, and whether they are wrapped in fences.
 *
 * A code cell's body is its content. A `code-with-id` block arrives as a markup
 * cell whose content is the fence rebuilt around `rawCode`, so the run to match
 * is `rawCode`, not the content. A plain markdown paragraph is verbatim.
 */
function bodyOf(cell: SpanInput): { lines: string[]; fenced: boolean } {
    const fenced = cell.kind === 'code' || cell.rawCode !== undefined;
    const text = fenced ? (cell.rawCode ?? cell.content) : cell.content;
    return { lines: text === '' ? [] : text.split('\n'), fenced };
}

/**
 * Locate every cell in `text`. Always returns one span per cell, in order, with
 * no gaps: each span runs to the line before the next cell starts, so addon
 * blocks and the blank lines between cells belong to the cell above them.
 */
export function computeCellSpans(text: string, cells: readonly SpanInput[]): CellSpan[] {
    const lines = text.split(/\r?\n/g);
    const lastLine = Math.max(0, lines.length - 1);
    const spans: CellSpan[] = [];
    let cursor = 0;

    for (const cell of cells) {
        const body = bodyOf(cell);
        let span: CellSpan | undefined;

        if (body.lines.length === 0) {
            span = body.fenced ? findEmptyFencedBlock(lines, cursor) : undefined;
        } else {
            const start = findRun(lines, body.lines, cursor);
            if (start >= 0) {
                span = body.fenced
                    ? { startLine: Math.max(cursor, start - 1), endLine: Math.min(lastLine, start + body.lines.length) }
                    : { startLine: start, endLine: start + body.lines.length - 1 };
            }
        }

        // A cell we could not place still gets a span, so the preview never
        // loses a cell and the ones after it stay findable.
        const placed = span ?? { startLine: cursor, endLine: cursor };
        placed.startLine = Math.min(Math.max(placed.startLine, cursor), lastLine);
        placed.endLine = Math.min(Math.max(placed.endLine, placed.startLine), lastLine);
        spans.push(placed);
        cursor = Math.min(placed.endLine + 1, lines.length);
    }

    // Grow each span over whatever follows it -- blank lines, addon blocks --
    // up to the next cell, and let the last cell run to the end of the file.
    for (let index = 0; index < spans.length; index++) {
        const next = spans[index + 1];
        spans[index].endLine = next ? Math.max(spans[index].endLine, next.startLine - 1) : lastLine;
    }

    return spans;
}
