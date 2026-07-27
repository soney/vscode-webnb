/**
 * Recursively compares two values for deep equality.
 *
 * This backs `wrap(value).should('equal', expected)`, so it aims at what a
 * learner writing that line means by "equal", which is roughly Chai's
 * `deep.equal`:
 *
 *  - `NaN` equals `NaN`. It is the one value not equal to itself, and a test
 *    asserting a computation produced `NaN` should pass.
 *  - Dates, RegExps, Maps, Sets, Errors and boxed primitives compare by what
 *    they hold rather than by identity.
 *  - Values of different kinds are never equal, so `[1, 2]` does not equal
 *    `{ 0: 1, 1: 2 }` even though they enumerate the same keys.
 *  - Class instances compare by their own enumerable properties, so a
 *    `new Point(1, 2)` can equal `{ x: 1, y: 2 }`. Prototypes are deliberately
 *    not compared: a learner checking the shape of their object should not
 *    have to reproduce its class.
 *  - Circular structures terminate instead of overflowing the stack.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
    return equals(a, b, new Map());
}

/** `[object Date]` → `Date`. Distinguishes builtins that `typeof` lumps together. */
function kindOf(value: object): string {
    return Object.prototype.toString.call(value).slice(8, -1);
}

/**
 * `seen` maps each left-hand object to the right-hand objects it is already
 * being compared against, which is what stops circular structures from
 * recursing forever. Pairs are never removed: a pair that finished comparing
 * unequal has already aborted the whole walk, so a pair seen twice is either
 * still in progress (circular) or known equal. Either way, `true` is right.
 */
function equals(a: unknown, b: unknown, seen: Map<object, Set<object>>): boolean {
    if (a === b) {
        return true;
    }

    // Past the identity check, the only equal primitives left are NaN and NaN.
    if (typeof a === 'number' || typeof b === 'number') {
        return typeof a === 'number' && typeof b === 'number'
            && Number.isNaN(a) && Number.isNaN(b);
    }

    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return false;
    }

    const kind = kindOf(a);
    if (kind !== kindOf(b)) {
        return false;
    }

    const partners = seen.get(a);
    if (partners) {
        if (partners.has(b)) {
            return true;
        }
        partners.add(b);
    } else {
        seen.set(a, new Set([b]));
    }

    switch (kind) {
        case 'Date':
            // Object.is so two Invalid Dates (both NaN) count as equal.
            return Object.is((a as Date).getTime(), (b as Date).getTime());

        case 'RegExp':
            return (a as RegExp).source === (b as RegExp).source
                && (a as RegExp).flags === (b as RegExp).flags;

        case 'String':
        case 'Number':
        case 'Boolean':
        case 'Symbol':
        case 'BigInt':
            // Boxed primitives: compare what they wrap.
            return Object.is(a.valueOf(), b.valueOf());

        case 'Error':
            return (a as Error).name === (b as Error).name
                && (a as Error).message === (b as Error).message;

        case 'Array': {
            const left = a as unknown[];
            const right = b as unknown[];
            if (left.length !== right.length) {
                return false;
            }
            // Indexed rather than `every`, which skips holes in sparse arrays.
            for (let i = 0; i < left.length; i++) {
                if (!equals(left[i], right[i], seen)) {
                    return false;
                }
            }
            return true;
        }

        case 'Map': {
            const left = a as Map<unknown, unknown>;
            const right = b as Map<unknown, unknown>;
            if (left.size !== right.size) {
                return false;
            }
            for (const [key, value] of left) {
                // Keys match by identity, the same way Map itself looks them
                // up; only values are compared deeply.
                if (!right.has(key) || !equals(value, right.get(key), seen)) {
                    return false;
                }
            }
            return true;
        }

        case 'Set': {
            const left = a as Set<unknown>;
            const right = b as Set<unknown>;
            if (left.size !== right.size) {
                return false;
            }
            for (const item of left) {
                if (right.has(item)) {
                    continue;
                }
                // Absent by identity, so look for a deeply equal member. Two
                // members of `left` can in principle match the same member of
                // `right`; with equal sizes that is rare enough to accept.
                let found = false;
                for (const other of right) {
                    if (equals(item, other, seen)) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    return false;
                }
            }
            return true;
        }

        default: {
            const left = a as Record<string, unknown>;
            const right = b as Record<string, unknown>;
            const keys = Object.keys(left);
            if (keys.length !== Object.keys(right).length) {
                return false;
            }
            for (const key of keys) {
                // hasOwnProperty rather than an undefined check, so that
                // `{ a: undefined }` and `{ b: undefined }` stay unequal.
                if (!Object.prototype.hasOwnProperty.call(right, key)) {
                    return false;
                }
                if (!equals(left[key], right[key], seen)) {
                    return false;
                }
            }
            return true;
        }
    }
}
