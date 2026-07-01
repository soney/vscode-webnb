/**
 * Minimal browser stand-in for the `vscode` module.
 *
 * markdownParser.ts (shared with the extension) imports `* as vscode` but only
 * touches `NotebookCellKind` at runtime and a couple of types for compilation.
 * Vite aliases `vscode` to this file (see vite.config.ts).
 */

export enum NotebookCellKind {
    Markup = 1,
    Code = 2
}

/** Structural type matching the parts of vscode.NotebookCellData the parser produces. */
export interface NotebookCellData {
    kind: NotebookCellKind;
    languageId: string;
    value: string;
    metadata?: Record<string, unknown>;
}
