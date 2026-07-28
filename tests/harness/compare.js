/**
 * Compares two harness captures. MCQ cells may shuffle their options, so
 * their raw output text is ignored in favor of the sorted option list.
 */
function cellKey(cell) {
    const isMcq = cell.containerClass.includes('webnb-output-mcq');
    return JSON.stringify({
        cls: cell.containerClass,
        out: isMcq ? '<mcq>' : cell.output,
        fb: cell.feedback,
        fbCls: cell.feedbackClass,
        con: cell.console,
        mcq: cell.mcqOptions,
        chk: cell.checklistItems,
        wt: cell.walkthroughSteps,
        term: cell.terminalPresent,
    });
}

/** Returns a list of human-readable differences; empty means identical. */
function compareCaptures(expected, actual) {
    const diffs = [];
    for (const notebook of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        const want = expected[notebook] || [];
        const got = actual[notebook] || [];
        if (want.length !== got.length) {
            diffs.push(`${notebook}: cell count ${want.length} -> ${got.length}`);
            continue;
        }
        want.forEach((cell, i) => {
            const wantKey = cellKey(cell);
            const gotKey = cellKey(got[i]);
            if (wantKey !== gotKey) {
                diffs.push(`${notebook}[${i}] differs\n  expected: ${wantKey.slice(0, 400)}\n  actual:   ${gotKey.slice(0, 400)}`);
            }
        });
    }
    return diffs;
}

module.exports = { compareCaptures };
