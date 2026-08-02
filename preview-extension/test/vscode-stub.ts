/**
 * The sliver of the `vscode` module markdownParser.ts touches, so the parser
 * can run under plain node in tests. Values match VS Code's real enum.
 */
export const NotebookCellKind = { Markup: 1, Code: 2 } as const;

export class NotebookCellData {
    public metadata?: unknown;
    constructor(public kind: number, public value: string, public languageId: string) {}
}
