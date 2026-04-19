// Source: https://github.com/microsoft/vscode-markdown-notebook/blob/main/src/markdownParser.ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface RawNotebookCell {
	indentation?: string;
	leadingWhitespace: string;
	trailingWhitespace: string;
	language: string;
	content: string;
	kind: vscode.NotebookCellKind;
	addons?: {type: string, content: string, id?: string}[];
	id?: string;
	autorun?: boolean;
	rawCode?: string;
	rawCodeLanguage?: string;
}

const LANG_IDS = new Map([
	['javascript', 'javascript'],
	['css', 'css'],
	['html', 'html'],
	['mcq', 'mcq'],
	['external', 'external'],
	['checklist', 'checklist']
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
}

/**
 * Note - the indented code block parsing is basic. It should only be applied inside lists, indentation should be consistent across lines and
 * between the start and end blocks, etc. This is good enough for typical use cases.
 */
function parseCodeBlockStart(line: string): ICodeBlockStart | null {
	// Match user code blocks with optional ID and autorun: ```{html id=5 autorun}
	const userCodeBlockMatch = line.match(/(    |\t)?```\{([^\}\s]+)(.*?)\}/);
	if(userCodeBlockMatch) {
		const langId = userCodeBlockMatch[2];
		const rest = userCodeBlockMatch[3] || '';
		let id, autorun;
		const idMatch = rest.match(/id=(\S+)/);
		if (idMatch) {
			id = idMatch[1];
		}
		if (/\bautorun\b/.test(rest)) {
			autorun = true;
		}

		return {
			indentation: userCodeBlockMatch[1],
			langId,
			blockType: 'user-code',
			id,
			autorun
		};
	} else {
		// Match addon references: ```+id=5
		const addonRefMatch = line.match(/(    |\t)?```\+id=(\S+)/);
		if (addonRefMatch) {
			return {
				indentation: addonRefMatch[1],
				langId: 'reference',
				blockType: 'addon-reference',
				id: addonRefMatch[2]
			};
		}

		// Match code blocks with type ```html id=5 or ```html autorun
		const codeWithIdMatch = line.match(/(    |\t)?```([^\s+]\S*)(?:\s+(.+))?/);
		if(codeWithIdMatch && codeWithIdMatch[3]) {
			const rest = codeWithIdMatch[3];
			let id, autorun;
			const idMatch = rest.match(/id\s*=\s*(\S+)/);
			if (idMatch) {
				id = idMatch[1];
			}
			if (/\bautorun\b/.test(rest)) {
				autorun = true;
			}
			
			if (id || autorun) {
				return {
					indentation: codeWithIdMatch[1],
					langId: codeWithIdMatch[2],
					blockType: 'code-with-id',
					id,
					autorun
				};
			}
		}

		// Match addon code blocks: ```+test
		const addonCodeMatch = line.match(/(    |\t)?```\+(\S*)(\s+(\S*))?/);
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

function isCodeBlockEndLine(line: string): boolean {
	return !!line.match(/^\s*```/);
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
			.map(line => line.replace(new RegExp('^' + codeBlockStart.indentation), ''))
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
				rawCode: content,
				rawCodeLanguage: language,
				id: codeBlockStart.id,
				autorun: codeBlockStart.autorun
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
			if (currLine === '' || isCodeBlockStart(currLine)) {
				break;
			}

			i++;
		}

		const content = lines.slice(startSourceIdx, i).join('\n');
		const trailingWhitespace = parseWhitespaceLines(false);
		cells.push({
			language: 'markdown',
			content,
			kind: vscode.NotebookCellKind.Markup,
			leadingWhitespace: leadingWhitespace,
			trailingWhitespace: trailingWhitespace
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
			const indentation = cell.metadata?.indentation || '';
			const languageAbbrev = LANG_ABBREVS.get(cell.languageId) ?? cell.languageId;
			const idPart = cell.metadata?.id ? ` id=${cell.metadata.id}` : '';
			const autorunPart = cell.metadata?.autorun ? ' autorun' : '';
			const codePrefix = indentation + '```{' + languageAbbrev + idPart + autorunPart + '}\n';
			const contents = cell.value.split(/\r?\n/g)
				.map(line => indentation + line)
				.join('\n');
			const codeSuffix = '\n' + indentation + '```';

			result += codePrefix + contents + codeSuffix;

			if(cell.metadata?.addons && cell.metadata.addons.length > 0) {
				for(const addon of cell.metadata.addons) {
					if(addon.id) {
						result += '\n' + indentation + '```+id=' + addon.id + '\n';
						result += '\n' + indentation + '```';
					} else {
						const addonPrefix = '\n' + indentation + '```+' + addon.type + '\n';
						const addonContents = addon.content.split(/\r?\n/g).map((line:string) => indentation + line).join('\n');
						const addonSuffix = '\n' + indentation + '```';

						result += addonPrefix + addonContents + addonSuffix;
					}
				}
			}
		} else {
			if((cell.metadata?.id || cell.metadata?.autorun) && cell.value.startsWith('```')) {
				const idPart = cell.metadata?.id ? ` id=${cell.metadata.id}` : '';
				const autorunPart = cell.metadata?.autorun ? ' autorun' : '';
				const addedid = cell.value.replace(/```([^\s\n]+)([^\n]*)\n/g,
												(_match, lang, rest) => {
													let newRest = rest.replace(/\s+id=\S+/g, '').replace(/\bautorun\b/g, '');
													return `\`\`\`${lang}${idPart}${autorunPart}${newRest}\n`;
												});
				result += addedid;
			} else {
				result += cell.value;
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
