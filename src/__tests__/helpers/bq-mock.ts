/**
 * Shared BigQuery mock for the football controller tests.
 *
 * Not named *.test.ts on purpose — jest's testMatch would collect it as a suite.
 *
 * The controllers build `new BigQuery(...)` at module scope, so this has to be applied
 * with a hoisted jest.mock factory before the controller is imported. Callers do:
 *
 *     jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
 *     import { mockQuery } from './helpers/bq-mock';
 *
 * SHAPE CONTRACT — the thing that will cost you an hour if you get it wrong. Handlers
 * destructure results as:
 *
 *     const [rows] = await bigquery.query(...)          -> resolve [ [ {...} ] ]
 *     const [[{ total }]] = await bigquery.query(...)   -> resolve [ [ { total: 1 } ] ]
 *
 * So a resolved value is ALWAYS an array whose first element is the row array. Use the
 * `rows()` and `count()` helpers below rather than hand-nesting it.
 */

export const mockQuery: jest.Mock = jest.fn();

/** Pass to jest.mock's factory to stand in for the @google-cloud/bigquery module. */
export function factory() {
  return {
    BigQuery: jest.fn().mockImplementation(() => ({ query: mockQuery })),
  };
}

/** A row-returning result. */
export function rows(values: any[]): [any[]] {
  return [values];
}

/** A COUNT(*) AS total result. */
export function count(total: number): [Array<{ total: number }>] {
  return [[{ total }]];
}

/**
 * Queue results in the order the handler will ask for them. Most handlers issue the page
 * query first and the count second.
 */
export function queue(...results: any[][]): void {
  for (const r of results) mockQuery.mockResolvedValueOnce(r as any);
}

/** Every SQL string the handler sent, for asserting on projection and ORDER BY. */
export function sentQueries(): string[] {
  return mockQuery.mock.calls.map((c) => c[0]?.query ?? '');
}

/** The params object of the nth call. */
export function sentParams(n = 0): Record<string, any> {
  return mockQuery.mock.calls[n]?.[0]?.params ?? {};
}

/**
 * The params of the first call whose SQL matches `pattern`.
 *
 * Preferred over indexing by call position: a handler that gains a query — a
 * permission check, a migration step — should not break an assertion about a
 * different one.
 */
export function sentParamsFor(pattern: RegExp): Record<string, any> {
  const call = mockQuery.mock.calls.find((c) => pattern.test(c[0]?.query ?? ''));
  return call?.[0]?.params ?? {};
}
