import './tddBridge';
import * as assert from 'assert';
import { parseSizedImage, type SizedImage } from '../../shared/imageSize';

function sized(partial: Partial<SizedImage> & { alt: string; href: string; length: number }): SizedImage {
    // parseSizedImage always returns every key (some undefined), so build the
    // full shape for deepStrictEqual.
    return {
        title: undefined,
        width: undefined,
        height: undefined,
        ...partial
    };
}

suite('shared/imageSize', () => {
    suite('parseSizedImage', () => {
        const matches: [src: string, expected: SizedImage][] = [
            [
                '![a](img.png =200x100)',
                sized({ alt: 'a', href: 'img.png', width: '200', height: '100', length: '![a](img.png =200x100)'.length })
            ],
            [
                '![alt text](img.png =200x)',
                sized({ alt: 'alt text', href: 'img.png', width: '200', length: '![alt text](img.png =200x)'.length })
            ],
            [
                '![a](img.png =x100)',
                sized({ alt: 'a', href: 'img.png', height: '100', length: '![a](img.png =x100)'.length })
            ],
            [
                '![a](img.png =200)',
                sized({ alt: 'a', href: 'img.png', width: '200', length: '![a](img.png =200)'.length })
            ],
            [
                '![a](img.png "the title" =200x100)',
                sized({ alt: 'a', href: 'img.png', title: 'the title', width: '200', height: '100', length: '![a](img.png "the title" =200x100)'.length })
            ],
            [
                "![a](img.png 'my title' =200x)",
                sized({ alt: 'a', href: 'img.png', title: 'my title', width: '200', length: "![a](img.png 'my title' =200x)".length })
            ],
            [
                '![a](<sub dir/img name.png> =200)',
                sized({ alt: 'a', href: 'sub dir/img name.png', width: '200', length: '![a](<sub dir/img name.png> =200)'.length })
            ],
            [
                // Empty alt is allowed.
                '![](i.png =3)',
                sized({ alt: '', href: 'i.png', width: '3', length: '![](i.png =3)'.length })
            ],
            [
                // Escaped characters stay raw (backslash included) in alt.
                '![a\\]b](x.png =5)',
                sized({ alt: 'a\\]b', href: 'x.png', width: '5', length: '![a\\]b](x.png =5)'.length })
            ]
        ];

        for (const [src, expected] of matches) {
            test(`parses ${JSON.stringify(src)}`, () => {
                assert.deepStrictEqual(parseSizedImage(src), expected);
            });
        }

        test('`length` covers only the matched image, not trailing text', () => {
            const image = '![a](img.png =200x100)';
            const result = parseSizedImage(`${image} and more prose`);
            assert.ok(result);
            assert.strictEqual(result.length, image.length);
            assert.strictEqual(result.width, '200');
        });

        const nonMatches: [label: string, src: string][] = [
            ['degenerate `=x` size', '![a](img.png =x)'],
            ['plain image without a size', '![a](img.png)'],
            ['image with only a title', '![a](img.png "t")'],
            ['no image at all', 'not an image'],
            ['image not at the start of src', 'text ![a](img.png =5)'],
            ['empty string', '']
        ];

        for (const [label, src] of nonMatches) {
            test(`returns null for ${label}`, () => {
                assert.strictEqual(parseSizedImage(src), null);
            });
        }

        test('a long run of backslashes in alt does not backtrack catastrophically', () => {
            const hostile = '![' + '\\'.repeat(3000);
            const startedAt = Date.now();
            const result = parseSizedImage(hostile);
            const elapsedMs = Date.now() - startedAt;
            assert.strictEqual(result, null);
            assert.ok(elapsedMs < 2000, `parseSizedImage took ${elapsedMs}ms on a hostile alt`);
        });
    });
});
