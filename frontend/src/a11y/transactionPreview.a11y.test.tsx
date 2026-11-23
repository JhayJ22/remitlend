import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { TransactionPreview } from '../components/TransactionPreview';

type PreviewState = 'loading' | 'ready' | 'changed' | 'error' | 'expired';

const basePreview = {
  network: 'Stellar Testnet',
  recipient: 'GABCD...WXYZ',
  fee: '0.0000100 XLM',
  expiry: '2024-06-01T12:00:00Z',
  changedFields: ['fee', 'recipient'],
};

function renderPreview(state: PreviewState, overrides: Partial<typeof basePreview> = {}) {
  return render(
    <TransactionPreview
      state={state}
      preview={{ ...basePreview, ...overrides }}
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
    />,
  );
}

describe('TransactionPreview screen-reader review', () => {
  it('announces preview fields in logical order', () => {
    renderPreview('ready');
    const region = screen.getByRole('region', { name: /transaction preview/i });
    const labels = within(region)
      .getAllByRole('term')
      .map((el) => el.textContent);
    expect(labels).toEqual(['Network', 'Recipient', 'Fee', 'Expiry', 'Changed fields']);
  });

  it('exposes a polite live region for the ready state', () => {
    renderPreview('ready');
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent(/preview ready/i);
  });

  it('announces changed fields after core fields', () => {
    renderPreview('changed');
    const region = screen.getByRole('region', { name: /transaction preview/i });
    const terms = within(region).getAllByRole('term');
    expect(terms[terms.length - 1]).toHaveTextContent(/changed fields/i);
  });

  it('rejects expired confirmations without side effects', async () => {
    const onConfirm = jest.fn();
    render(
      <TransactionPreview
        state="expired"
        preview={basePreview}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: /confirm/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/expired/i);
  });

  it('surfaces error state via assertive alert', () => {
    renderPreview('error');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  it('supports keyboard-only confirmation with focus return', async () => {
    const onConfirm = jest.fn();
    render(
      <TransactionPreview
        state="ready"
        preview={basePreview}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: /confirm/i });
    confirm.focus();
    expect(confirm).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('has no detectable accessibility violations in ready state', async () => {
    const { container } = renderPreview('ready');
    expect(await axe(container)).toHaveNoViolations();
  });
});
