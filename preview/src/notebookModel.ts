/**
 * Parses a .webnb document into cell models using the EXACT same parser the
 * extension uses (markdownParser.ts), so cells are split identically to VS Code.
 */
import { parseMarkdown, type RawNotebookCell } from '../../src/extension/markdownParser';
import { getAddonContent } from '../../src/shared/addons';
import { NotebookCellKind } from './vscode-shim';
import type { Addon } from './types';

/**
 * Cell languages whose `+solution` is code that can stand in for the source:
 * the cells render() gives a "View solution" button (html, css, and the
 * javascript/node/react runtimes). An MCQ's `+solution` is an explanation, not
 * an answer to run, so it is never swapped in.
 */
const RUNNABLE_SOLUTION_LANGUAGES = new Set(['html', 'css', 'javascript', 'js', 'node', 'react', 'jsx', 'javascriptreact']);

export interface ParseNotebookOptions {
    /**
     * Show every runnable cell's `+solution` in place of its source: the
     * notebook as a learner who solved each exercise would see it. The
     * preview's `?solutions` mode (see main.ts); verify-notebooks --solutions
     * renders the corpus this way.
     */
    solutions?: boolean;
}

function solutionSource(raw: RawNotebookCell): string | undefined {
    if (raw.kind !== NotebookCellKind.Code || !RUNNABLE_SOLUTION_LANGUAGES.has(raw.language)) {
        return undefined;
    }
    const solution = getAddonContent(raw.addons ?? [], 'solution');
    return solution !== undefined && solution.trim() ? solution : undefined;
}

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

export function parseNotebook(content: string, options: ParseNotebookOptions = {}): CellModel[] {
    return parseMarkdown(content).map((raw, index) => ({
        kind: raw.kind === NotebookCellKind.Code ? 'code' : 'markup',
        languageId: raw.language,
        value: (options.solutions ? solutionSource(raw) : undefined) ?? raw.content,
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
