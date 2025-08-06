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
 */

type Assertion = 'exist' | 'have.text' | 'have.class' | 'have.attribute' | 'have.css' | 'equal';

interface Chainable {
    failed: boolean;
    messageTrace: string[];
    elements: Element[];
    onResult: (passed: boolean, message: string, trace: string[]) => void;

    should(assertion: Assertion, expected?: string): Chainable;
    click(): Chainable;
    type(text: string): Chainable;
    clear(): Chainable;
    find(selector: string): Chainable;
    get(selector: string): Chainable;
    contains(text: string): Chainable;
    run(failMessage?: string, successMessage?: string): void;
    subject?: any;
    // result(onPass: (message: string, trace: string[]) => void, onFail: (message: string, trace: string[]) => void): void;
}

function createChain(elements: Element[], onResult: (passed: boolean, message: string, trace: string[]) => void = () => {},  messageTrace: string[]=[], failed: boolean = false, subject?: any): Chainable {
    const chain: Chainable = {
        elements,
        messageTrace,
        failed,
        onResult,
        subject,

        should(assertion: Assertion, expected?: string): Chainable {
            if(failed) { return this; }

            console.log(this.subject, assertion, expected);

            if(this.subject !== undefined) {
                if(assertion === 'equal') {
                    console.log('Checking equality', this.subject, expected);
                    if(deepEqual(this.subject, expected)) {
                        return createChain(this.elements, this.onResult, messageTrace.concat(`Assertion passed: ${assertion} with value "${expected}"`), this.failed, this.subject);
                    } else {
                        return createChain(this.elements, this.onResult, messageTrace.concat(`Expected ${this.subject} to equal ${expected}`), true, this.subject);
                    }
                }
            }

            if(assertion === 'exist') {
                if(this.elements.length === 0) {
                    return createChain([], this.onResult, messageTrace.concat('Expected at least one element to exist, but found none'), true, this.subject);
                } else {
                    return createChain(this.elements, this.onResult, messageTrace.concat(`Assertion passed: ${assertion}`), this.failed, this.subject);
                }
            }

            for (const el of this.elements) {
                if(assertion === 'have.text') {
                    if(el.textContent !== expected) {
                        return createChain(this.elements, this.onResult, messageTrace.concat(`Expected text "${expected}", got "${el.textContent}"`), true, this.subject);
                    }
                } else if(assertion === 'have.class') {
                    if (!(el instanceof HTMLElement) || !el.classList.contains(expected!)) {
                        return createChain(this.elements, this.onResult, messageTrace.concat(`Expected element to have class "${expected}"`), true, this.subject);
                        // throw new Error(`Expected element to have class "${expected}"`);
                    }
                } else if(assertion === 'have.attribute') {
                    if (!(el instanceof HTMLElement) || !el.hasAttribute(expected!)) {
                        return createChain(this.elements, this.onResult, messageTrace.concat(`Expected element to have attribute "${expected}"`), true, this.subject);
                        // throw new Error(`Expected element to have attribute "${expected}"`);
                    }
                } else if(assertion === 'have.css') {
                    const [prop, expectedValue] = expected?.split(':').map(s => s.trim()) ?? [];
                    if (!prop || expectedValue === undefined) {
                        return createChain(this.elements, this.onResult, messageTrace.concat(`Invalid CSS assertion syntax. Use "property: value"`), true, this.subject);
                    }
                    if (!(el instanceof HTMLElement)) {
                        continue;
                    }
                    const computed = window.getComputedStyle(el);
                    const actualValue = computed.getPropertyValue(prop);
                    if (actualValue.trim() !== expectedValue) {
                        return createChain(this.elements, this.onResult, messageTrace.concat(`Expected CSS "${prop}: ${expectedValue}", got "${actualValue}"`), true, this.subject);
                    }
                }
            }
            return createChain(this.elements, this.onResult, messageTrace.concat(`Assertion passed: ${assertion}${expected ? ` with value "${expected}"` : ''}`), this.failed, this.subject);
        },

        click(): Chainable {
            if(failed) { return this; }

            this.elements.forEach(el => {
                if (el instanceof HTMLElement) {
                    el.click();
                }
            });
            return chain;
        },

        type(text: string): Chainable {
            if(failed) { return this; }
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
            if(failed) { return this; }
            this.elements.forEach(el => {
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
            return chain;
        },

        find(selector: string): Chainable {
            if(failed) { return this; }
            let found: Element[] = [];
            this.elements.forEach(el => {
                found = found.concat(Array.from(el.querySelectorAll(selector)));
            });
            return createChain(found, this.onResult, this.messageTrace, this.failed, this.subject);
        },

        get(selector: string): Chainable {
            return this.find(selector);
        },

        contains(text: string): Chainable {
            if(failed) { return this; }

            const all = Array.from(document.querySelectorAll('*'));
            const found = all.filter(el => el.textContent?.includes(text));
            return createChain(found);
        },

        run(failMessage?: string, successMessage?: string): void {
            if(this.onResult) {
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
    function (el: string|Element|Element[], onResult?: (passed: boolean, message: string, trace: string[]) => void): Chainable {
        if (typeof el === 'string') {
            const nodes = Array.from(document.querySelectorAll(el));
            return createChain(nodes, onResult);
        } else if (el instanceof Element) {
            return createChain([el], onResult);
        } else if (Array.isArray(el)) {
            return createChain(el, onResult);
        } else {
            throw new Error('Invalid argument: must be a string selector, Element, or array of Elements');
        }
    }, { 
        wrap: (object: any, onResult?: (passed: boolean, message: string, trace: string[]) => void) => {
            return createChain([], onResult, [], false, object);
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
