import './tddBridge';
import * as assert from 'assert';
import type { Addon, RequestedPathReference } from '../../shared/protocol';
import {
    getRequestedChecklistFilePaths,
    getRequestedFilePaths,
    getRequestedFilePathsFromTestSource,
    normalizeWorkspacePath,
    parseRequestedPathLine,
    parseRequestedPathReference,
    resolveWorkspaceRelativePath
} from '../../shared/filePaths';

function ref(requestPath: string, path: string, base: 'notebook' | 'workspace'): RequestedPathReference {
    return { requestPath, path, base };
}

suite('shared/filePaths', () => {
    suite('parseRequestedPathReference', () => {
        const cases: [input: string, expected: RequestedPathReference][] = [
            ['src/a.ts', ref('src/a.ts', 'src/a.ts', 'notebook')],
            ['  a.txt  ', ref('a.txt', 'a.txt', 'notebook')],
            // Backslashes become forward slashes.
            ['src\\lib\\x.ts', ref('src/lib/x.ts', 'src/lib/x.ts', 'notebook')],
            // `workspace:` prefix.
            ['workspace:src/a.ts', ref('workspace:src/a.ts', 'src/a.ts', 'workspace')],
            // Odd spacing and case are normalized into a canonical requestPath.
            ['workspace: src/a.ts', ref('workspace:src/a.ts', 'src/a.ts', 'workspace')],
            ['WORKSPACE :  foo\\bar', ref('workspace:foo/bar', 'foo/bar', 'workspace')],
            ['Workspace:x', ref('workspace:x', 'x', 'workspace')],
            // Empty scoped path is preserved as-is.
            ['workspace:', ref('workspace:', '', 'workspace')]
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${expected.requestPath} (${expected.base})`, () => {
                assert.deepStrictEqual(parseRequestedPathReference(input), expected);
            });
        }
    });

    suite('parseRequestedPathLine', () => {
        const cases: [input: string, expected: string | undefined][] = [
            ['a.txt', 'a.txt'],
            ['  a.txt  ', 'a.txt'],
            // Comments and empty lines yield undefined.
            ['# a comment', undefined],
            ['', undefined],
            ['   ', undefined],
            // List markers and checkboxes are stripped.
            ['- a.txt', 'a.txt'],
            ['* a.txt', 'a.txt'],
            ['[x] a.txt', 'a.txt'],
            ['[ ] a.txt', 'a.txt'],
            // Backticks are unwrapped.
            ['`a b.txt`', 'a b.txt'],
            ['- `a.txt`', 'a.txt'],
            // A bare dash is not a list marker (no trailing space after trim).
            ['- ', '-']
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(parseRequestedPathLine(input), expected);
            });
        }
    });

    suite('getRequestedChecklistFilePaths', () => {
        test('includes path-bearing kinds and their aliases, strips prefixes', () => {
            const source = [
                '# a comment',
                'Bare title line without a colon',
                'file: src/app.js | label',
                'dir: src',
                'includes: notes.md | TODO | label',
                '- [x] contains: listed.txt | needle',
                'path: workspace:shared/util.js'
            ].join('\n');

            assert.deepStrictEqual(getRequestedChecklistFilePaths(source), [
                ref('src/app.js', 'src/app.js', 'notebook'),
                ref('src', 'src', 'notebook'),
                ref('notes.md', 'notes.md', 'notebook'),
                ref('listed.txt', 'listed.txt', 'notebook'),
                ref('workspace:shared/util.js', 'shared/util.js', 'workspace')
            ]);
        });

        test('excludes `command:` and unknown kinds', () => {
            const source = [
                'command: npm test | Run the tests',
                'cmd: npm install',
                'bogus: whatever.txt',
                'file: kept.txt'
            ].join('\n');

            assert.deepStrictEqual(getRequestedChecklistFilePaths(source), [
                ref('kept.txt', 'kept.txt', 'notebook')
            ]);
        });

        test('skips lines with an empty path field', () => {
            assert.deepStrictEqual(getRequestedChecklistFilePaths('file:\nfile:   '), []);
        });
    });

    suite('getRequestedFilePathsFromTestSource', () => {
        test('finds check.file/directory/path/exists with each quote style', () => {
            const source = [
                'check.directory("some/dir");',
                'check.path(`ticked.txt`);',
                "check.exists('there.txt');",
                'check . directory ( "spaced" );'
            ].join('\n');

            assert.deepStrictEqual(getRequestedFilePathsFromTestSource(source), [
                ref('some/dir', 'some/dir', 'notebook'),
                ref('ticked.txt', 'ticked.txt', 'notebook'),
                ref('there.txt', 'there.txt', 'notebook'),
                ref('spaced', 'spaced', 'notebook')
            ]);
        });

        test('finds bare file(...) calls', () => {
            assert.deepStrictEqual(getRequestedFilePathsFromTestSource("file('e.txt')"), [
                ref('e.txt', 'e.txt', 'notebook')
            ]);
            assert.deepStrictEqual(getRequestedFilePathsFromTestSource('file("q.txt")'), [
                ref('q.txt', 'q.txt', 'notebook')
            ]);
            assert.deepStrictEqual(getRequestedFilePathsFromTestSource('file(`r.txt`)'), [
                ref('r.txt', 'r.txt', 'notebook')
            ]);
        });

        test('check.file(...) matches both patterns and is reported twice (deduped later)', () => {
            assert.deepStrictEqual(getRequestedFilePathsFromTestSource("check.file('a.txt')"), [
                ref('a.txt', 'a.txt', 'notebook'),
                ref('a.txt', 'a.txt', 'notebook')
            ]);
        });

        test('all check.* matches come before bare file(...) matches', () => {
            const source = "file('z.txt');\ncheck.path('a.txt');";
            assert.deepStrictEqual(getRequestedFilePathsFromTestSource(source), [
                ref('a.txt', 'a.txt', 'notebook'),
                ref('z.txt', 'z.txt', 'notebook')
            ]);
        });

        test('does not match identifiers merely ending in "file"', () => {
            assert.deepStrictEqual(getRequestedFilePathsFromTestSource("profile('p.png')"), []);
        });
    });

    suite('getRequestedFilePaths', () => {
        test('collects lines from files-addon variants, skipping other addon types', () => {
            const addons: Addon[] = [
                { type: '+files', content: 'a.txt\n# comment\n- b.txt' },
                { type: 'Files', content: 'a.txt' },
                { type: 'file', content: 'c.txt' },
                { type: '+workspace-files', content: 'ws.txt' },
                { type: 'test', content: 'not-a-path.txt' }
            ];

            assert.deepStrictEqual(getRequestedFilePaths(addons, 'javascript', ''), [
                ref('a.txt', 'a.txt', 'notebook'),
                ref('b.txt', 'b.txt', 'notebook'),
                ref('c.txt', 'c.txt', 'notebook'),
                ref('ws.txt', 'ws.txt', 'notebook')
            ]);
        });

        test('external languages add checklist paths and script-addon test sources', () => {
            const addons: Addon[] = [
                { type: '+test', content: "check.file('t.txt')" },
                { type: 'js', content: "file('j.txt')" },
                { type: 'solution', content: "file('ignored.txt')" }
            ];
            const source = 'file: c.txt';

            for (const languageId of ['external', 'checklist']) {
                assert.deepStrictEqual(getRequestedFilePaths(addons, languageId, source), [
                    ref('c.txt', 'c.txt', 'notebook'),
                    ref('t.txt', 't.txt', 'notebook'),
                    ref('j.txt', 'j.txt', 'notebook')
                ], `languageId: ${languageId}`);
            }
        });

        test('non-external languages ignore checklist source and test addons', () => {
            const addons: Addon[] = [{ type: '+test', content: "check.file('t.txt')" }];
            assert.deepStrictEqual(getRequestedFilePaths(addons, 'javascript', 'file: c.txt'), []);
        });

        test('walkthrough language collects `file:` lines', () => {
            const source = [
                'title: Tour',
                'file: w.ts',
                'some commentary',
                'FILE:  workspace:x.ts '
            ].join('\n');

            assert.deepStrictEqual(getRequestedFilePaths([], 'walkthrough', source), [
                ref('w.ts', 'w.ts', 'notebook'),
                ref('workspace:x.ts', 'x.ts', 'workspace')
            ]);
        });

        test('de-duplicates by requestPath across sources', () => {
            const addons: Addon[] = [{ type: 'files', content: 'c.txt\nc.txt\nworkspace: s.txt' }];
            assert.deepStrictEqual(getRequestedFilePaths(addons, 'external', 'file: c.txt\nfile: workspace:s.txt'), [
                ref('c.txt', 'c.txt', 'notebook'),
                ref('workspace:s.txt', 's.txt', 'workspace')
            ]);
        });
    });

    suite('normalizeWorkspacePath', () => {
        const cases: [input: string, expected: string | undefined][] = [
            ['a.txt', 'a.txt'],
            ['  a.txt ', 'a.txt'],
            // Collapses `./`, duplicate slashes, and backslashes.
            ['./a/./b', 'a/b'],
            ['a//b/./c', 'a/b/c'],
            ['a\\b\\c', 'a/b/c'],
            ['a/', 'a'],
            // Rejects absolute paths.
            ['/abs/path', undefined],
            // Rejects `..` anywhere.
            ['..', undefined],
            ['a/../b', undefined],
            // Rejects drive letters (after backslash normalization too).
            ['C:/x', undefined],
            ['c:\\x', undefined],
            // Rejects empty results.
            ['', undefined],
            ['   ', undefined],
            ['.', undefined],
            ['./', undefined]
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(normalizeWorkspacePath(input), expected);
            });
        }
    });

    suite('resolveWorkspaceRelativePath', () => {
        test('workspace-based references resolve from the workspace root', () => {
            assert.strictEqual(resolveWorkspaceRelativePath({ base: 'workspace' }, 'a/b.txt', 'notebooks/ch1'), 'a/b.txt');
            assert.strictEqual(resolveWorkspaceRelativePath({ base: 'workspace' }, 'a/b.txt', ''), 'a/b.txt');
        });

        test('notebook-based references resolve from the notebook directory', () => {
            assert.strictEqual(resolveWorkspaceRelativePath({ base: 'notebook' }, 'a/b.txt', 'notebooks/ch1'), 'notebooks/ch1/a/b.txt');
        });

        test('notebook-based references with an empty relative dir stay as-is', () => {
            assert.strictEqual(resolveWorkspaceRelativePath({ base: 'notebook' }, 'a/b.txt', ''), 'a/b.txt');
        });
    });
});
