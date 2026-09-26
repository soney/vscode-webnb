import './tdd';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseMarkdown, writeCellsToMarkdown } from '../../extension/markdownParser';
import { activate as activateSerializer, deserializeWebnb, serializeWebnb } from '../../extension/serializer';
import * as stub from './vscodeStub';
import { decode, encode } from './helpers';

/** Open then save, with the cell data cloned the way the extension host clones it. */
function roundTrip(text: string, edit?: (cells: vscode.NotebookCellData[]) => void): string {
    const data = deserializeWebnb(encode(text));
    const cells = JSON.parse(JSON.stringify(data.cells)) as vscode.NotebookCellData[];
    edit?.(cells);
    return decode(serializeWebnb({ cells, metadata: data.metadata }));
}

function codeCells(text: string) {
    return parseMarkdown(text).filter(cell => cell.kind === vscode.NotebookCellKind.Code);
}

suite('extension/markdownParser', () => {
    setup(() => stub.resetStub());

    suite('fences inside bodies (a ``` line must not split the cell)', () => {
        test('a body with a ``` line is written inside a longer fence and reopens as one cell', () => {
            const saved = roundTrip('Intro\n\n```{javascript}\nx\n```\n', cells => {
                cells[1].value = 'Here is my code:\n```js\nconsole.log("hi");\n```';
            });
            assert.ok(saved.includes('````{javascript}\n'), saved);
            const cells = parseMarkdown(saved);
            assert.deepStrictEqual(cells.map(cell => cell.kind), [vscode.NotebookCellKind.Markup, vscode.NotebookCellKind.Code]);
            assert.strictEqual(cells[1].content, 'Here is my code:\n```js\nconsole.log("hi");\n```');
        });

        test('the fence is one longer than the longest run a body line starts with', () => {
            const saved = roundTrip('```{javascript}\nx\n```\n', cells => {
                cells[0].value = 'a\n  `````\nb';
            });
            assert.ok(saved.startsWith('``````{javascript}\n'), saved);
            assert.strictEqual(codeCells(saved)[0].content, 'a\n  `````\nb');
        });

        test('bodies without fence lines keep the plain three-backtick fence', () => {
            const text = '```{html id=a}\n<p>`inline` code</p>\n```\n```+test\nassert("p")\n```\n';
            assert.strictEqual(roundTrip(text), text);
        });

        test('addon bodies are escaped too, and captured starters with fences survive', () => {
            const saved = roundTrip('```{javascript}\nx\n```\n', cells => {
                (cells[0].metadata as { addons: unknown[] }).addons = [{ type: 'default', content: 'a\n```\nb' }];
            });
            assert.ok(saved.includes('````+default\na\n```\nb\n````'), saved);
            const [cell] = codeCells(saved);
            assert.deepStrictEqual(cell.addons, [{ type: 'default', content: 'a\n```\nb' }]);
        });

        test('closing follows CommonMark: same character, at least as long, no info string', () => {
            const cells = codeCells([
                '````{javascript}',
                '```',
                '```js',
                '~~~',
                '````',
                ''
            ].join('\n'));
            assert.strictEqual(cells.length, 1);
            assert.strictEqual(cells[0].content, '```\n```js\n~~~');
        });

        test('a tilde fence in prose keeps cell-looking lines as example text', () => {
            const cells = parseMarkdown('Example:\n~~~\n```{html}\n<b>x</b>\n\n```\n~~~\n');
            assert.strictEqual(cells.length, 1);
            assert.strictEqual(cells[0].kind, vscode.NotebookCellKind.Markup);
        });

        test('an addon type or id that would break the fence line is not written', () => {
            const saved = roundTrip('```{javascript}\nx\n```\n', cells => {
                (cells[0].metadata as { addons: unknown[] }).addons = [
                    { type: 'x\n```\n\n```{javascript autorun}\nalert(1)', content: '' },
                    { type: 'test', content: 'ok' }
                ];
            });
            assert.strictEqual(saved, '```{javascript}\nx\n```\n```+test\nok\n```\n');
        });
    });

    suite('fence attributes', () => {
        test('id= counts only as a whole token', () => {
            const [cell] = codeCells('```{html grid=3}\n<b>x</b>\n```\n');
            assert.strictEqual(cell.id, undefined);
            assert.strictEqual(roundTrip('```{html grid=3}\n<b>x</b>\n```\n'), '```{html grid=3}\n<b>x</b>\n```\n');
        });

        test('flags count only as whole tokens', () => {
            const [cell] = codeCells('```{html id=autorun-demo}\n<b>x</b>\n```\n');
            assert.strictEqual(cell.id, 'autorun-demo');
            assert.strictEqual(cell.autorun, undefined);
            const [withFlags] = codeCells('```{javascript autorun hidecode runonstart height=300}\nx\n```\n');
            assert.deepStrictEqual([withFlags.autorun, withFlags.hidecode, withFlags.runonstart, withFlags.height], [true, true, true, '300']);
        });

        test('unknown tokens, order and spacing survive a save', () => {
            for (const text of [
                '```{html foo=bar}\n<b>x</b>\n```\n',
                '```{javascript height=300 id=c1 autorun}\nx\n```\n',
                '```{html  id=a   extra }\n<b>x</b>\n```\n',
                '```html id=layout note=keep\n<h1>x</h1>\n```\n'
            ]) {
                assert.strictEqual(roundTrip(text), text);
            }
        });

        test('a changed attribute is rewritten in place; unknown tokens keep their order', () => {
            const saved = roundTrip('```{html foo id=a bar hidecode}\n<b>x</b>\n```\n', cells => {
                const metadata = cells[0].metadata as Record<string, unknown>;
                metadata.id = 'b';
                metadata.hidecode = false;
                metadata.autorun = true;
            });
            assert.strictEqual(saved, '```{html foo id=b bar autorun}\n<b>x</b>\n```\n');
        });

        test('the {jsx} alias is kept; a language change writes the canonical name', () => {
            const text = '```{jsx}\nrenderReact(<b />);\n```\n';
            assert.strictEqual(roundTrip(text), text);
            assert.strictEqual(deserializeWebnb(encode(text)).cells[0].languageId, 'javascriptreact');
            assert.strictEqual(roundTrip(text, cells => { cells[0].languageId = 'javascript'; }), '```{javascript}\nrenderReact(<b />);\n```\n');
            assert.strictEqual(roundTrip('```{react}\nx\n```\n'), '```{react}\nx\n```\n');
        });
    });

    suite('parse problems degrade instead of throwing', () => {
        const cases: [label: string, text: string][] = [
            ['an addon before any code cell', '# T\n\n```+test\nassert(1)\n```\n'],
            ['an addon separated from its cell by prose', '```{html}\n<b>x</b>\n```\n\nSome prose.\n```+test\nassert("b")\n```\n\nAfter\n'],
            ['an unresolved +id= reference', '```{css}\nh1{}\n```\n```+id=layout\n```\n\n```html id=layout\n<h1>x</h1>\n```\n'],
            ['a fence that is never closed', '# T\n\n```{html}\n<h1>a</h1>\n<p>b</p>'],
            ['a closing fence with text after it', '```{html}\n<b>x</b>\n```   trailing\n']
        ];
        for (const [label, text] of cases) {
            test(`${label}: kept as text, warned about, byte-identical`, () => {
                const warnings: string[] = [];
                const cells = parseMarkdown(text, warning => warnings.push(warning));
                assert.ok(warnings.length > 0, 'expected a warning');
                assert.ok(cells.some(cell => cell.kind === vscode.NotebookCellKind.Markup && /^(`{3,})/.test(cell.content)));
                assert.strictEqual(roundTrip(text), text);
            });
        }

        test('prose between a cell and an addon stays where it is', () => {
            const cells = parseMarkdown('```{html}\n<b>x</b>\n```\n\nSome prose.\n```+test\nassert("b")\n```\n');
            assert.deepStrictEqual(cells.map(cell => cell.content), ['<b>x</b>', 'Some prose.', '```+test\nassert("b")\n```']);
            assert.deepStrictEqual(cells[0].addons, []);
        });

        test('text inside a +id= block is kept', () => {
            const text = '```html id=a\n<p>x</p>\n```\n\n```{css}\np{}\n```\n```+id=a\nSOME BODY TEXT\n```\n';
            assert.strictEqual(roundTrip(text), text);
            const [css] = codeCells(text);
            assert.strictEqual(css.addons?.[0].content, '<p>x</p>');
        });
    });

    suite('serializer', () => {
        test('CRLF line endings and a UTF-8 BOM survive a round trip', () => {
            const crlf = '# Title\r\n\r\n```{html}\r\n<h1>x</h1>\r\n```\r\n';
            assert.strictEqual(roundTrip(crlf), crlf);
            const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('# T\n\n```{html}\n<b>x</b>\n```\n')]);
            const data = deserializeWebnb(bom);
            assert.strictEqual(data.cells[0].value, '# T');
            assert.deepStrictEqual([...serializeWebnb(data)], [...bom]);
        });

        test('outputs are transient, so running a cell never dirties the notebook', () => {
            activateSerializer({ subscriptions: [] } as unknown as vscode.ExtensionContext);
            const [registration] = stub.testing.serializers;
            assert.strictEqual(registration.type, 'web-notebook');
            assert.strictEqual((registration.options as vscode.NotebookDocumentContentOptions).transientOutputs, true);
        });

        test('writeCellsToMarkdown keeps the canonical empty-cell form', () => {
            const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'html');
            assert.strictEqual(writeCellsToMarkdown([cell]), '```{html}\n```\n');
        });
    });
});
