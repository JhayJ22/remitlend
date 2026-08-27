import { describe, it, expect } from '@jest/globals';

/**
 * Guards the controller-split refactor (issue #41): every handler previously
 * defined on loanController must remain importable from it (re-exported), so
 * existing route wiring and tests keep working.
 */
const loanController = await import('../controllers/loanController.js');

const EXPECTED_HANDLERS = [
  'createTestLoan',
  'buildCancelLoanTx',
  'buildRejectLoanTx',
  'markLoanDefaulted',
  'contestDefault',
  'previewLoanAmortizationSchedule',
  'getLoanAmortizationSchedule',
  'requestLoan',
  'repayLoan',
  'depositCollateral',
  'releaseCollateral',
  'refinanceLoan',
  'extendLoan',
  'buildLiquidateLoan',
  'submitTransaction',
  'getLoanConfigEndpoint',
  'getBorrowerLoans',
  'getLoanDetails',
  'roundToCents',
];

describe('loanController re-exports after split', () => {
  for (const name of EXPECTED_HANDLERS) {
    it(`exports ${name}`, () => {
      expect((loanController as Record<string, unknown>)[name]).toBeDefined();
    });
  }
});
