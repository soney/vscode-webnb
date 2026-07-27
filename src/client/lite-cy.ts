import { deepEqual } from './utils';
/**
 * lite-cypress.ts
 * A minimal, standalone Cypress-like testing utility for the browser, written in TypeScript.
 * No dependencies, ~1KB minified.
 *
 * Usage:
 *   <script src="lite-cypress.js"></script>
 *   <script>
 *     cy.get('h1')
 *       .should('exist')
 *       .should('have.text', 'Heading')
 *       .click();
 *   </script>
 *
 * Every assertion also accepts a `not.` prefix, which inverts it:
 *   cy.get('h1').should('not.exist');
 *   cy.get('h1').should('not.have.text', 'Heading');
 */

type BaseAssertion = 'exist' | 'have.text' | 'have.class' | 'have.attribute' | 'have.attr' | 'have.css' | 'have.length' | 'have.property' | 'be.a' | 'be.an' | 'equal' | 'contain';
type Assertion = BaseAssertion | `not.${BaseAssertion}`;

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
    onResult: (passed: boolean, message: string, trace: string[]) => void;

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
            return `have text "${expected}"`;
        case 'have.class':
            return `have class "${expected}"`;
        case 'have.attribute':
        case 'have.attr':
            return value === undefined ? `have attribute "${expected}"` : `have attribute "${expected}" set to "${value}"`;
        case 'have.css':
            return `have CSS "${expected}"`;
        case 'have.property':
            return value === undefined ? `have property "${expected}"` : `have property "${expected}" set to ${describeValue(value)}`;
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
        return `"${value}"`;
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
        return `<${value.tagName.toLowerCase()}>`;
    }
    try {
        // Circular structures and BigInt values both make JSON.stringify throw.
        return JSON.stringify(value) ?? String(value);
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

function checkElement(el: Element, assertion: BaseAssertion, expected?: any, value?: any): ElementCheck {
    if (assertion === 'have.property') {
        // The DOM *property*, as opposed to the attribute `have.attr` reads.
        // They diverge exactly where it matters to a learner: typing into an
        // <input> moves `.value` but leaves the `value` attribute alone.
        const found = readProperty(el, String(expected));
        if (!found.present) {
            return { status: 'failed', failMessage: `Expected element to have property "${expected}"` };
        }
        if (value !== undefined && !deepEqual(found.value, value)) {
            return {
                status: 'failed',
                failMessage: `Expected property "${expected}" to be ${describeValue(value)}, got ${describeValue(found.value)}`
            };
        }
    } else if (assertion === 'have.text') {
        if (el.textContent !== expected) {
            return { status: 'failed', failMessage: `Expected text "${expected}", got "${el.textContent}"` };
        }
    } else if (assertion === 'have.class') {
        if (!(el instanceof HTMLElement) || !el.classList.contains(expected!)) {
            return { status: 'failed', failMessage: `Expected element to have class "${expected}"` };
        }
    } else if (assertion === 'have.attribute' || assertion === 'have.attr') {
        if (!(el instanceof HTMLElement) || !el.hasAttribute(expected!)) {
            return { status: 'failed', failMessage: `Expected element to have attribute "${expected}"` };
        }
        if (value !== undefined && el.getAttribute(expected!) !== value) {
            return { status: 'failed', failMessage: `Expected attribute "${expected}" to be "${value}", got "${el.getAttribute(expected!)}"` };
        }
    } else if (assertion === 'have.css') {
        const [prop, ...valParts] = expected?.split(':').map((s: string) => s.trim()) ?? [];
        const expectedValue = valParts.join(':').trim();
        if (!prop || expectedValue === undefined) {
            return { error: `Invalid CSS assertion syntax. Use "property: value"` };
        }
        if (!(el instanceof HTMLElement)) {
            return { status: 'skipped' };
        }
        const computed = window.getComputedStyle(el);
        const actualValue = computed.getPropertyValue(prop);

        const computedExpected = normalizeCssValue(prop, expectedValue, el.tagName, el.parentElement);

        if (actualValue.trim() !== expectedValue && actualValue.trim() !== computedExpected.trim()) {
            return { status: 'failed', failMessage: `Expected CSS "${prop}: ${expectedValue}", got "${actualValue}"` };
        }
    }
    return { status: 'satisfied' };
}

/**
 * Evaluate the plain form of `assertion`. Negation is applied by the caller.
 */
function evaluateAssertion(elements: Element[], subject: any, assertion: BaseAssertion, expected?: any, value?: any): AssertionOutcome {
    if (subject !== undefined && assertion === 'equal') {
        return {
            passed: deepEqual(subject, expected),
            failMessage: `Expected ${describeValue(subject)} to equal ${describeValue(expected)}`,
            negatedFailMessage: `Expected ${describeValue(subject)} not to equal ${describeValue(expected)}`
        };
    }

    if (assertion === 'be.a' || assertion === 'be.an') {
        // A type assertion is about a value, so it needs a wrapped subject;
        // against elements it would only ever restate what `assert()` returned.
        if (subject === undefined) {
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

    if (subject !== undefined && assertion === 'have.property') {
        if (expected === undefined || expected === null || String(expected).trim() === '') {
            return { error: `Expected a property name, e.g. should('have.property', 'name')` };
        }

        const name = String(expected);
        const found = readProperty(subject, name);
        if (!found.present) {
            return {
                passed: false,
                failMessage: `Expected ${describeValue(subject)} to have property "${name}"`,
                negatedFailMessage: `Expected the subject not to have property "${name}"`
            };
        }
        // Present with no expected value: the assertion is only about existence.
        if (value === undefined) {
            return {
                passed: true,
                failMessage: `Expected ${describeValue(subject)} to have property "${name}"`,
                negatedFailMessage: `Expected the subject not to have property "${name}", but it does`
            };
        }
        return {
            passed: deepEqual(found.value, value),
            failMessage: `Expected property "${name}" to be ${describeValue(value)}, got ${describeValue(found.value)}`,
            negatedFailMessage: `Expected property "${name}" not to be ${describeValue(value)}, but it was`
        };
    }

    if (assertion === 'exist') {
        if (subject !== undefined) {
            return {
                passed: !(subject === null || (subject.length !== undefined && subject.length === 0)),
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

    if (assertion === 'contain') {
        if (elements.length === 0) {
            // Nothing to contain anything, so `not.contain` holds vacuously.
            return {
                passed: false,
                negatedPassed: true,
                failMessage: `Expected elements to contain "${expected}", but no matching elements were found`
            };
        }

        const containing = elements.filter(el => el.querySelector(expected!) !== null);
        return {
            passed: containing.length === elements.length,
            negatedPassed: containing.length === 0,
            failMessage: `Expected element to contain "${expected}", but no descendant matched`,
            negatedFailMessage: `Expected no element to contain "${expected}", but ${containing.length} of ${elements.length} did`
        };
    }

    if (assertion === 'have.length') {
        const expectedLength = Number(expected);
        if (Number.isNaN(expectedLength)) {
            return { error: `Expected a numeric length value, got "${expected}"` };
        }

        const usesSubject = subject !== undefined && subject !== null && subject.length !== undefined;
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

    if (subject !== undefined && assertion === 'have.css') {
        const [prop, ...valParts] = expected?.split(':').map((s: string) => s.trim()) ?? [];
        const expectedValue = valParts.join(':').trim();
        if (!prop || expectedValue === undefined) {
            return { error: `Invalid CSS assertion syntax. Use "property: value"` };
        }

        if (subject instanceof Element) {
            const computed = window.getComputedStyle(subject);
            const actualValue = computed.getPropertyValue(prop);
            const computedExpected = normalizeCssValue(prop, expectedValue, subject.tagName, subject.parentElement);

            return {
                passed: actualValue.trim() === expectedValue || actualValue.trim() === computedExpected.trim(),
                failMessage: `Expected CSS "${prop}: ${expectedValue}", got "${actualValue}"`,
                negatedFailMessage: `Expected CSS "${prop}" not to be "${expectedValue}", but it was "${actualValue}"`
            };
        } else if (subject.style) { // It's a CSSStyleRule
            const actualValue = subject.style.getPropertyValue(prop).trim();
            const computedActual = document.body ? normalizeCssValue(prop, actualValue) : actualValue;
            const computedExpected = document.body ? normalizeCssValue(prop, expectedValue) : expectedValue;

            return {
                passed: actualValue === expectedValue || computedActual === computedExpected,
                failMessage: `Expected CSS rule "${prop}: ${expectedValue}", got "${actualValue}"`,
                negatedFailMessage: `Expected the CSS rule "${prop}" not to be "${expectedValue}", but it was "${actualValue}"`
            };
        }
        return { error: `Subject does not have a style property to check CSS against` };
    }

    // Element assertions implicitly fail when nothing matched. A negated
    // assertion instead holds vacuously: no element can violate it.
    if (subject === undefined && elements.length === 0) {
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

function createChain(elements: Element[], onResult: (passed: boolean, message: string, trace: string[]) => void = () => { }, messageTrace: string[] = [], failed: boolean = false, subject?: any, sourceOnly: boolean = false): Chainable {
    const chain: Chainable = {
        elements,
        messageTrace,
        failed,
        onResult,
        subject,
        sourceOnly,

        should(assertion: Assertion, expected?: string, value?: string): Chainable {
            if (failed) { return this; }

            const negated = assertion.startsWith(NOT_PREFIX);
            const baseAssertion = (negated ? assertion.slice(NOT_PREFIX.length) : assertion) as BaseAssertion;
            // Elements recovered from raw source cannot prove that something is
            // absent from the rendered output, so a negated assertion checks the
            // rendered set only (which is empty whenever a fallback kicked in).
            const target = negated && this.sourceOnly ? [] : this.elements;
            const outcome = evaluateAssertion(target, this.subject, baseAssertion, expected, value);

            let holds: boolean;
            let message: string;
            if ('error' in outcome) {
                // Malformed assertions fail regardless of negation.
                holds = false;
                message = outcome.error;
            } else if (negated ? (outcome.negatedPassed ?? !outcome.passed) : outcome.passed) {
                holds = true;
                message = `Assertion passed: ${assertion}${expected === undefined ? '' : ` with value "${expected}"`}`;
            } else {
                holds = false;
                message = negated
                    ? outcome.negatedFailMessage ?? `Expected "${baseAssertion}" not to hold, but it did`
                    : outcome.failMessage;
            }

            return createChain(this.elements, this.onResult, messageTrace.concat(message), holds ? this.failed : true, this.subject, this.sourceOnly);
        },

        click(): Chainable {
            if (failed) { return this; }

            this.elements.forEach(el => {
                if (el instanceof HTMLElement) {
                    el.click();
                }
            });
            return chain;
        },

        type(text: string): Chainable {
            if (failed) { return this; }
            this.elements.forEach(el => {
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                    el.value = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                } else {
                    throw new Error('`type()` can only be called on <input> or <textarea> elements');
                }
            });
            return chain;
        },

        clear(): Chainable {
            if (failed) { return this; }
            this.elements.forEach(el => {
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
            return chain;
        },

        find(selector: string): Chainable {
            if (failed) { return this; }
            let found: Element[] = [];
            this.elements.forEach(el => {
                found = found.concat(Array.from(el.querySelectorAll(selector)));
            });
            return createChain(found, this.onResult, this.messageTrace, this.failed, this.subject, this.sourceOnly);
        },

        get(selector: string): Chainable {
            return this.find(selector);
        },

        contains(text: string): Chainable {
            if (failed) { return this; }

            const all = Array.from(document.querySelectorAll('*'));
            const found = all.filter(el => el.textContent?.includes(text));
            return createChain(found);
        },

        run(failMessage?: string, successMessage?: string): void {
            if (this.onResult) {
                this.onResult(!this.failed, (this.failed ? (failMessage) : (successMessage)) ?? this.messageTrace.join('\n'), this.messageTrace);
            }
        }
    };
    return chain;
}

/*
declare global {
    interface Window {
        cy: {
            get(selector: string): Chainable;
        };
    }
}
*/

const sy = Object.assign(
    function (el: string | Element | Element[], onResult?: (passed: boolean, message: string, trace: string[]) => void, options?: { sourceOnly?: boolean }): Chainable {
        const sourceOnly = options?.sourceOnly === true;
        if (typeof el === 'string') {
            const nodes = Array.from(document.querySelectorAll(el));
            return createChain(nodes, onResult, [], false, undefined, sourceOnly);
        } else if (el instanceof Element) {
            return createChain([el], onResult, [], false, undefined, sourceOnly);
        } else if (Array.isArray(el)) {
            return createChain(el, onResult, [], false, undefined, sourceOnly);
        } else {
            throw new Error('Invalid argument: must be a string selector, Element, or array of Elements');
        }
    }, {
    wrap: (object: any, onResult?: (passed: boolean, message: string, trace: string[]) => void) => {
        return createChain([], onResult, [], false, object);
    },
    getRule: (selector: string, onResult?: (passed: boolean, message: string, trace: string[]) => void) => {
        const allSheets: StyleSheetList[] = [document.styleSheets];
        document.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot?.styleSheets) {
                allSheets.push(el.shadowRoot.styleSheets);
            }
        });

        for (const sheets of allSheets) {
            for (let i = 0; i < sheets.length; i++) {
                const sheet = sheets[i] as CSSStyleSheet;
                try {
                    const rules = sheet.cssRules || sheet.rules;
                    for (let j = 0; j < rules.length; j++) {
                        const rule = rules[j];
                        if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
                            return createChain([], onResult, [], false, rule);
                        }
                    }
                } catch (e) {
                    // Ignore cross-origin issues
                }
            }
        }
        return createChain([], onResult, [`Expected CSS rule for "${selector}" to exist, but found none`], true, null);
    }
}
);

// ——— support cy.wrap(obj) ———
// function wrap<T>(subject: T, onResult?: (passed: boolean, message: string, trace: string[]) => void): Chainable {
//   return createChain([], onResult, [], false, subject);
// }
// (sy as any).wrap = wrap;
// export { wrap };

export default sy;

// export default {
//     get(selector: string) {
//         const nodes = Array.from(document.querySelectorAll(selector));
//         return createChain(nodes);
//     }
// };
