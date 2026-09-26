/**
 * Turns a .webnb document into the cell models the preview page renders, using
 * the notebook extension's OWN parser -- so the preview splits cells exactly
 * the way the notebook editor does -- plus the source spans from cellSpans.ts.
 */
import * as vscode from 'vscode';
import { parseMarkdown, type RawNotebookCell } from '@webnb/extension/markdownParser';
import { computeCellSpans, type SpanInput } from './cellSpans';
import type { Addon, PreviewCell } from '../shared/previewProtocol';

function hashString(value: string): string {
    // FNV-1a: short, stable, and good enough to tell "this cell changed" apart.
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function toSpanInput(raw: RawNotebookCell): SpanInput {
    return {
        kind: raw.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup',
        content: raw.content,
        rawCode: raw.rawCode,
        indentation: raw.indentation
    };
}

/**
 * Parse a document into preview cells.
 *
 * A half-typed notebook is often malformed (a fence not closed yet, an addon
 * block with no code block above it, a `+id=` naming a cell that does not
 * exist yet). The parser shows such a block as plain text and reports it to
 * `onWarning`, exactly as the notebook does on open. Anything it still throws
 * propagates, and the panel then keeps showing the last good parse.
 */
export function parseDocumentCells(text: string, onWarning?: (message: string) => void): PreviewCell[] {
    const raw = parseMarkdown(text, onWarning);
    const spans = computeCellSpans(text, raw.map(toSpanInput));

    return raw.map((cell, index) => {
        const kind = cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup';
        const addons: Addon[] = cell.addons ?? [];
        const signature = JSON.stringify([
            kind, cell.language, cell.content, addons, cell.autorun, cell.runonstart, cell.hidecode, cell.height, cell.id
        ]);

        return {
            kind,
            languageId: cell.language,
            value: cell.content,
            index,
            startLine: spans[index]?.startLine ?? 0,
            endLine: spans[index]?.endLine ?? 0,
            addons,
            id: cell.id,
            autorun: cell.autorun,
            runonstart: cell.runonstart,
            hidecode: cell.hidecode,
            height: cell.height,
            stableKey: cell.id ? `id:${cell.id}` : `idx:${index}`,
            // Any change to what the cell renders makes it a new cell (and so a
            // fresh view and output) -- an `id=` cell included, since a view
            // reused across an edit to its body would keep showing the old one.
            // The id still carries over what should survive an edit: stableKey
            // keeps the remembered answer and whether the cell had been run.
            contentKey: `sig:${hashString(signature)}`
        } satisfies PreviewCell;
    });
}
