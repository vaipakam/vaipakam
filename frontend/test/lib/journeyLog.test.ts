import { describe, it, expect, beforeEach } from 'vitest';
import {
  emit,
  beginStep,
  classifyError,
  exportDiagnostics,
  getEvents,
  clearJourney,
  subscribe,
} from '../../src/lib/journeyLog';

beforeEach(() => {
  clearJourney();
  sessionStorage.clear();
});

describe('emit', () => {
  it('appends an event with coerced id/timestamp fields and persists it', () => {
    const before = Date.now();
    const ev = emit({
      area: 'offer-create',
      flow: 'createLenderOffer',
      step: 'submit',
      status: 'start',
      loanId: 42n, // bigint → String
      offerId: 7,
      nftId: 'nft-1',
    });
    expect(typeof ev.id).toBe('string');
    expect(ev.loanId).toBe('42');
    expect(ev.offerId).toBe('7');
    expect(ev.nftId).toBe('nft-1');
    expect(ev.timestamp).toBeGreaterThanOrEqual(before);
    expect(getEvents()).toHaveLength(1);
  });

  it('caps the buffer at BUFFER_SIZE (200) and keeps the tail', () => {
    for (let i = 0; i < 210; i++) {
      emit({ area: 'wallet', flow: 'f', step: `s${i}`, status: 'info' });
    }
    const events = getEvents();
    expect(events).toHaveLength(200);
    expect(events[0].step).toBe('s10');
    expect(events[199].step).toBe('s209');
  });

  it('notifies subscribers on every emit and fires once on subscribe with the current buffer', () => {
    emit({ area: 'wallet', flow: 'f', step: 's1', status: 'info' });
    const seen: number[] = [];
    const unsub = subscribe((events) => seen.push(events.length));
    expect(seen).toEqual([1]); // initial replay
    emit({ area: 'wallet', flow: 'f', step: 's2', status: 'info' });
    expect(seen).toEqual([1, 2]);
    unsub();
    emit({ area: 'wallet', flow: 'f', step: 's3', status: 'info' });
    expect(seen).toEqual([1, 2]); // no more notifications
  });
});

describe('beginStep', () => {
  it('emits a start event and correlates success back to it', () => {
    const step = beginStep({ area: 'repay', flow: 'repayLoan', step: 'submit' });
    step.success({ note: 'tx mined' });
    const events = getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].status).toBe('start');
    expect(events[1].status).toBe('success');
    expect(events[1].correlationId).toBe(events[0].id);
    expect(events[1].note).toBe('tx mined');
  });

  it('classifies a wallet rejection in failure() and sets errorType', () => {
    const step = beginStep({ area: 'wallet', flow: 'connect', step: 'request' });
    step.failure({ code: 4001, message: 'User rejected' });
    const [, failure] = getEvents();
    expect(failure.status).toBe('failure');
    expect(failure.errorType).toBe('wallet');
    expect(failure.errorMessage).toMatch(/rejected/i);
  });

  it('extracts selector + error data when failure is a revert', () => {
    const step = beginStep({ area: 'repay', flow: 'repayLoan', step: 'submit' });
    step.failure({ reason: 'execution reverted', data: '0xe450d38c' });
    const [, failure] = getEvents();
    expect(failure.errorType).toBe('contract-revert');
    expect(failure.errorSelector).toBe('0xe450d38c');
    expect(failure.errorData).toBe('0xe450d38c');
  });

  it('lets the caller override errorType / errorMessage via extra', () => {
    const step = beginStep({ area: 'offer-accept', flow: 'acceptOffer', step: 'submit' });
    step.failure(new Error('something'), {
      errorType: 'validation',
      errorMessage: 'pre-flight check failed',
    });
    const [, failure] = getEvents();
    expect(failure.errorType).toBe('validation');
    expect(failure.errorMessage).toBe('pre-flight check failed');
  });
});

describe('classifyError', () => {
  it('maps EIP-1193 code 4001 to a wallet-reject', () => {
    expect(classifyError({ code: 4001 })).toEqual({
      type: 'wallet',
      message: 'User rejected the request.',
    });
  });

  it('maps ACTION_REJECTED (string) the same as 4001', () => {
    expect(classifyError({ code: 'ACTION_REJECTED' }).type).toBe('wallet');
  });

  it('maps 4100 / -32601 to wallet-method-unavailable and preserves message', () => {
    expect(classifyError({ code: 4100, message: 'no such method' })).toEqual({
      type: 'wallet',
      message: 'no such method',
    });
    expect(classifyError({ code: -32601 }).type).toBe('wallet');
  });

  it('maps -32002 to a pending-wallet-request', () => {
    expect(classifyError({ code: -32002 }).type).toBe('wallet');
  });

  it('treats any error with reason/shortMessage as contract-revert', () => {
    expect(classifyError({ reason: 'bad state' })).toEqual({
      type: 'contract-revert',
      message: 'bad state',
    });
    expect(classifyError({ shortMessage: 'nonce too low' }).type).toBe('contract-revert');
  });

  it('maps NETWORK/TIMEOUT/SERVER codes to rpc', () => {
    expect(classifyError({ code: 'NETWORK_ERROR', message: 'offline' }).type).toBe('rpc');
    expect(classifyError({ code: 'TIMEOUT', message: 'x' }).type).toBe('rpc');
  });

  it('falls through to unknown for everything else', () => {
    expect(classifyError({ message: 'mystery' }).type).toBe('unknown');
    expect(classifyError(null).type).toBe('unknown');
  });
});

describe('exportDiagnostics', () => {
  it('serializes events as JSON with addresses redacted', () => {
    emit({
      area: 'wallet',
      flow: 'connect',
      step: 'resolve',
      status: 'success',
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
    });
    const out = JSON.parse(exportDiagnostics());
    expect(out.events).toHaveLength(1);
    expect(out.events[0].wallet).toBe('0x1234…5678');
    expect(typeof out.exportedAt).toBe('string');
  });

  it('preserves null wallet and short strings as-is', () => {
    emit({ area: 'wallet', flow: 'x', step: 'y', status: 'info', wallet: null });
    emit({ area: 'wallet', flow: 'x', step: 'y', status: 'info', wallet: 'short' });
    const out = JSON.parse(exportDiagnostics());
    expect(out.events[0].wallet).toBeNull();
    expect(out.events[1].wallet).toBe('short');
  });
});

describe('clearJourney', () => {
  it('wipes the in-memory buffer and persisted storage', () => {
    emit({ area: 'wallet', flow: 'x', step: 'y', status: 'info' });
    expect(getEvents()).toHaveLength(1);
    clearJourney();
    expect(getEvents()).toHaveLength(0);
    expect(sessionStorage.getItem('vaipakam.journey')).toBe('[]');
  });
});
