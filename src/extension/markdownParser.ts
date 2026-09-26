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
	/**
	 * Everything after the language in the fence header, exactly as written:
	 * ` id=5 autorun foo=bar` for `{html id=5 autorun foo=bar}`. The known
	 * attributes are also parsed into the fields above; this keeps the ones the
	 * format does not know, and the author's order and spacing, for the save.
	 */
	fenceAttributes?: string;
	/**
	 * The language as the author spelled it, when that is an alias rather than
	 * the canonical spelling (`jsx` for a `javascriptreact` cell), so a save does
	 * not rewrite `{jsx}` to `{react}`.
	 */
	languageAlias?: string;
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
	fenceAttributes?: string;
	languageAlias?: string;
}

/**
 * An addon as the parser stores it. A `+id=` block takes its content from the
 * cell it names, so any text written inside the block itself is not part of the
 * addon; it rides along here only so a save gives it back.
 */
interface StoredAddon extends Addon {
	referenceBody?: string;
}

/** Called with a description of each block the parser could not attach and kept as text. */
export type ParseWarningHandler = (message: string) => void;

interface BlockAttributes {
	id?: string;
	autorun?: boolean;
	runonstart?: boolean;
	hidecode?: boolean;
	height?: string;
}

type KnownAttribute = keyof BlockAttributes;

/** The order a save writes known attributes in when the header did not already have them. */
const KNOWN_ATTRIBUTE_ORDER: readonly KnownAttribute[] = ['id', 'autorun', 'runonstart', 'hidecode', 'height'];

/**
 * Which known attribute a header token sets, if any. Only whole tokens count:
 * `grid=3` is not an id, and `id=autorun-demo` does not turn autorun on.
 */
function knownAttributeName(token: string): KnownAttribute | undefined {
	if (token === 'autorun' || token === 'runonstart' || token === 'hidecode') {
		return token;
	}
	const equals = token.indexOf('=');
	if (equals > 0 && equals < token.length - 1) {
		const name = token.slice(0, equals);
		if (name === 'id' || name === 'height') {
			return name;
		}
	}
	return undefined;
}

function attributeTokens(text: string | undefined): string[] {
	return (text ?? '').split(/[ \t]+/).filter(token => token.length > 0);
}

/**
 * Parses the `id=5 autorun runonstart hidecode height=300` attributes after a
 * fence's language: whitespace-separated tokens, the first of each kind wins.
 * Anything else is left for `fenceAttributes` to carry.
 */
function parseBlockAttributes(rest: string): BlockAttributes {
	const attributes: BlockAttributes = {};
	for (const token of attributeTokens(rest)) {
		const name = knownAttributeName(token);
		if (!name || attributes[name] !== undefined) {
			continue;
		}
		if (name === 'id' || name === 'height') {
			// Taken verbatim, even a height that is not a length: dropping what
			// the author typed would delete it from the file on the next save.
			// Whether it means anything is shared/outputHeight's call.
			attributes[name] = token.slice(name.length + 1);
		} else {
			attributes[name] = true;
		}
	}
	return attributes;
}

function hasKnownAttributes(attributes: BlockAttributes | undefined): boolean {
	return !!(attributes?.id || attributes?.autorun || attributes?.runonstart || attributes?.hidecode || attributes?.height);
}

function formatKnownAttribute(name: KnownAttribute, metadata: WebNbCellMetadata | undefined): string | undefined {
	if (name === 'id' || name === 'height') {
		const value = metadata?.[name];
		return value ? `${name}=${value}` : undefined;
	}
	return metadata?.[name] ? name : undefined;
}

function sameKnownAttributes(parsed: BlockAttributes, metadata: WebNbCellMetadata | undefined): boolean {
	return (parsed.id || undefined) === (metadata?.id || undefined)
		&& (parsed.height || undefined) === (metadata?.height || undefined)
		&& !!parsed.autorun === !!metadata?.autorun
		&& !!parsed.runonstart === !!metadata?.runonstart
		&& !!parsed.hidecode === !!metadata?.hidecode;
}

/**
 * Renders the attributes back into fence text; the inverse of
 * parseBlockAttributes. The header the author wrote comes back byte for byte
 * while it still says what the metadata says. Otherwise each known attribute
 * is rewritten in place (or dropped), unknown tokens keep their order, and a
 * known attribute the header never had is appended.
 */
function formatBlockAttributes(metadata: WebNbCellMetadata | undefined): string {
	const authored = typeof metadata?.fenceAttributes === 'string' ? metadata.fenceAttributes : undefined;
	if (authored !== undefined && sameKnownAttributes(parseBlockAttributes(authored), metadata)) {
		return authored;
	}

	const written = new Set<KnownAttribute>();
	const parts: string[] = [];
	for (const token of attributeTokens(authored)) {
		const name = knownAttributeName(token);
		if (!name || written.has(name)) {
			// Unknown, or a repeat that parsing ignored: carried as written.
			parts.push(token);
			continue;
		}
		written.add(name);
		const formatted = formatKnownAttribute(name, metadata);
		if (formatted) {
			parts.push(formatted);
		}
	}
	for (const name of KNOWN_ATTRIBUTE_ORDER) {
		if (!written.has(name)) {
			const formatted = formatKnownAttribute(name, metadata);
			if (formatted) {
				parts.push(formatted);
			}
		}
	}
	return parts.map(part => ' ' + part).join('');
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

function languageForToken(token: string): string {
	return LANG_IDS.get(token) || token;
}

/** The fence language to write: the author's alias while it still names the cell's language. */
function languageTokenFor(languageId: string, alias: string | undefined): string {
	if (alias && languageForToken(alias) === languageId) {
		return alias;
	}
	return LANG_ABBREVS.get(languageId) ?? languageId;
}

/** A fence line: its indentation, the run of backticks or tildes, and what follows the run. */
interface FenceLine {
	indentation: string;
	marker: string;
	info: string;
}

/**
 * Matches a line that can open a fenced block. As in CommonMark, a backtick
 * fence's info string may not contain a backtick (that line is inline code).
 */
function matchFence(line: string): FenceLine | undefined {
	const match = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match || (match[2][0] === '`' && match[3].includes('`'))) {
		return undefined;
	}
	return { indentation: match[1], marker: match[2], info: match[3] };
}

/**
 * Whether `line` closes a block opened with `marker`. CommonMark's rule: the
 * same character, at least as many of it, and nothing after it but spaces. So
 * a ```` ```js ```` line inside a cell is content, not the end of the cell.
 */
function isClosingFence(line: string, marker: string): boolean {
	const match = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
	return !!match && match[1][0] === marker[0] && match[1].length >= marker.length;
}

/**
 * The fence to write around `body`: three backticks, or one more than the
 * longest backtick run any body line starts with, so no line of the body can
 * close the block early. Lines with an info string could not close it under
 * CommonMark, but an older parser would take any ```` ``` ```` line as the end.
 */
function fenceFor(body: string): string {
	let longest = 0;
	for (const line of body.split(/\r?\n/g)) {
		const run = /^[ \t]*(`{3,})/.exec(line);
		if (run) {
			longest = Math.max(longest, run[1].length);
		}
	}
	return '`'.repeat(Math.max(3, longest + 1));
}

interface ICodeBlockStart {
	langId: string;
	indentation: string;
	/** The fence run that opened the block; only a matching run closes it. */
	marker: string;
	blockType: 'user-code' | 'addon-code' | 'addon-reference' | 'code-with-id';
	id?: string;
	autorun?: boolean;
	runonstart?: boolean;
	hidecode?: boolean;
	height?: string;
	/** The header text after the language, for `fenceAttributes`. */
	attributeText?: string;
}

/**
 * Note - the indented code block parsing is basic. It should only be applied inside lists, indentation should be consistent across lines and
 * between the start and end blocks, etc. This is good enough for typical use cases.
 */
function parseCodeBlockStart(line: string): ICodeBlockStart | null {
	const fence = matchFence(line);
	// Cells and addons are always backtick fences; a tilde fence is prose.
	if (!fence || fence.marker[0] !== '`') {
		return null;
	}
	const { indentation, marker, info } = fence;

	// User code blocks with optional attributes: ```{html id=5 autorun}
	const userCodeMatch = /^\{([^}\s]+)(.*?)\}/.exec(info);
	if (userCodeMatch) {
		return {
			indentation,
			marker,
			langId: userCodeMatch[1],
			blockType: 'user-code',
			attributeText: userCodeMatch[2],
			...parseBlockAttributes(userCodeMatch[2])
		};
	}

	// Addon references: ```+id=5
	const addonRefMatch = /^\+id=(\S+)/.exec(info);
	if (addonRefMatch) {
		return {
			indentation,
			marker,
			langId: 'reference',
			blockType: 'addon-reference',
			id: addonRefMatch[1]
		};
	}

	// Code blocks with attributes but no braces: ```html id=5 or ```html autorun
	const codeWithIdMatch = /^([^\s+]\S*)([ \t].*)?$/.exec(info);
	if (codeWithIdMatch && codeWithIdMatch[2]) {
		const attributes = parseBlockAttributes(codeWithIdMatch[2]);
		if (hasKnownAttributes(attributes)) {
			return {
				indentation,
				marker,
				langId: codeWithIdMatch[1],
				blockType: 'code-with-id',
				attributeText: codeWithIdMatch[2],
				// hidecode/height are carried so they survive a save; a
				// code-with-id block becomes a markup cell, which has no output.
				...attributes
			};
		}
	}

	// Addon code blocks: ```+test
	const addonCodeMatch = /^\+(\S*)/.exec(info);
	if (addonCodeMatch) {
		return {
			indentation,
			marker,
			langId: addonCodeMatch[1],
			blockType: 'addon-code'
		};
	}

	return null;
}

function isCodeBlockStart(line: string): boolean {
	return !!parseCodeBlockStart(line);
}

/**
 * A fenced block: opening line, body, closing fence.
 *
 * An empty body closes on the very next line. Both `\`\`\`x` + `\`\`\`` and
 * `\`\`\`x` + blank + `\`\`\`` parse to empty content, so this is the canonical
 * form the serializer settles on for either.
 */
function writeFencedBlock(openLine: string, body: string, indentation: string, marker: string): string {
	const closing = indentation + marker;
	if (body === '') {
		return openLine + '\n' + closing;
	}
	return openLine + '\n' + applyIndentation(body, indentation) + '\n' + closing;
}

export function parseMarkdown(content: string, onWarning?: ParseWarningHandler): RawNotebookCell[] {
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

	function warn(lineIndex: number, problem: string): void {
		onWarning?.(`line ${lineIndex + 1}: ${problem}, so it is shown as text.`);
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

	/** The index of the line that closes the block opened on `openIndex`, or -1 when nothing does. */
	function findClosingFence(openIndex: number, marker: string): number {
		for (let index = openIndex + 1; index < lines.length; index++) {
			if (isClosingFence(lines[index], marker)) {
				return index;
			}
		}
		return -1;
	}

	/**
	 * Keeps lines the parser could not make sense of as one markup cell, exactly
	 * as written: the notebook still opens, the author can see what is wrong,
	 * and a save writes the same bytes back.
	 */
	function pushRawMarkdown(leadingWhitespace: string, start: number, end: number): void {
		const sourceLines = lines.slice(start, end);
		i = end;
		const indentation = commonIndentation(sourceLines);
		cells.push({
			language: 'markdown',
			content: sourceLines.map(line => stripIndentation(line, indentation)).join('\n'),
			kind: vscode.NotebookCellKind.Markup,
			leadingWhitespace,
			trailingWhitespace: parseWhitespaceLines(false),
			indentation
		});
	}

	function parseCodeBlock(leadingWhitespace: string, codeBlockStart: ICodeBlockStart): void {
		const openIndex = i;
		const closeIndex = findClosingFence(openIndex, codeBlockStart.marker);
		if (closeIndex < 0) {
			warn(openIndex, `\`${lines[openIndex].trim()}\` is never closed`);
			pushRawMarkdown(leadingWhitespace, openIndex, lines.length);
			return;
		}

		if (codeBlockStart.blockType === 'addon-code' || codeBlockStart.blockType === 'addon-reference') {
			// An addon belongs to the code cell right above it; only whitespace
			// may sit in between. Attaching across prose would move that prose
			// below the addon on the next save.
			const owner = cells[cells.length - 1];
			if (!owner || owner.kind !== vscode.NotebookCellKind.Code) {
				warn(openIndex, `\`${lines[openIndex].trim()}\` is not directly below a code cell`);
				pushRawMarkdown(leadingWhitespace, openIndex, closeIndex + 1);
				return;
			}
			if (codeBlockStart.blockType === 'addon-reference' && !cells.some(c => c.id === codeBlockStart.id)) {
				warn(openIndex, `\`+id=${codeBlockStart.id}\` does not name an earlier cell`);
				pushRawMarkdown(leadingWhitespace, openIndex, closeIndex + 1);
				return;
			}
		}

		const language = languageForToken(codeBlockStart.langId);
		const content = lines.slice(openIndex + 1, closeIndex)
			.map(line => stripIndentation(line, codeBlockStart.indentation))
			.join('\n');
		i = closeIndex + 1;
		const trailingWhitespace = parseWhitespaceLines(false);
		const attributes = {
			id: codeBlockStart.id,
			autorun: codeBlockStart.autorun,
			runonstart: codeBlockStart.runonstart,
			hidecode: codeBlockStart.hidecode,
			height: codeBlockStart.height,
			...(codeBlockStart.attributeText ? { fenceAttributes: codeBlockStart.attributeText } : {})
		};

		if(codeBlockStart.blockType === 'user-code') {
			cells.push({
				language,
				content,
				kind: vscode.NotebookCellKind.Code,
				leadingWhitespace: leadingWhitespace,
				trailingWhitespace: trailingWhitespace,
				indentation: codeBlockStart.indentation,
				addons: [],
				...attributes,
				...(codeBlockStart.langId !== languageTokenFor(language, undefined) ? { languageAlias: codeBlockStart.langId } : {}),
				rawCode: content,
				rawCodeLanguage: language
			});
		} else if(codeBlockStart.blockType === 'addon-code' || codeBlockStart.blockType === 'addon-reference') {
			const lastCodeCell = cells[cells.length - 1];
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
				const referencedCell = cells.find(c => c.id === codeBlockStart.id)!;
				const addon: StoredAddon = {
					type: referencedCell.rawCodeLanguage || referencedCell.language,
					content: referencedCell.rawCode || referencedCell.content,
					id: codeBlockStart.id
				};
				if (content !== '') {
					addon.referenceBody = content;
				}
				lastCodeCell.addons.push(addon);
			}
		} else if(codeBlockStart.blockType === 'code-with-id') {
			// Shown as the fenced block it is, minus the attributes (the
			// metadata carries those, and a save puts them back). The author's
			// own spelling of the language and fence are kept.
			const fence = codeBlockStart.marker;
			const shown = fence + codeBlockStart.langId + '\n' + (content === '' ? '' : content + '\n') + fence;
			cells.push({
				language: 'markdown',
				content: shown,
				kind: vscode.NotebookCellKind.Markup,
				leadingWhitespace: leadingWhitespace,
				trailingWhitespace: trailingWhitespace,
				indentation: codeBlockStart.indentation,
				rawCode: content,
				rawCodeLanguage: language,
				...attributes
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
			const fence = isCodeBlockStart(currLine) ? undefined : matchFence(currLine);
			if (fence) {
				// A fenced block inside prose is prose to its closing fence:
				// blank lines and cell-looking fences in it are example text.
				i++;
				while (i < lines.length && !isClosingFence(lines[i], fence.marker)) {
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

/**
 * Whether an addon can be written as a fence at all. The parser only ever
 * produces types and ids without whitespace or backticks; one that has them
 * came from somewhere else, and writing it would break the fence line -- or
 * smuggle a cell of its own into the file -- so it is left out.
 */
function isWritableAddon(addon: StoredAddon): boolean {
	return typeof addon?.type === 'string' && /^[^\s`]*$/.test(addon.type)
		&& typeof addon.content === 'string'
		&& (addon.id === undefined || (typeof addon.id === 'string' && /^[^\s`]*$/.test(addon.id)));
}

/**
 * The first line of a code-with-id markup cell, with the metadata's attributes
 * put back after the language. Anything else the reader typed after the
 * language is kept, minus attributes the metadata already writes.
 */
function withBlockAttributes(firstLine: string, metadata: WebNbCellMetadata | undefined): string {
	const match = /^(`{3,}|~{3,})(\S*)(.*)$/.exec(firstLine);
	if (!match) {
		return firstLine;
	}
	const typed = attributeTokens(match[3])
		.filter(token => !knownAttributeName(token))
		.map(token => ' ' + token)
		.join('');
	return match[1] + match[2] + formatBlockAttributes(metadata) + typed;
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
			const languageToken = languageTokenFor(cell.languageId, metadata?.languageAlias);
			const fence = fenceFor(cell.value);
			const openLine = indentation + fence + '{' + languageToken + formatBlockAttributes(metadata) + '}';

			result += writeFencedBlock(openLine, cell.value, indentation, fence);

			if(metadata?.addons && metadata.addons.length > 0) {
				for(let a = 0; a < metadata.addons.length; a++) {
					const addon = metadata.addons[a] as StoredAddon;
					if (!isWritableAddon(addon)) {
						continue;
					}
					// The gap the author left in front of this addon. A cell that
					// gained an addon while it was open has no recorded gap, so
					// fall back to closing the previous line and nothing more.
					const gap = metadata.addonWhitespace?.[a] ?? '\n';
					// A reference block's content comes from the cell it names;
					// the only body it writes is whatever the author left in it.
					const addonBody = addon.id ? (addon.referenceBody ?? '') : addon.content;
					const addonFence = fenceFor(addonBody);
					const addonOpen = addon.id ? addonFence + '+id=' + addon.id : addonFence + '+' + addon.type;

					result += gap + writeFencedBlock(indentation + addonOpen, addonBody, indentation, addonFence);
				}
			}
		} else {
			const metadata = cell.metadata as WebNbCellMetadata | undefined;
			const indentation = metadata?.indentation || '';
			if (hasKnownAttributes(metadata) && /^(`{3,}|~{3,})/.test(cell.value)) {
				// Only the first line is the header: a fence further down is the
				// author's own markdown and is written as it stands.
				const newline = cell.value.indexOf('\n');
				const firstLine = newline < 0 ? cell.value : cell.value.slice(0, newline);
				const remainder = newline < 0 ? '' : cell.value.slice(newline);
				result += applyIndentation(withBlockAttributes(firstLine, metadata) + remainder, indentation);
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
