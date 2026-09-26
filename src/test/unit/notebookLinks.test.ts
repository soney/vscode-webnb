import './tddBridge';
import * as assert from 'assert';
import {
    atxHeading,
    findSectionCell,
    findSections,
    headingDisplayText,
    isLinkHandlerConfigMessage,
    isLinkHandlerHelloMessage,
    isOpenNotebookLinkMessage,
    parseNotebookLinkHref,
    slugifySection,
    type NotebookLinkTarget
} from '../../shared/notebookLinks';

suite('shared/notebookLinks', () => {
    suite('slugifySection', () => {
        // Every expectation here was read back out of VS Code's own notebook
        // markdown renderer (the `id` it puts on the rendered heading). They are
        // the contract: a link anchor and the anchor VS Code renders must agree.
        const cases: [heading: string, slug: string][] = [
            ['Link Test A', 'link-test-a'],
            ['Section Two', 'section-two'],
            ["What's fetch, really?", 'whats-fetch-really'],
            ['Arrays & Objects (Part 2)', 'arrays--objects-part-2'],
            ['Using for...of', 'using-forof'],
            ['1. First Step', '1-first-step'],
            ['Mixed CASE Heading', 'mixed-case-heading'],
            ['Hyphen - already - here', 'hyphen---already---here'],
            ['Emoji 🎉 heading', 'emoji-%F0%9F%8E%89-heading'],
            // Leading and trailing hyphens come off; underscores stay.
            ['  Trailing spaces  ', 'trailing-spaces'],
            ['- dashed -', 'dashed'],
            ['snake_case_name', 'snake_case_name'],
        ];

        for (const [heading, slug] of cases) {
            test(`${JSON.stringify(heading)} -> ${slug}`, () => {
                assert.strictEqual(slugifySection(heading), slug);
            });
        }
    });

    suite('headingDisplayText', () => {
        // VS Code builds a heading id from the concatenated content of
        // markdown-it's inline tokens; these mirror what that yields.
        const cases: [markdown: string, text: string][] = [
            ['The `fetch` API', 'The fetch API'],
            ['**Bold** and *italic*', 'Bold and italic'],
            ['__Bold__ and _italic_', 'Bold and italic'],
            ['A [link](https://example.com) inline', 'A link inline'],
            // An image contributes its alt text.
            ['An ![image](pic.png) inline', 'An image inline'],
            // Raw HTML is kept as written; the slug then drops its brackets.
            ['<em>html</em> tags', '<em>html</em> tags'],
            ['Escaped \\*not emphasis\\*', 'Escaped *not emphasis*'],
            // Inside a code span nothing is markup: tags and underscores survive.
            ['The `<style>` Element', 'The <style> Element'],
            ['`__proto__` and `a * b`', '__proto__ and a * b'],
            // Underscores inside a word are not emphasis.
            ['snake_case_name', 'snake_case_name'],
            ['Tom &amp; Jerry', 'Tom & Jerry'],
            ['~~gone~~ here', 'gone here'],
        ];

        for (const [markdown, text] of cases) {
            test(`${JSON.stringify(markdown)} -> ${JSON.stringify(text)}`, () => {
                assert.strictEqual(headingDisplayText(markdown), text);
            });
        }

        test('the corpus headings with tags in code spans anchor like VS Code', () => {
            assert.strictEqual(slugifySection(headingDisplayText('The `<style>` Element')), 'the-style-element');
            assert.strictEqual(slugifySection(headingDisplayText('`<polygon>`')), 'polygon');
            assert.strictEqual(slugifySection(headingDisplayText('`<path>`')), 'path');
        });
    });

    suite('atxHeading', () => {
        test('reads level and content, dropping a closing run of #', () => {
            assert.deepStrictEqual(atxHeading('## Title ##'), { level: 2, content: 'Title' });
            assert.deepStrictEqual(atxHeading('   ### x'), { level: 3, content: 'x' });
        });
        test('keeps a # that is part of the text', () => {
            assert.deepStrictEqual(atxHeading('## C#'), { level: 2, content: 'C#' });
        });
        test('is not a heading without a space after the #s', () => {
            assert.strictEqual(atxHeading('#hashtag'), undefined);
            assert.strictEqual(atxHeading('####### seven'), undefined);
        });
        test('stays linear on a long run of spaces', () => {
            const started = Date.now();
            atxHeading('# a' + ' '.repeat(20000) + 'b');
            findSections(['# x' + ' '.repeat(20000) + '#']);
            assert.ok(Date.now() - started < 200, 'heading parsing should not backtrack');
        });
    });

    suite('link handler handshake', () => {
        test('guards accept only well-formed messages', () => {
            assert.ok(isLinkHandlerHelloMessage({ type: 'webnb.linkHandlerHello' }));
            assert.ok(!isLinkHandlerHelloMessage({ type: 'webnb.openNotebookLink' }));
            assert.ok(isLinkHandlerConfigMessage({ type: 'webnb.linkHandlerConfig', enabled: false }));
            assert.ok(!isLinkHandlerConfigMessage({ type: 'webnb.linkHandlerConfig' }));
        });
    });

    suite('parseNotebookLinkHref', () => {
        const targets: [href: string, expected: NotebookLinkTarget][] = [
            ['other.webnb', { path: 'other.webnb', section: '' }],
            ['./other.webnb', { path: './other.webnb', section: '' }],
            ['../Module 2/other.webnb', { path: '../Module 2/other.webnb', section: '' }],
            // Markdown percent-encodes destinations; every course filename has spaces.
            ['sub/spaced%20name.webnb', { path: 'sub/spaced name.webnb', section: '' }],
            ['/Course 1/intro.webnb', { path: '/Course 1/intro.webnb', section: '' }],
            ['other.webnb#beta', { path: 'other.webnb', section: 'beta' }],
            // The section is slugified on the way in, so a link may spell it out.
            ['other.webnb#The%20Fetch%20API,%20really?', { path: 'other.webnb', section: 'the-fetch-api-really' }],
            ['#section-two', { path: '', section: 'section-two' }],
            ['#Section Two', { path: '', section: 'section-two' }],
            ['OTHER.WEBNB', { path: 'OTHER.WEBNB', section: '' }],
        ];

        for (const [href, expected] of targets) {
            test(`${JSON.stringify(href)} is a notebook link`, () => {
                assert.deepStrictEqual(parseNotebookLinkHref(href), expected);
            });
        }

        const ignored = [
            '',
            '   ',
            'https://example.com',
            'http://example.com/page.webnb',
            'mailto:someone@example.com',
            'command:webnb.restoreNotebook',
            'file:///tmp/other.webnb',
            // Not a notebook: VS Code's own link handling still opens these.
            'index.html',
            'main.js',
            'notes.webnb.txt',
            '#',
        ];

        for (const href of ignored) {
            test(`${JSON.stringify(href)} is left to VS Code`, () => {
                assert.strictEqual(parseNotebookLinkHref(href), undefined);
            });
        }
    });

    suite('findSections', () => {
        test('reads one entry per heading, in document order', () => {
            const sections = findSections([
                '# Title\n\nIntro text.',
                undefined, // a code cell
                '## Alpha',
                '## Beta\n\nText.\n\n### Beta Detail',
            ]);
            assert.deepStrictEqual(sections.map(s => [s.cellIndex, s.slug, s.level]), [
                [0, 'title', 1],
                [2, 'alpha', 2],
                [3, 'beta', 2],
                [3, 'beta-detail', 3],
            ]);
        });

        test('ignores headings inside fenced code', () => {
            const sections = findSections([
                '## Real\n\n```markdown\n## Fenced\n```\n\n~~~\n## Tilde Fenced\n~~~\n\n## Also Real',
            ]);
            assert.deepStrictEqual(sections.map(s => s.slug), ['real', 'also-real']);
        });

        test('ignores a bare # and closing hashes', () => {
            const sections = findSections(['#not-a-heading\n\n## Closed ##']);
            assert.deepStrictEqual(sections.map(s => s.slug), ['closed']);
        });

        test('numbers duplicate headings within one cell the way VS Code does', () => {
            const sections = findSections(['# Intro\n## Intro\n## Intro', '# Intro']);
            assert.deepStrictEqual(sections.map(s => [s.cellIndex, s.slug]), [
                [0, 'intro'], [0, 'intro-1'], [0, 'intro-2'], [1, 'intro']
            ]);
            assert.strictEqual(findSectionCell(['# Intro\n## Intro'], 'intro-1'), 0);
        });
    });

    suite('findSectionCell', () => {
        const sources = ['# Title', '## Alpha', undefined, '## Beta', '## Beta'];

        test('finds the cell a section is in', () => {
            assert.strictEqual(findSectionCell(sources, 'beta'), 3);
        });

        test('matches a section spelled out rather than slugified', () => {
            assert.strictEqual(findSectionCell(sources, 'Alpha'), 1);
        });

        test('duplicate headings resolve to the first', () => {
            assert.strictEqual(findSectionCell(sources, 'Beta'), 3);
        });

        test('an unknown section resolves to nothing', () => {
            assert.strictEqual(findSectionCell(sources, 'gamma'), undefined);
            assert.strictEqual(findSectionCell(sources, ''), undefined);
        });
    });

    suite('isOpenNotebookLinkMessage', () => {
        test('accepts the message the renderer posts', () => {
            assert.ok(isOpenNotebookLinkMessage({
                type: 'webnb.openNotebookLink',
                href: 'other.webnb#beta',
                path: 'other.webnb',
                section: 'beta'
            }));
        });

        const rejected: unknown[] = [
            undefined,
            null,
            'webnb.openNotebookLink',
            { type: 'webnb.refreshCell', cellUri: 'x' },
            { type: 'webnb.openNotebookLink', href: 'x', path: 'x' },
            { type: 'webnb.openNotebookLink', href: 'x', path: 1, section: '' },
        ];

        for (const message of rejected) {
            test(`rejects ${JSON.stringify(message)}`, () => {
                assert.strictEqual(isOpenNotebookLinkMessage(message), false);
            });
        }
    });
});
