import { describe, it, expect, jest } from '@jest/globals';
import { parse, validate, specifiedRules } from 'graphql';
import { typeDefs } from '../graphql/schema.js';
import { createQueryBudgetRule, loadQueryBudgetLimits } from '../graphql/queryBudget.js';

const roomy = { maxDepth: 10, maxAliases: 10, maxCost: 100000 };

const check = (query: string, limits: typeof roomy) =>
  validate(typeDefs, parse(query), [...specifiedRules, createQueryBudgetRule(limits, 'cid-1')]);

describe('graphql query budget', () => {
  it('accepts at the cost boundary and rejects just above it', () => {
    // loans: 10 + 2 * (edges: 1 + id 1 + status 1) = 16
    const q = '{ loans(limit: 2) { edges { id status } } }';
    expect(check(q, { ...roomy, maxCost: 16 })).toHaveLength(0);
    expect(check(q, { ...roomy, maxCost: 15 })).toHaveLength(1);
  });

  it('rejects over-budget cost with a correlation id and no internals', () => {
    const errors = check('{ loans(limit: 100) { edges { id } } }', { ...roomy, maxCost: 50 });
    expect(errors).toHaveLength(1);
    expect(errors[0].extensions).toMatchObject({
      code: 'QUERY_COMPLEXITY_EXCEEDED',
      correlationId: 'cid-1',
      actual: 210,
      limit: 50,
    });
    expect(errors[0].message).not.toMatch(/Loan|loans/);
  });

  it('enforces the alias limit', () => {
    const q = '{ a: poolBalance(token: "X") b: poolBalance(token: "X") c: poolBalance(token: "X") }';
    expect(check(q, { ...roomy, maxAliases: 2 })).toHaveLength(1);
    expect(check(q, { ...roomy, maxAliases: 3 })).toHaveLength(0);
  });

  it('enforces the depth limit', () => {
    const q = '{ loans { edges { id } } }';
    expect(check(q, { ...roomy, maxDepth: 2 })).toHaveLength(1);
    expect(check(q, { ...roomy, maxDepth: 3 })).toHaveLength(0);
  });

  it('expands fragments deterministically', () => {
    const q = 'query { loans(limit: 5) { ...F } } fragment F on LoanConnection { edges { id } }';
    const limits = { ...roomy, maxCost: 5 };
    expect(check(q, limits)).toHaveLength(1);
    expect(check(q, limits)).toHaveLength(1);
  });

  it('falls back to defaults on malformed config', () => {
    const l = loadQueryBudgetLimits({
      GRAPHQL_MAX_DEPTH: '0',
      GRAPHQL_MAX_ALIASES: 'abc',
      GRAPHQL_MAX_COST: '-5',
    });
    expect(l).toEqual({ maxDepth: 7, maxAliases: 10, maxCost: 1000 });
    expect(loadQueryBudgetLimits({ GRAPHQL_MAX_COST: '200' }).maxCost).toBe(200);
  });
});

describe('graphql dataloader batching', () => {
  it('fetches 100 loans with at most 2 DB queries', async () => {
    jest.resetModules();
    const queryMock = jest.fn(async (_sql: string, params: unknown[]) => ({
      rows: (params[0] as string[]).map((id) => ({ id })),
    }));
    jest.unstable_mockModule('../db/connection.js', () => ({ query: queryMock }));
    const { createDataLoaders, clearDataLoaders } = await import('../graphql/dataLoaders.js');
    clearDataLoaders();
    const ids = Array.from({ length: 100 }, (_, i) => String(i));
    const rows = await Promise.all(ids.map((id) => createDataLoaders().loanLoader.load(id)));
    expect(rows).toHaveLength(100);
    expect(queryMock.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
