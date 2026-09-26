import { deepEqual } from './utils';
/**
 * A minimal Cypress-like assertion chain — the grading engine behind the
 * renderer's `assert()` / `assertRule()` / `wrap()` helpers (render.ts binds
 * the default export as both `cy` and `sy` for notebook test code).
 *
 *   cy(container, onResult).get('h1')
 *       .should('exist')
 *       .should('have.text', 'Heading')
 *       .run();
 *
 * Each chain carries an `onResult` callback that reports pass/fail messages to
 * the cell's feedback pane, and a `sourceOnly` flag for elements recovered
 * from raw source text (they cannot prove absence, so negated assertions
 * ignore them). Every assertion also accepts a `not.` prefix, which inverts
 * it: `should('not.exist')`, `should('not.have.text', 'Heading')`.
 *
 * Grading must never pass by accident, so three things fail loudly instead of
 * passing vacuously: an assertion name this engine does not know, an action
 * (`click`, `type`, `clear`) on a selector that matched nothing, and a chain
 * that selected nothing and asserted nothing before `run()`.
 */

/** The assertions `should()` understands, by the name a test writes. */
const BASE_ASSERTIONS = [
    'exist', 'have.text', 'contain.text', 'have.class', 'have.attribute', 'have.attr',
    'have.css', 'have.length', 'have.property', 'have.value', 'be.visible',
    'be.checked', 'be.disabled', 'be.a', 'be.an', 'equal', 'contain', 'include',
    'be.true', 'be.false', 'be.null', 'be.undefined'
] as const;

type BaseAssertion = typeof BASE_ASSERTIONS[number];
type Assertion = BaseAssertion | `not.${BaseAssertion}` | string;

/** Other spellings (mostly Chai's) of the assertions above. */
const ASSERTION_ALIASES: Record<string, BaseAssertion> = {
    'eq': 'equal',
    'eql': 'equal',
    'deep.equal': 'equal',
    'include.text': 'contain.text',
    'have.lengthOf': 'have.length'
};

const KNOWN_ASSERTIONS = new Set<string>(BASE_ASSERTIONS);

/** Assertions about a DOM element; they need an element, not a plain value. */
const ELEMENT_ASSERTIONS = new Set<string>([
    'have.text', 'contain.text', 'have.class', 'have.attribute', 'have.attr',
    'have.value', 'be.visible', 'be.checked', 'be.disabled'
]);

const NOT_PREFIX = 'not.';

/**
 * The result of evaluating the plain (non-negated) form of an assertion.
 * `should()` applies any `not.` prefix in one place using these fields, so the
 * individual assertion branches never have to think about negation.
 */
type AssertionOutcome =
    | { error: string }
    | {
        /** Whether the plain form of the assertion holds. */
        passed: boolean;
        /**
         * Whether the `not.` form holds. Defaults to `!passed`, but per-element
         * assertions supply their own value: `not.have.class('active')` passes
         * only when NO matched element has the class, which is stricter than
         * "not every element has it".
         */
        negatedPassed?: boolean;
        /** Reported when the plain form fails. */
        failMessage: string;
        /** Reported when the `not.` form fails. */
        negatedFailMessage?: string;
    };

/** Whether a single element satisfies a per-element assertion. */
type ElementCheck =
    | { error: string }
    | { status: 'satisfied' | 'skipped' }
    | { status: 'failed', failMessage: string };

type OnResult = (passed: boolean, message: string, trace: string[]) => void;

interface ChainOptions {
    /** See the header: elements recovered from source text. */
    sourceOnly?: boolean;
    /** Runs after every action, e.g. to flush a React update the action caused. */
    afterAction?: () => void;
}

interface Chainable {
    failed: boolean;
    messageTrace: string[];
    elements: Element[];
    /**
     * True when `elements` were recovered from raw source text rather than from
     * rendered output. Such elements cannot prove absence, so negated
     * assertions ignore them. See the `assert()` helper in render.ts.
     */
    sourceOnly: boolean;
    onResult: OnResult;

    // `expected`/`value` are `any` because assertions compare against whatever
    // the notebook passes: `should('equal', { name: 'Ada' })` is as valid as
    // `should('have.text', 'Hello')`.
    should(assertion: Assertion, expected?: any, value?: any): Chainable;
    click(): Chainable;
    type(text: string): Chainable;
    clear(): Chainable;
    find(selector: string): Chainable;
    get(selector: string): Chainable;
    contains(text: string): Chainable;
    run(failMessage?: string, successMessage?: string): void;
    subject?: any;
}

/**
 * Writes a value as a code span for a feedback message. Feedback text gets
 * smart typography, which would turn `a--b...` into an en dash and an
 * ellipsis inside quotes; code spans are left alone.
 */
function codeSpan(text: string): string {
    if (text === '') {
        return '(empty text)';
    }
    const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longestRun + 1);
    const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
    return `${fence}${padded}${fence}`;
}

/** Text as a reader sees it: runs of whitespace collapse, ends trim. */
function normalizeText(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Parses a `"property: value"` CSS assertion string; both forms share it. */
function parseCssAssertion(expected?: any): { prop: string; expectedValue: string } | { error: string } {
    const [prop, ...valParts] = expected?.split(':').map((s: string) => s.trim()) ?? [];
    const expectedValue = valParts.join(':').trim();
    if (!prop || expectedValue === undefined) {
        return { error: `Invalid CSS assertion syntax. Use "property: value"` };
    }
    return { prop, expectedValue };
}

function normalizeCssValue(prop: string, value: string, tagName: string = 'div', parentElement?: Element | null): string {
    const dummy = document.createElement(tagName);
    dummy.style.setProperty(prop, value);
    dummy.style.display = 'none';
    const container = parentElement || document.body;
    if (container) {
        container.appendChild(dummy);
    }
    const computed = window.getComputedStyle(dummy).getPropertyValue(prop);
    if (container) {
        container.removeChild(dummy);
    }
    return computed;
}

/** Human-readable form of a per-element assertion, used in negated messages. */
function describeElementAssertion(assertion: BaseAssertion, expected?: any, value?: any): string {
    switch (assertion) {
        case 'have.text':
            return `have text ${codeSpan(String(expected))}`;
        case 'contain.text':
            return `contain text ${codeSpan(String(expected))}`;
        case 'have.class':
            return `have class ${codeSpan(String(expected))}`;
        case 'have.attribute':
        case 'have.attr':
            return value === undefined ? `have attribute ${codeSpan(String(expected))}` : `have attribute ${codeSpan(String(expected))} set to ${codeSpan(String(value))}`;
        case 'have.css':
            return `have CSS ${codeSpan(String(expected))}`;
        case 'have.property':
            return value === undefined ? `have property ${codeSpan(String(expected))}` : `have property ${codeSpan(String(expected))} set to ${describeValue(value)}`;
        case 'have.value':
            return `have value ${codeSpan(String(expected))}`;
        case 'be.visible':
            return 'be visible';
        case 'be.checked':
            return 'be checked';
        case 'be.disabled':
            return 'be disabled';
        default:
            return `match "${assertion}"`;
    }
}

/**
 * Renders a value for a failure message. Assertions compare against arbitrary
 * values, and the default stringification of an object is `[object Object]`,
 * which tells a learner nothing about why their test failed.
 */
function describeValue(value: any): string {
    if (typeof value === 'string') {
        return codeSpan(value);
    }
    if (typeof value === 'bigint') {
        return `${value}n`;
    }
    if (typeof value === 'function') {
        return value.name ? `function ${value.name}` : 'an anonymous function';
    }
    if (value === null || typeof value !== 'object') {
        return String(value);
    }
    if (value instanceof Element) {
        return codeSpan(`<${value.tagName.toLowerCase()}>`);
    }
    try {
        // Circular structures and BigInt values both make JSON.stringify throw.
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : codeSpan(json);
    } catch {
        return Object.prototype.toString.call(value);
    }
}

/**
 * The type name `be.an` matches against: `'array'`, `'null'`, `'date'`, and so
 * on. Built from the internal class tag rather than `typeof`, which cannot tell
 * an array, a date, or `null` apart from a plain object.
 */
function typeNameOf(value: any): string {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

/** Spellings of a type name that mean the same thing as the tag `typeNameOf` produces. */
const TYPE_ALIASES: Record<string, string> = {
    regex: 'regexp',
    func: 'function',
    fn: 'function',
    bool: 'boolean',
    str: 'string',
    num: 'number',
    obj: 'object',
    arr: 'array'
};

/** An async or generator function is still a function to a learner asking. */
const FUNCTION_TAGS = new Set(['function', 'asyncfunction', 'generatorfunction', 'asyncgeneratorfunction']);

/**
 * Whether `subject` is of type `expected`. `'element'` is accepted on top of the
 * JavaScript types, since the subject of a notebook test is often a DOM node,
 * whose tag is its interface name (`htmldivelement`) rather than `element`.
 */
function isOfType(subject: any, expected: string): boolean {
    const wanted = TYPE_ALIASES[expected] ?? expected;
    if (wanted === 'element') {
        return subject instanceof Element;
    }
    if (wanted === 'object') {
        // `be.an('object')` should not be satisfied by an array or a null, both
        // of which `typeof` calls an object.
        return typeNameOf(subject) === 'object';
    }
    if (wanted === 'function') {
        return FUNCTION_TAGS.has(typeNameOf(subject));
    }
    return typeNameOf(subject) === wanted;
}

/**
 * Reads a property for `have.property`. Boxed so primitives can be asked about
 * their own properties (`'length' in 'abc'` throws; `Object('abc')` does not),
 * and inherited properties count, matching Chai.
 */
function readProperty(subject: any, name: string): { present: boolean, value?: any } {
    if (subject === null || subject === undefined) {
        return { present: false };
    }
    const target = Object(subject);
    return name in target ? { present: true, value: target[name] } : { present: false };
}

/** Whether an element takes up space on the page and is not hidden by CSS. */
function isVisible(el: Element): boolean {
    if (el.getClientRects().length === 0) {
        return false;
    }
    const computed = window.getComputedStyle(el);
    return computed.visibility !== 'hidden' && computed.visibility !== 'collapse' && computed.opacity !== '0';
}

function checkElement(el: Element, assertion: BaseAssertion, expected?: any, value?: any): ElementCheck {
    if (assertion === 'have.property') {
        // The DOM *property*, as opposed to the attribute `have.attr` reads.
        // They diverge exactly where it matters to a learner: typing into an
        // <input> moves `.value` but leaves the `value` attribute alone.
        const found = readProperty(el, String(expected));
        if (!found.present) {
            return { status: 'failed', failMessage: `Expected element to have property ${codeSpan(String(expected))}` };
        }
        if (value !== undefined && !deepEqual(found.value, value)) {
            return {
                status: 'failed',
                failMessage: `Expected property ${codeSpan(String(expected))} to be ${describeValue(value)}, got ${describeValue(found.value)}`
            };
        }
    } else if (assertion === 'have.text') {
        // Compared as a reader sees it: the indentation Format Document puts
        // inside `<li>\n  Apples\n</li>` is not part of the text.
        if (normalizeText(el.textContent) !== normalizeText(String(expected))) {
            return { status: 'failed', failMessage: `Expected text ${codeSpan(normalizeText(String(expected)))}, got ${codeSpan(normalizeText(el.textContent))}` };
        }
    } else if (assertion === 'contain.text') {
        if (!normalizeText(el.textContent).includes(normalizeText(String(expected)))) {
            return { status: 'failed', failMessage: `Expected text to contain ${codeSpan(normalizeText(String(expected)))}, got ${codeSpan(normalizeText(el.textContent))}` };
        }
    } else if (assertion === 'have.class') {
        if (!el.classList.contains(expected!)) {
            return { status: 'failed', failMessage: `Expected element to have class ${codeSpan(String(expected))}` };
        }
    } else if (assertion === 'have.attribute' || assertion === 'have.attr') {
        if (!el.hasAttribute(expected!)) {
            return { status: 'failed', failMessage: `Expected element to have attribute ${codeSpan(String(expected))}` };
        }
        if (value !== undefined && el.getAttribute(expected!) !== String(value)) {
            return { status: 'failed', failMessage: `Expected attribute ${codeSpan(String(expected))} to be ${codeSpan(String(value))}, got ${codeSpan(el.getAttribute(expected!) ?? '')}` };
        }
    } else if (assertion === 'have.value') {
        const actual = (el as HTMLInputElement).value;
        if (actual === undefined) {
            return { status: 'failed', failMessage: 'Expected a form field (input, textarea or select) to check its value' };
        }
        if (actual !== String(expected)) {
            return { status: 'failed', failMessage: `Expected value ${codeSpan(String(expected))}, got ${codeSpan(actual)}` };
        }
    } else if (assertion === 'be.visible') {
        if (!isVisible(el)) {
            return { status: 'failed', failMessage: 'Expected element to be visible' };
        }
    } else if (assertion === 'be.checked') {
        if ((el as HTMLInputElement).checked !== true) {
            return { status: 'failed', failMessage: 'Expected element to be checked' };
        }
    } else if (assertion === 'be.disabled') {
        if ((el as HTMLInputElement).disabled !== true) {
            return { status: 'failed', failMessage: 'Expected element to be disabled' };
        }
    } else if (assertion === 'have.css') {
        const parsed = parseCssAssertion(expected);
        if ('error' in parsed) {
            return parsed;
        }
        const { prop, expectedValue } = parsed;
        if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) {
            return { status: 'skipped' };
        }
        const computed = window.getComputedStyle(el);
        const actualValue = computed.getPropertyValue(prop);

        const computedExpected = normalizeCssValue(prop, expectedValue, el.tagName, el.parentElement);

        if (actualValue.trim() !== expectedValue && actualValue.trim() !== computedExpected.trim()) {
            return { status: 'failed', failMessage: `Expected CSS ${codeSpan(`${prop}: ${expectedValue}`)}, got ${codeSpan(actualValue)}` };
        }
    }
    return { status: 'satisfied' };
}

/** Whether a wrapped value is a set of elements rather than a plain value. */
function elementsOf(subject: any): Element[] | undefined {
    if (typeof Element === 'undefined') {
        return undefined;
    }
    if (subject instanceof Element) {
        return [subject];
    }
    if ((typeof NodeList !== 'undefined' && subject instanceof NodeList)
        || (typeof HTMLCollection !== 'undefined' && subject instanceof HTMLCollection)) {
        return Array.from(subject as ArrayLike<Node>).filter((node): node is Element => node instanceof Element);
    }
    if (Array.isArray(subject) && subject.length > 0 && subject.every(item => item instanceof Element)) {
        return subject as Element[];
    }
    return undefined;
}

/**
 * Evaluate the plain form of `assertion`. Negation is applied by the caller.
 */
function evaluateAssertion(elements: Element[], subject: any, hasSubject: boolean, assertion: BaseAssertion, expected?: any, value?: any): AssertionOutcome {
    if (!hasSubject && (assertion === 'equal' || assertion === 'include' || assertion === 'be.true' || assertion === 'be.false' || assertion === 'be.null' || assertion === 'be.undefined')) {
        // These compare a value; on a selection of elements they would check nothing.
        return { error: `"${assertion}" checks a value: wrap(value).should('${assertion}'${assertion === 'equal' || assertion === 'include' ? ', expected' : ''})` };
    }

    if (hasSubject && assertion === 'equal') {
        return {
            passed: deepEqual(subject, expected),
            failMessage: `Expected ${describeValue(subject)} to equal ${describeValue(expected)}`,
            negatedFailMessage: `Expected ${describeValue(subject)} not to equal ${describeValue(expected)}`
        };
    }

    if (assertion === 'be.true' || assertion === 'be.false' || assertion === 'be.null' || assertion === 'be.undefined') {
        const wanted = { 'be.true': true, 'be.false': false, 'be.null': null, 'be.undefined': undefined }[assertion];
        const word = assertion.slice(3);
        return {
            passed: subject === wanted,
            failMessage: `Expected ${describeValue(subject)} to be ${word}`,
            negatedFailMessage: `Expected the subject not to be ${word}`
        };
    }

    if (assertion === 'be.a' || assertion === 'be.an') {
        // A type assertion is about a value, so it needs a wrapped subject;
        // against elements it would only ever restate what `assert()` returned.
        if (!hasSubject) {
            return { error: `"${assertion}" needs a wrapped value: wrap(value).should('${assertion}', 'array')` };
        }
        if (typeof expected !== 'string' || expected.trim() === '') {
            return { error: `Expected a type name, e.g. should('${assertion}', 'array')` };
        }

        const wanted = expected.trim().toLowerCase();
        const actual = typeNameOf(subject);
        return {
            passed: isOfType(subject, wanted),
            failMessage: `Expected ${describeValue(subject)} to be ${wanted === 'array' || wanted === 'object' ? 'an' : 'a'} ${wanted}, got ${actual}`,
            negatedFailMessage: `Expected the subject not to be ${wanted}, but it was`
        };
    }

    if (hasSubject && assertion === 'have.property') {
        if (expected === undefined || expected === null || String(expected).trim() === '') {
            return { error: `Expected a property name, e.g. should('have.property', 'name')` };
        }

        const name = String(expected);
        const found = readProperty(subject, name);
        if (!found.present) {
            return {
                passed: false,
                failMessage: `Expected ${describeValue(subject)} to have property ${codeSpan(name)}`,
                negatedFailMessage: `Expected the subject not to have property ${codeSpan(name)}`
            };
        }
        // Present with no expected value: the assertion is only about existence.
        if (value === undefined) {
            return {
                passed: true,
                failMessage: `Expected ${describeValue(subject)} to have property ${codeSpan(name)}`,
                negatedFailMessage: `Expected the subject not to have property ${codeSpan(name)}, but it does`
            };
        }
        return {
            passed: deepEqual(found.value, value),
            failMessage: `Expected property ${codeSpan(name)} to be ${describeValue(value)}, got ${describeValue(found.value)}`,
            negatedFailMessage: `Expected property ${codeSpan(name)} not to be ${describeValue(value)}, but it was`
        };
    }

    if (assertion === 'exist') {
        if (hasSubject) {
            return {
                passed: !(subject === null || subject === undefined || (subject.length !== undefined && subject.length === 0)),
                failMessage: 'Expected subject to exist, but it was null or empty',
                negatedFailMessage: 'Expected the subject not to exist, but it was present'
            };
        }

        return {
            passed: elements.length > 0,
            failMessage: 'Expected at least one element to exist, but found none',
            negatedFailMessage: `Expected no elements matching the selector, but found ${elements.length}`
        };
    }

    if (hasSubject && (assertion === 'include' || (assertion === 'contain' && !elementsOf(subject)))) {
        // A wrapped string or array: does it include the expected part?
        if (typeof subject === 'string') {
            return {
                passed: subject.includes(String(expected)),
                failMessage: `Expected ${describeValue(subject)} to include ${describeValue(expected)}`,
                negatedFailMessage: `Expected ${describeValue(subject)} not to include ${describeValue(expected)}`
            };
        }
        if (Array.isArray(subject)) {
            return {
                passed: subject.some(item => deepEqual(item, expected)),
                failMessage: `Expected ${describeValue(subject)} to include ${describeValue(expected)}`,
                negatedFailMessage: `Expected ${describeValue(subject)} not to include ${describeValue(expected)}`
            };
        }
        return { error: `"${assertion}" needs a string or an array: wrap(value).should('${assertion}', part)` };
    }
    if (assertion === 'include') {
        return { error: `"include" needs a wrapped string or array: wrap(value).should('include', part)` };
    }

    if (assertion === 'contain') {
        if (elements.length === 0) {
            // Nothing to contain anything, so `not.contain` holds vacuously.
            return {
                passed: false,
                negatedPassed: true,
                failMessage: `Expected elements to contain ${codeSpan(String(expected))}, but no matching elements were found`
            };
        }

        const containing = elements.filter(el => el.querySelector(expected!) !== null);
        return {
            passed: containing.length === elements.length,
            negatedPassed: containing.length === 0,
            failMessage: `Expected element to contain ${codeSpan(String(expected))}, but no descendant matched`,
            negatedFailMessage: `Expected no element to contain ${codeSpan(String(expected))}, but ${containing.length} of ${elements.length} did`
        };
    }

    if (assertion === 'have.length') {
        const expectedLength = Number(expected);
        if (Number.isNaN(expectedLength)) {
            return { error: `Expected a numeric length value, got "${expected}"` };
        }

        const usesSubject = hasSubject && subject !== null && subject !== undefined && subject.length !== undefined;
        const actualLength = usesSubject ? subject.length : elements.length;
        return {
            passed: actualLength === expectedLength,
            failMessage: usesSubject
                ? `Expected subject length ${expectedLength}, got ${actualLength}`
                : `Expected ${expectedLength} elements, got ${actualLength}`,
            negatedFailMessage: usesSubject
                ? `Expected the subject length not to be ${expectedLength}`
                : `Expected the number of matching elements not to be ${expectedLength}`
        };
    }

    if (hasSubject && assertion === 'have.css' && !elementsOf(subject)) {
        const parsed = parseCssAssertion(expected);
        if ('error' in parsed) {
            return parsed;
        }
        const { prop, expectedValue } = parsed;

        if (subject && subject.style) { // A CSS rule (or merged rules) from getRule
            const actualValue = subject.style.getPropertyValue(prop).trim();
            const computedActual = document.body ? normalizeCssValue(prop, actualValue) : actualValue;
            const computedExpected = document.body ? normalizeCssValue(prop, expectedValue) : expectedValue;

            return {
                passed: actualValue === expectedValue || computedActual === computedExpected,
                failMessage: `Expected CSS rule ${codeSpan(`${prop}: ${expectedValue}`)}, got ${codeSpan(actualValue)}`,
                negatedFailMessage: `Expected the CSS rule ${codeSpan(prop)} not to be ${codeSpan(expectedValue)}, but it was ${codeSpan(actualValue)}`
            };
        }
        return { error: `Subject does not have a style property to check CSS against` };
    }

    if (hasSubject && elements.length === 0 && !elementsOf(subject)) {
        // An element assertion on a plain value would otherwise pass without
        // checking anything.
        return { error: `"${assertion}" checks an element; wrap(value) supports equal, include, have.property, have.length, be.a, exist` };
    }

    // Element assertions implicitly fail when nothing matched. A negated
    // assertion instead holds vacuously: no element can violate it.
    if (elements.length === 0) {
        return {
            passed: false,
            negatedPassed: true,
            failMessage: `Expected at least one element for assertion "${assertion}", but found none`
        };
    }

    let satisfied = 0;
    let firstFailure: string | undefined;
    for (const el of elements) {
        const check = checkElement(el, assertion, expected, value);
        if ('error' in check) {
            return check;
        }
        if (check.status === 'satisfied') {
            satisfied++;
        } else if (check.status === 'failed' && firstFailure === undefined) {
            firstFailure = check.failMessage;
        }
    }

    return {
        // Elements that the assertion does not apply to are skipped, matching
        // the plain form's behavior: they neither pass nor fail it.
        passed: firstFailure === undefined,
        negatedPassed: satisfied === 0,
        failMessage: firstFailure ?? `Assertion "${assertion}" failed`,
        negatedFailMessage: `Expected no element to ${describeElementAssertion(assertion, expected, value)}, but ${satisfied} of ${elements.length} did`
    };
}

/** Resolves a written assertion name to a known one, or undefined. */
function resolveAssertion(name: string): BaseAssertion | undefined {
    const resolved = ASSERTION_ALIASES[name] ?? name;
    return KNOWN_ASSERTIONS.has(resolved) ? resolved as BaseAssertion : undefined;
}

/** Sets a form field's value the way typing does, so frameworks see it. */
function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    // React tracks a field's value through the prototype's setter; assigning
    // `el.value` directly skips that, and a controlled input never updates.
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) {
        setter.call(el, text);
    } else {
        el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

interface ChainState {
    /** What the chain selected, for messages; undefined for the root and for wrap(). */
    selector?: string;
    /** Whether the chain came from wrap(), even wrap(undefined). */
    wrapped?: boolean;
    /** Whether any assertion ran; a chain that selected nothing must assert something. */
    asserted: boolean;
    options: ChainOptions;
}

function createChain(elements: Element[], onResult: OnResult = () => { }, messageTrace: string[] = [], failed: boolean = false, subject?: any, state: ChainState = { asserted: false, options: {} }): Chainable {
    const sourceOnly = state.options.sourceOnly === true;
    const next = (nextElements: Element[], trace: string[], nextFailed: boolean, changes: Partial<ChainState> = {}) =>
        createChain(nextElements, onResult, trace, nextFailed, subject, { ...state, ...changes });

    /** An action needs something to act on; with nothing matched it fails the chain. */
    const failAction = (action: string): Chainable => next(
        elements,
        messageTrace.concat(state.selector
            ? `Could not ${action}: nothing matched ${codeSpan(state.selector)}`
            : `Could not ${action}: there was no element to ${action}`),
        true,
        { asserted: true }
    );

    const chain: Chainable = {
        elements,
        messageTrace,
        failed,
        onResult,
        subject,
        sourceOnly,

        should(assertion: Assertion, expected?: any, value?: any): Chainable {
            if (failed) { return this; }

            const negated = assertion.startsWith(NOT_PREFIX);
            const written = negated ? assertion.slice(NOT_PREFIX.length) : assertion;
            const baseAssertion = resolveAssertion(written);
            if (!baseAssertion) {
                return next(this.elements, messageTrace.concat(
                    `Unknown assertion "${assertion}". Supported: ${BASE_ASSERTIONS.join(', ')} (each also with "not.")`
                ), true, { asserted: true });
            }
            // Elements recovered from raw source cannot prove that something is
            // absent from the rendered output, so a negated assertion checks the
            // rendered set only (which is empty whenever a fallback kicked in).
            const target = negated && this.sourceOnly ? [] : this.elements;
            const hasSubject = state.wrapped === true;
            const outcome = ELEMENT_ASSERTIONS.has(baseAssertion) && hasSubject && !elementsOf(this.subject)
                ? { error: `"${assertion}" checks an element, but the wrapped value is ${describeValue(this.subject)}` }
                : evaluateAssertion(target, this.subject, hasSubject, baseAssertion, expected, value);

            let holds: boolean;
            let message: string;
            if ('error' in outcome) {
                // Malformed assertions fail regardless of negation.
                holds = false;
                message = outcome.error;
            } else if (negated ? (outcome.negatedPassed ?? !outcome.passed) : outcome.passed) {
                holds = true;
                message = `Assertion passed: ${assertion}${expected === undefined ? '' : ` with value ${describeValue(expected)}`}`;
            } else {
                holds = false;
                message = negated
                    ? outcome.negatedFailMessage ?? `Expected "${baseAssertion}" not to hold, but it did`
                    : outcome.failMessage;
            }

            return next(this.elements, messageTrace.concat(message), holds ? this.failed : true, { asserted: true });
        },

        click(): Chainable {
            if (failed) { return this; }
            if (this.elements.length === 0) {
                return failAction('click');
            }

            this.elements.forEach(el => {
                if (el instanceof HTMLElement) {
                    el.click();
                } else {
                    // SVG and other elements have no click(); dispatch one.
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
                }
            });
            state.options.afterAction?.();
            return chain;
        },

        type(text: string): Chainable {
            if (failed) { return this; }
            if (this.elements.length === 0) {
                return failAction('type');
            }
            this.elements.forEach(el => {
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                    setFieldValue(el, text);
                } else {
                    throw new Error('`type()` can only be called on <input> or <textarea> elements');
                }
            });
            state.options.afterAction?.();
            return chain;
        },

        clear(): Chainable {
            if (failed) { return this; }
            if (this.elements.length === 0) {
                return failAction('clear');
            }
            this.elements.forEach(el => {
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                    setFieldValue(el, '');
                }
            });
            state.options.afterAction?.();
            return chain;
        },

        find(selector: string): Chainable {
            if (failed) { return this; }
            let found: Element[] = [];
            this.elements.forEach(el => {
                found = found.concat(Array.from(el.querySelectorAll(selector)));
            });
            return next(found, this.messageTrace, this.failed, { selector, asserted: false });
        },

        get(selector: string): Chainable {
            return this.find(selector);
        },

        contains(text: string): Chainable {
            if (failed) { return this; }

            // Like Cypress: the deepest elements, within what the chain holds,
            // whose text includes `text`.
            const wanted = normalizeText(text);
            const found: Element[] = [];
            const visit = (el: Element) => {
                if (!normalizeText(el.textContent).includes(wanted)) {
                    return;
                }
                const before = found.length;
                for (const child of Array.from(el.children)) {
                    visit(child);
                }
                if (found.length === before) {
                    found.push(el);
                }
            };
            this.elements.forEach(visit);
            return next(found, this.messageTrace, this.failed, { selector: `text "${text}"`, asserted: false });
        },

        run(failMessage?: string, successMessage?: string): void {
            let isFailed = this.failed;
            let trace = this.messageTrace;
            // A selection with nothing asserted proves nothing by itself; like
            // Cypress's get(), it at least requires that something matched.
            if (!isFailed && !state.asserted && state.selector !== undefined && this.elements.length === 0) {
                isFailed = true;
                trace = trace.concat(`Expected to find ${codeSpan(state.selector)}, but nothing matched`);
            }
            if (this.onResult) {
                this.onResult(!isFailed, (isFailed ? (failMessage) : (successMessage)) ?? trace.join('\n'), trace);
            }
        }
    };
    return chain;
}

/** Every stylesheet in the document and in any shadow root, in page order. */
function allDocumentStyleSheets(): CSSStyleSheet[] {
    const sheets: CSSStyleSheet[] = Array.from(document.styleSheets);
    document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot?.styleSheets) {
            sheets.push(...Array.from(el.shadowRoot.styleSheets));
        }
    });
    return sheets;
}

const sy = Object.assign(
    function (el: string | Element | Element[], onResult?: OnResult, options?: ChainOptions): Chainable {
        const state: ChainState = { asserted: false, options: options ?? {} };
        if (typeof el === 'string') {
            const nodes = Array.from(document.querySelectorAll(el));
            return createChain(nodes, onResult, [], false, undefined, { ...state, selector: el });
        } else if (el instanceof Element) {
            return createChain([el], onResult, [], false, undefined, state);
        } else if (Array.isArray(el)) {
            return createChain(el, onResult, [], false, undefined, state);
        } else {
            throw new Error('Invalid argument: must be a string selector, Element, or array of Elements');
        }
    }, {
    wrap: (object: any, onResult?: OnResult) => {
        // A wrapped element (or list of them) can take element assertions:
        // wrap(el).should('have.text', 'Hi') checks the element's text.
        return createChain(elementsOf(object) ?? [], onResult, [], false, object, { asserted: false, wrapped: true, options: {} });
    },
    /**
     * The CSS declared for `selector`, merged across every rule with exactly
     * that selector in the given stylesheets (all of the page's when none are
     * given), later rules winning as they do in the cascade.
     */
    getRule: (selector: string, onResult?: OnResult, sheets?: CSSStyleSheet[]) => {
        const merged = document.createElement('div').style;
        let matched = false;
        for (const sheet of sheets ?? allDocumentStyleSheets()) {
            let rules: CSSRuleList;
            try {
                rules = sheet.cssRules;
            } catch {
                continue; // cross-origin sheet
            }
            for (let j = 0; j < rules.length; j++) {
                const rule = rules[j];
                if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
                    matched = true;
                    for (let k = 0; k < rule.style.length; k++) {
                        const property = rule.style[k];
                        merged.setProperty(property, rule.style.getPropertyValue(property), rule.style.getPropertyPriority(property));
                    }
                }
            }
        }
        if (matched) {
            return createChain([], onResult, [], false, { selectorText: selector, style: merged }, { asserted: false, wrapped: true, options: {} });
        }
        return createChain([], onResult, [`Expected CSS rule for ${codeSpan(selector)} to exist, but found none`], true, null, { asserted: true, wrapped: true, options: {} });
    }
}
);

export default sy;
