/**
 * Parses a .webnb document into cell models using the EXACT same parser the
 * extension uses (markdownParser.ts), so cells are split identically to VS Code.
 */
import { parseMarkdown } from '../../src/extension/markdownParser';
import { NotebookCellKind } from './vscode-shim';
import type { Addon } from './types';

export interface CellModel {
    kind: 'markup' | 'code';
    languageId: string;
    value: string;
    index: number;
    metadata: {
        leadingWhitespace?: string;
        trailingWhitespace?: string;
        indentation?: string;
        addons?: Addon[];
        id?: string;
        autorun?: boolean;
        runonstart?: boolean;
        /** Show only this cell's output; its source starts hidden. */
        hidecode?: boolean;
        /** The cell's `height=` attribute, as authored. */
        height?: string;
        rawCode?: string;
        rawCodeLanguage?: string;
    };
}

export function parseNotebook(content: string): CellModel[] {
    return parseMarkdown(content).map((raw, index) => ({
        kind: raw.kind === NotebookCellKind.Code ? 'code' : 'markup',
        languageId: raw.language,
        value: raw.content,
        index,
        metadata: {
            leadingWhitespace: raw.leadingWhitespace,
            trailingWhitespace: raw.trailingWhitespace,
            indentation: raw.indentation,
            addons: raw.addons,
            id: raw.id,
            autorun: raw.autorun,
            runonstart: raw.runonstart,
            hidecode: raw.hidecode,
            height: raw.height,
            rawCode: raw.rawCode,
            rawCodeLanguage: raw.rawCodeLanguage
        }
    }));
}

/** Stable identity for a cell across disk reloads (id if present, else position). */
export function cellKeyFor(model: CellModel): string {
    return model.metadata.id ? `id:${model.metadata.id}` : `idx:${model.index}`;
}
