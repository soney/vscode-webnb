// Source: https://github.com/microsoft/vscode-markdown-notebook/blob/main/src/markdownParser.ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Addon } from '../shared/protocol';
import { applyIndentation, commonIndentation, stripIndentation } from '../shared/indentation';

export interface RawNotebookCell {
	/**
	 * Whitespace every line of this cell was indented by, stripped from the
	 * content and re-applied when the cell is written back. A cell nested in a
	 * list item is indented to sit inside it; that indentation belongs to the
	 * document's layout, not to the cell, and carrying it in the content makes
	 * Markdown read it as an indented code block.
	 */
	indentation?: string;
	leadingWhitespace: string;
	/** Whitespace after this cell's last block -- its last addon, if it has any. */
	trailingWhitespace: string;
	language: string;
	content: string;
	kind: vscode.NotebookCellKind;
	addons?: Addon[];
	/** Whitespace before each addon block, index-aligned with `addons`. */
	addonWhitespace?: string[];
	id?: string;
	autorun?: boolean;
	runonstart?: boolean;
	/**
	 * Show only this cell's output, not the code that produced it. For a cell
	 * that draws a widget, the code is scaffolding the reader does not need.
	 */
	hidecode?: boolean;
	/**
	 * How tall this cell's output pane should be, as the author wrote it
	 * (`height=300`, `height=20em`, `height=auto`). Kept verbatim so a save
	 * gives the text back unchanged; shared/outputHeight turns it into CSS.
	 */
	height?: string;
	rawCode?: string;
	rawCodeLanguage?: string;
}

/** The cell metadata this serializer writes and the kernel reads back. */
export interface WebNbCellMetadata {
	leadingWhitespace?: string;
	trailingWhitespace?: string;
	indentation?: string;
	addons?: Addon[];
	addonWhitespace?: string[];
	id?: string;
	autorun?: boolean;
	runonstart?: boolean;
	hidecode?: boolean;
	height?: string;
	inputCollapsed?: boolean;
}

interface BlockAttributes {
	id?: string;
	autorun?: boolean;
	runonstart?: boolean;
	hidecode?: boolean;
	height?: string;
}

/** Parses the `id=5 autorun runonstart hidecode height=300` attributes after a fence's language. */
function parseBlockAttributes(rest: string): BlockAttributes {
	const attributes: BlockAttributes = {};
	const idMatch = rest.match(/id\s*=\s*(\S+)/);
	if (idMatch) {
		attributes.id = idMatch[1];
	}
	if (/\bautorun\b/.test(rest)) {
		attributes.autorun = true;
	}
	if (/\brunonstart\b/.test(rest)) {
		attributes.runonstart = true;
	}
	if (/\bhidecode\b/.test(rest)) {
		attributes.hidecode = true;
	}
	// Taken verbatim, even when it is not a length: dropping what the author
	// typed here would delete it from the file on the next save. Whether it
	// means anything is shared/outputHeight's call, at render time.
	const heightMatch = rest.match(/\bheight\s*=\s*(\S+)/);
	if (heightMatch) {
		attributes.height = heightMatch[1];
	}
	return attributes;
}

/** Renders the attributes back into fence text; the inverse of parseBlockAttributes. */
function formatBlockAttributes(metadata: WebNbCellMetadata | undefined): string {
	const idPart = metadata?.id ? ` id=${metadata.id}` : '';
	const autorunPart = metadata?.autorun ? ' autorun' : '';
	const runonstartPart = metadata?.runonstart ? ' runonstart' : '';
	const hidecodePart = metadata?.hidecode ? ' hidecode' : '';
	const heightPart = metadata?.height ? ` height=${metadata.height}` : '';
	return idPart + autorunPart + runonstartPart + hidecodePart + heightPart;
}

const LANG_IDS = new Map([
	['javascript', 'javascript'],
	['node', 'node'],
	['css', 'css'],
	['html', 'html'],
	['jsx', 'javascriptreact'],
	['react', 'javascriptreact'],
	['mcq', 'mcq'],
	['external', 'external'],
	['checklist', 'checklist'],
	['walkthrough', 'walkthrough']
]);
const LANG_ABBREVS = new Map(
	Array.from(LANG_IDS.keys()).map(k => [LANG_IDS.get(k), k])
);

interface ICodeBlockStart {
	langId: string;
	indentation: string;
	blockType: 'user-code' | 'addon-code' | 'addon-reference' | 'code-with-id';
	id?: string;
	autorun?: boolean;
	runonstart?: boolean;
	hidecode?: boolean;
	height?: string;
}

/**
 * Note - the indented code block parsing is basic. It should only be applied inside lists, indentation should be consistent across lines and
 * between the start and end blocks, etc. This is good enough for typical use cases.
 */
function parseCodeBlockStart(line: string): ICodeBlockStart | null {
	// Match user code blocks with optional ID and autorun: ```{html id=5 autorun}
	const userCodeBlockMatch = line.match(/^([ \t]*)```\{([^\}\s]+)(.*?)\}/);
	if(userCodeBlockMatch) {
		const langId = userCodeBlockMatch[2];
		return {
			indentation: userCodeBlockMatch[1],
			langId,
			blockType: 'user-code',
			...parseBlockAttributes(userCodeBlockMatch[3] || '')
		};
	} else {
		// Match addon references: ```+id=5
		const addonRefMatch = line.match(/^([ \t]*)```\+id=(\S+)/);
		if (addonRefMatch) {
			return {
				indentation: addonRefMatch[1],
				langId: 'reference',
				blockType: 'addon-reference',
				id: addonRefMatch[2]
			};
		}

		// Match code blocks with type ```html id=5 or ```html autorun
		const codeWithIdMatch = line.match(/^([ \t]*)```([^\s+]\S*)(?:\s+(.+))?/);
		if(codeWithIdMatch && codeWithIdMatch[3]) {
			const { id, autorun, runonstart, hidecode, height } = parseBlockAttributes(codeWithIdMatch[3]);
			if (id || autorun || runonstart || hidecode || height) {
				return {
					indentation: codeWithIdMatch[1],
					langId: codeWithIdMatch[2],
					blockType: 'code-with-id',
					id,
					autorun,
					runonstart,
					// Carried so the flag survives a save; a code-with-id block
					// becomes a markup cell, which has no output to keep.
					hidecode,
					height
				};
			}
		}

		// Match addon code blocks: ```+test
		const addonCodeMatch = line.match(/^([ \t]*)```\+(\S*)(\s+(\S*))?/);
		if (addonCodeMatch) {
			return {
				indentation: addonCodeMatch[1],
				langId: addonCodeMatch[2],
				blockType: 'addon-code'
			};
		}
	}
	
	return null;
}

function isCodeBlockStart(line: string): boolean {
	return !!parseCodeBlockStart(line);
}

function isGenericFencedMarkdownStart(line: string): boolean {
	return /^\s*```/.test(line) && !isCodeBlockStart(line);
}

function isCodeBlockEndLine(line: string): boolean {
	return !!line.match(/^\s*```/);
}

/**
 * A fenced block: opening line, body, closing fence.
 *
 * An empty body closes on the very next line. Both `\`\`\`x` + `\`\`\`` and
 * `\`\`\`x` + blank + `\`\`\`` parse to empty content, so this is the canonical
 * form the serializer settles on for either.
 */
function writeFencedBlock(openLine: string, body: string, indentation: string): string {
	const closing = indentation + '```';
	if (body === '') {
		return openLine + '\n' + closing;
	}
	return openLine + '\n' + applyIndentation(body, indentation) + '\n' + closing;
}

export function parseMarkdown(content: string): RawNotebookCell[] {
	const lines = content.split(/\r?\n/g);
	let cells: RawNotebookCell[] = [];
	let i = 0;

	// Each parse function starts with line i, leaves i on the line after the last line parsed
	for (; i < lines.length;) {
		const leadingWhitespace = i === 0 ? parseWhitespaceLines(true) : '';
		if (i >= lines.length) {
			break;
		}
		const codeBlockMatch = parseCodeBlockStart(lines[i]);
		if (codeBlockMatch) {
			parseCodeBlock(leadingWhitespace, codeBlockMatch);
		} else {
			parseMarkdownParagraph(leadingWhitespace);
		}
	}

	function parseWhitespaceLines(isFirst: boolean): string {
		let start = i;
		const nextNonWhitespaceLineOffset = lines.slice(start).findIndex(l => l !== '');
		let end: number; // will be next line or overflow
		let isLast = false;
		if (nextNonWhitespaceLineOffset < 0) {
			end = lines.length;
			isLast = true;
		} else {
			end = start + nextNonWhitespaceLineOffset;
		}

		i = end;
		const numWhitespaceLines = end - start + (isFirst || isLast ? 0 : 1);
		return '\n'.repeat(numWhitespaceLines);
	}

	function parseCodeBlock(leadingWhitespace: string, codeBlockStart: ICodeBlockStart): void {
		const language = LANG_IDS.get(codeBlockStart.langId) || codeBlockStart.langId;
		const startSourceIdx = ++i;
		while (true) {
			const currLine = lines[i];
			if (i >= lines.length) {
				break;
			} else if (isCodeBlockEndLine(currLine)) {
				i++; // consume block end marker
				break;
			}

			i++;
		}

		const content = lines.slice(startSourceIdx, i - 1)
			.map(line => stripIndentation(line, codeBlockStart.indentation))
			.join('\n');
		const trailingWhitespace = parseWhitespaceLines(false);

		if(codeBlockStart.blockType === 'user-code') {
			cells.push({
				language,
				content,
				kind: vscode.NotebookCellKind.Code,
				leadingWhitespace: leadingWhitespace,
				trailingWhitespace: trailingWhitespace,
				indentation: codeBlockStart.indentation,
				addons: [],
				id: codeBlockStart.id,
				autorun: codeBlockStart.autorun,
				runonstart: codeBlockStart.runonstart,
				hidecode: codeBlockStart.hidecode,
				height: codeBlockStart.height,
				rawCode: content,
				rawCodeLanguage: language
			});
		} else if(codeBlockStart.blockType === 'addon-code' || codeBlockStart.blockType === 'addon-reference') {
			const codeCells = cells.filter(c => c.kind === vscode.NotebookCellKind.Code);
			const lastCodeCell = codeCells.pop();
			if(!lastCodeCell) {
				throw new Error('Addon code block found without a preceding user code block');
			}

			if(!lastCodeCell.addons) {
				lastCodeCell.addons = [];
			}

			// `trailingWhitespace` always means "the gap after this cell's last
			// block". That gap is the one in front of the addon we are about to
			// attach, so hand it over and take the new one -- otherwise the blank
			// line an author put between a cell and its `+solution` is lost the
			// first time the notebook is saved.
			if(!lastCodeCell.addonWhitespace) {
				lastCodeCell.addonWhitespace = [];
			}
			lastCodeCell.addonWhitespace.push(lastCodeCell.trailingWhitespace);
			lastCodeCell.trailingWhitespace = trailingWhitespace;

			if(codeBlockStart.blockType === 'addon-code') {
				lastCodeCell.addons.push({type: codeBlockStart.langId, content});
			} else {
				// Find the cell with the specified ID
				const referencedCell = cells.find(c => c.id === codeBlockStart.id);
				if(!referencedCell) {
					throw new Error(`Referenced cell with id="${codeBlockStart.id}" not found`);
				}

				const content = referencedCell.rawCode || referencedCell.content;
				const type = referencedCell.rawCodeLanguage || referencedCell.language;
				lastCodeCell.addons.push({type, content, id: codeBlockStart.id});
			}
		} else if(codeBlockStart.blockType === 'code-with-id') {
			cells.push({
				language: 'markdown',
				content: `\`\`\`${language}\n${content}\n\`\`\``,
				kind: vscode.NotebookCellKind.Markup,
				leadingWhitespace: leadingWhitespace,
				trailingWhitespace: trailingWhitespace,
				indentation: codeBlockStart.indentation,
				rawCode: content,
				rawCodeLanguage: language,
				id: codeBlockStart.id,
				autorun: codeBlockStart.autorun,
				runonstart: codeBlockStart.runonstart,
				hidecode: codeBlockStart.hidecode,
				height: codeBlockStart.height
			});
		} else {
			throw new Error(`Unknown code block type: ${codeBlockStart.blockType}`);
		}
	}

	function parseMarkdownParagraph(leadingWhitespace: string): void {
		const startSourceIdx = i;
		while (true) {
			if (i >= lines.length) {
				break;
			}

			const currLine = lines[i];
			if (isGenericFencedMarkdownStart(currLine)) {
				i++;
				while (i < lines.length && !isCodeBlockEndLine(lines[i])) {
					i++;
				}

				if (i < lines.length) {
					i++;
				}
				continue;
			}

			if (currLine === '' || isCodeBlockStart(currLine)) {
				break;
			}

			i++;
		}

		const sourceLines = lines.slice(startSourceIdx, i);
		const indentation = commonIndentation(sourceLines);
		const content = sourceLines
			.map(line => stripIndentation(line, indentation))
			.join('\n');
		const trailingWhitespace = parseWhitespaceLines(false);
		cells.push({
			language: 'markdown',
			content,
			kind: vscode.NotebookCellKind.Markup,
			leadingWhitespace: leadingWhitespace,
			trailingWhitespace: trailingWhitespace,
			indentation
		});
	}

	return cells;
}

export function writeCellsToMarkdown(cells: ReadonlyArray<vscode.NotebookCellData>): string {
	let result = '';
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];
		if (i === 0) {
			result += cell.metadata?.leadingWhitespace ?? '';
		}

		if (cell.kind === vscode.NotebookCellKind.Code) {
			const metadata = cell.metadata as WebNbCellMetadata | undefined;
			const indentation = metadata?.indentation || '';
			const languageAbbrev = LANG_ABBREVS.get(cell.languageId) ?? cell.languageId;
			const openLine = indentation + '```{' + languageAbbrev + formatBlockAttributes(metadata) + '}';

			result += writeFencedBlock(openLine, cell.value, indentation);

			if(metadata?.addons && metadata.addons.length > 0) {
				for(let a = 0; a < metadata.addons.length; a++) {
					const addon = metadata.addons[a];
					// The gap the author left in front of this addon. A cell that
					// gained an addon while it was open has no recorded gap, so
					// fall back to closing the previous line and nothing more.
					const gap = metadata.addonWhitespace?.[a] ?? '\n';
					// A reference block carries no body of its own: its content
					// comes from the cell it names.
					const addonOpen = addon.id ? '```+id=' + addon.id : '```+' + addon.type;
					const addonBody = addon.id ? '' : addon.content;

					result += gap + writeFencedBlock(indentation + addonOpen, addonBody, indentation);
				}
			}
		} else {
			const metadata = cell.metadata as WebNbCellMetadata | undefined;
			const indentation = metadata?.indentation || '';
			// Every attribute formatBlockAttributes can write has to be listed
			// both here and in the strip below: missing it from the guard drops
			// the attribute on save, missing it from the strip duplicates it.
			if((metadata?.id || metadata?.autorun || metadata?.runonstart || metadata?.hidecode || metadata?.height) && cell.value.startsWith('```')) {
				const attributes = formatBlockAttributes(metadata);
				const addedid = cell.value.replace(/```([^\s\n]+)([^\n]*)\n/g,
												(_match, lang, rest) => {
													let newRest = rest.replace(/\s+id=\S+/g, '').replace(/\s+height=\S+/g, '').replace(/\bautorun\b/g, '').replace(/\brunonstart\b/g, '').replace(/\bhidecode\b/g, '');
													return `\`\`\`${lang}${attributes}${newRest}\n`;
												});
				result += applyIndentation(addedid, indentation);
			} else {
				result += applyIndentation(cell.value, indentation);
			}
		}

		result += getBetweenCellsWhitespace(cells, i);
	}
	return result;
}

function getBetweenCellsWhitespace(cells: ReadonlyArray<vscode.NotebookCellData>, idx: number): string {
	const thisCell = cells[idx];
	const nextCell = cells[idx + 1];

	if (!nextCell) {
		return thisCell.metadata?.trailingWhitespace ?? '\n';
	}

	const trailing = thisCell.metadata?.trailingWhitespace;
	const leading = nextCell.metadata?.leadingWhitespace;

	if (typeof trailing === 'string' && typeof leading === 'string') {
		return trailing + leading;
	}

	// One of the cells is new
	const combined = (trailing ?? '') + (leading ?? '');
	if (!combined || combined === '\n') {
		return '\n\n';
	}

	return combined;
}
