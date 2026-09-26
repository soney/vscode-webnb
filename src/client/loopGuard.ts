/**
 * Stops a runaway loop in a learner's code before it freezes the notebook.
 *
 * A `while` loop whose condition never becomes false is the most common bug in
 * a beginner's first loops, and a synchronous infinite loop in the output
 * webview hangs every cell's output (and, where the webview shares a process
 * with the workbench, the whole editor) until the page is reloaded. So every
 * loop in evaluated cell code gets a counter and a start time, and one that
 * keeps running past LOOP_TIME_LIMIT_MS throws a RangeError the cell reports
 * like any other error.
 *
 * The guards are spliced into the ORIGINAL source text at positions taken from
 * Babel's parse, rather than by regenerating the code from an AST: everything a
 * learner wrote keeps its exact formatting, line numbers and `toString()`, and
 * only loops gain a few characters. Code that does not parse is returned
 * unchanged, so a syntax error still surfaces with the browser's own message.
 *
 * The limit is generous on purpose: Course 2's "Synchronous vs Asynchronous"
 * lesson blocks the page for 1.5 seconds with a busy-wait loop to demonstrate
 * exactly that freeze.
 */
import * as Babel from '@babel/standalone';

export const LOOP_TIME_LIMIT_MS = 5000;

/** How many iterations pass between clock reads, so tight loops stay cheap. */
const CHECK_EVERY = 1000;

/** The names the spliced code calls; render() binds them in evaluated code's scope. */
export const LOOP_GUARD_NOW = '__webnbNow';
export const LOOP_GUARD_FAIL = '__webnbLoopFail';

export interface LoopGuardOptions {
    /** Parse JSX (React cells). */
    jsx?: boolean;
    /** Parse `import`/`export` (module cells). */
    module?: boolean;
}

interface AstNode {
    type: string;
    start: number;
    end: number;
    [key: string]: unknown;
}

const LOOP_TYPES = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement']);

interface Insertion {
    position: number;
    text: string;
    /** Closings go before openings at the same position. */
    closing: boolean;
    /** Nesting depth: openings run outer-to-inner, closings inner-to-outer. */
    depth: number;
}

function parse(code: string, options: LoopGuardOptions): AstNode | undefined {
    try {
        const result = Babel.transform(code, {
            ast: true,
            code: false,
            babelrc: false,
            configFile: false,
            sourceType: options.module ? 'module' : 'script',
            parserOpts: {
                plugins: options.jsx ? ['jsx'] : [],
                // Node cells run as a function body, where `return` is legal.
                allowReturnOutsideFunction: true
            }
        } as any) as { ast?: { program?: AstNode } };
        return result?.ast?.program;
    } catch {
        return undefined;
    }
}

function isNode(value: unknown): value is AstNode {
    return !!value && typeof value === 'object'
        && typeof (value as AstNode).type === 'string'
        && typeof (value as AstNode).start === 'number'
        && typeof (value as AstNode).end === 'number';
}

/**
 * Returns `code` with every loop guarded, or `code` itself when it does not
 * parse or has no loops.
 */
export function insertLoopGuards(code: string, options: LoopGuardOptions = {}): string {
    if (!/\b(while|for)\b/.test(code)) {
        return code;
    }
    const program = parse(code, options);
    if (!program) {
        return code;
    }

    const insertions: Insertion[] = [];
    let nextId = 0;

    const visit = (node: AstNode, parent: AstNode | undefined, depth: number, labeledWrapper: AstNode | undefined) => {
        let childDepth = depth;
        if (LOOP_TYPES.has(node.type)) {
            const id = nextId++;
            const counter = `__webnb_c${id}`;
            const startTime = `__webnb_t${id}`;
            // A labeled loop is wrapped together with its labels, so
            // `continue outer` still names a loop.
            const statement = labeledWrapper ?? node;
            insertions.push(
                { position: statement.start, text: `{let ${startTime}=${LOOP_GUARD_NOW}(),${counter}=0;`, closing: false, depth: depth * 2 },
                { position: statement.end, text: '}', closing: true, depth: depth * 2 }
            );
            const tick = `if(++${counter}%${CHECK_EVERY}===0&&${LOOP_GUARD_NOW}()-${startTime}>${LOOP_TIME_LIMIT_MS})${LOOP_GUARD_FAIL}();`;
            const body = node.body as AstNode;
            if (body.type === 'BlockStatement') {
                insertions.push({ position: body.start + 1, text: tick, closing: false, depth: depth * 2 + 1 });
            } else {
                insertions.push(
                    { position: body.start, text: `{${tick}`, closing: false, depth: depth * 2 + 1 },
                    { position: body.end, text: '}', closing: true, depth: depth * 2 + 1 }
                );
            }
            childDepth = depth + 1;
        }

        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') {
                continue;
            }
            const value = node[key];
            const children = Array.isArray(value) ? value : [value];
            for (const child of children) {
                if (!isNode(child)) {
                    continue;
                }
                // Labels chain: `a: b: while (...)`. Pass the outermost label
                // down until it reaches the loop it labels.
                const wrapper = node.type === 'LabeledStatement' && key === 'body'
                    ? (labeledWrapper ?? node)
                    : undefined;
                visit(child, node, childDepth, wrapper);
            }
        }
    };
    visit(program, undefined, 0, undefined);

    if (insertions.length === 0) {
        return code;
    }

    insertions.sort((left, right) => {
        if (left.position !== right.position) {
            return left.position - right.position;
        }
        if (left.closing !== right.closing) {
            return left.closing ? -1 : 1;
        }
        return left.closing ? right.depth - left.depth : left.depth - right.depth;
    });

    let result = '';
    let cursor = 0;
    for (const insertion of insertions) {
        result += code.slice(cursor, insertion.position) + insertion.text;
        cursor = insertion.position;
    }
    return result + code.slice(cursor);
}

/** The error a runaway loop throws; the cell reports it like any other error. */
export function createLoopFailure(): () => never {
    return () => {
        throw new RangeError(
            `A loop ran for more than ${LOOP_TIME_LIMIT_MS / 1000} seconds, so it was stopped. `
            + 'Check that its condition eventually becomes false.'
        );
    };
}
