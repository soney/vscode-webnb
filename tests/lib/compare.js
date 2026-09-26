/**
 * Compares two captures (see capture.js) cell by cell, field by field. Every
 * captured field counts; MCQ option shuffling is already neutralized by the
 * capture (an MCQ's output leaves its options out, and mcqOptions lists them
 * sorted).
 */
const COMPARED_FIELDS = [
    'language',
    'hasSolution',
    'ranOnOpen',
    'state',
    'renderError',
    'containerClass',
    'output',
    'feedback',
    'feedbackClass',
    'feedbackKinds',
    'console',
    'uncaught',
    'actions',
    'solution',
    'mcqOptions',
    'mcqCheck',
    'checklistItems',
    'walkthroughSteps',
    'terminalPresent',
];

/** A field every current capture has and no capture from before it does. */
const FORMAT_MARKER_FIELD = 'state';

function show(value) {
    const text = JSON.stringify(value === undefined ? null : value);
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** Returns a list of human-readable differences; empty means identical. */
function compareCaptures(expected, actual) {
    const outdated = Object.values(expected).some(cells =>
        Array.isArray(cells) && cells.some(cell => cell && !(FORMAT_MARKER_FIELD in cell)));
    if (outdated) {
        return [
            'the saved capture predates the current capture format (its cells have no ' +
            `"${FORMAT_MARKER_FIELD}" field); regenerate it before comparing`
        ];
    }

    const diffs = [];
    for (const notebook of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        const want = expected[notebook] || [];
        const got = actual[notebook] || [];
        if (want.length !== got.length) {
            diffs.push(`${notebook}: code cell count ${want.length} -> ${got.length}`);
            continue;
        }
        want.forEach((cell, i) => {
            const changed = COMPARED_FIELDS.filter(field =>
                JSON.stringify(cell[field]) !== JSON.stringify(got[i][field]));
            if (changed.length > 0) {
                diffs.push(`${notebook}[${i}] (${got[i].language || cell.language || '?'}) differs:\n` +
                    changed.map(field => `  ${field}: ${show(cell[field])}\n  ${' '.repeat(field.length)}  -> ${show(got[i][field])}`).join('\n'));
            }
        });
    }
    return diffs;
}

module.exports = { compareCaptures, COMPARED_FIELDS };
