/**
 * Recursively compares two values for deep equality.
 */
export function deepEqual(a: any, b: any): boolean {
  // 1. Strict equality or both NaN
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;

  // 2. Compare Date objects
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // 3. Compare RegExp
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  // 4. If types differ or either is null/undefined, not equal
  if (typeof a !== typeof b || a == null || b == null) {
    return false;
  }

  // 5. Compare arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // 6. Compare plain objects
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    // ensure same set of keys
    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  // 7. Fallback: not equal
  return false;
}