// Minimal TS test harness (mirrors the role unittest played in the Python
// tests this directory replaces): collect `test()` cases, run them in
// declaration order, exit 0 on success / 1 with a FAIL line per case.
// Run directly: npx tsx evals/harness/tests/<name>.test.ts

type TestFn = () => void | Promise<void>;

const tests: Array<[string, TestFn]> = [];

export function test(name: string, fn: TestFn): void {
  tests.push([name, fn]);
}

export function assertEq(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertIn(needle: unknown, haystack: string, msg?: string): void {
  if (!haystack.includes(String(needle))) {
    throw new Error(msg ?? `expected ${JSON.stringify(needle)} in ${haystack.slice(0, 200)}`);
  }
}

export function assertTrue(cond: unknown, msg?: string): void {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

export function assertClose(actual: number, expected: number, tol = 1e-9): void {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`expected ${expected} ± ${tol}, got ${actual}`);
  }
}

export async function runAll(): Promise<void> {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failures += 1;
      console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures > 0) {
    console.error(`${failures}/${tests.length} test(s) failed`);
    process.exit(1);
  }
  console.log(`all tests passed (${tests.length})`);
}
