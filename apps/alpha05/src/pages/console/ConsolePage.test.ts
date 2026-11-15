/**
 * RW-76, RW-77 — the Console states where its settings came from and why,
 * names every switch, never writes a setting it does not know, and states
 * the global pause from a live read.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import '../../test/i18n';
import type { SupportedChain } from '../../chain/chains';
import type { PauseRead } from '../../shared/console/direct';
import type { ConsoleSettings } from '../../shared/console/source';
import { HelpProvider } from '../../shared/help/HelpContext';
import { ConsoleView } from './ConsolePage';

const chain: SupportedChain = {
  chainId: 84532,
  name: 'Base Sepolia',
  rpcEndpoints: [],
  blockExplorer: 'https://sepolia.basescan.org',
  testnet: true,
  nativeGasSymbol: 'ETH',
  diamondAddress: '0x00000000000000000000000000000000000000D1' as Address,
  deployBlock: 1,
};
const NOW = 1_900_000_000;
const ready = <T>(data: T) => ({ data, state: 'ready' as const, error: null, refetch: () => {} });
const reading = { data: null, state: 'reading' as const, error: null, refetch: () => {} };
const pauseNone = ready<PauseRead>({ block: 77n, timestamp: NOW - 1, paused: false, manual: false, pausedUntil: 0n, escapeOpensAt: 0n });
const html = (settings: Parameters<typeof ConsoleView>[0]['settings'], pause: Parameters<typeof ConsoleView>[0]['pause'] = pauseNone) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(HelpProvider, null, createElement(ConsoleView, { chain, settings, pause, nowSec: NOW }))),
  );

const values = {
  treasuryFeeBps: '200',
  partialFillEnabled: true,
  keepersPaused: false,
  autoPauseAvailableAt: '0',
  autoPauseDurationSeconds: '1800',
  partialLiqDustFloorNumeraire: '0',
  priceGuardDelaySeconds: '0',
};

describe('ConsoleView', () => {
  it('states a snapshot source with its block and age, and the settings by name', () => {
    const s: ConsoleSettings = { source: 'snapshot', values, unreported: ['minOfferValueNumeraire'], block: 1_000, asOf: NOW - 120 };
    const out = html(ready(s));
    expect(out).toContain('data-source="snapshot"');
    expect(out).toContain('From the index’s snapshot of block 1000');
    expect(out).toContain('2 min ago');
    expect(out).toContain('Treasury share of interest');
    expect(out).toContain('2%');
    expect(out).toContain('Partial liquidation: dust floor');
    expect(out).toMatch(/data-setting="partialLiqDustFloorNumeraire" data-value="&quot;0&quot;">Off/);
    expect(out).toContain('Smallest offer value');
    expect(out).toContain('did not answer these');
    // An eventless setting shown from a snapshot says so.
    expect(out).toContain('Can change without an on-chain announcement');
  });
  it('states why the chain was read, and that the code changed', () => {
    const s: ConsoleSettings = {
      source: 'chain',
      values,
      unreported: [],
      block: 2_000,
      asOf: NOW - 5,
      why: 'unlabelled',
      indexError: null,
      bundleIssue: { kind: 'codeChanged' },
    };
    const out = html(ready(s));
    expect(out).toContain('data-source="chain"');
    expect(out).toContain('data-why="unlabelled"');
    expect(out).toContain('Read from the chain at block 2000');
    expect(out).toContain('The protocol&#x27;s code has changed since this app was built');
    expect(out).not.toContain('Can change without an on-chain announcement');
  });
  it('states unknown settings and writes no value', () => {
    const s: ConsoleSettings = { source: 'unknown', why: 'none', indexError: null, failure: { kind: 'read', reason: 'rpc down' } };
    const out = html(ready(s));
    expect(out).toContain('data-source="unknown"');
    expect(out).toContain('are unknown: the snapshot could not be used and the chain read failed (rpc down)');
    expect(out).not.toContain('data-testid="console-settings"');
    expect(out).toContain('data-switch="partialFill" data-state="unknown"');
  });
  it('flags an answer whose age is unknown or more than a day old', () => {
    const future: ConsoleSettings = { source: 'chain', values, unreported: [], block: 2, asOf: NOW + 3_600, why: 'old', indexError: null, bundleIssue: null };
    expect(html(ready(future))).toContain('Treat them as unverified');
    const old: ConsoleSettings = { ...future, asOf: NOW - 90_000 };
    expect(html(ready(old))).toContain('more than a day ago');
  });
  it('names every switch with its class, and the dark ones as not read', () => {
    const s: ConsoleSettings = { source: 'snapshot', values, unreported: [], block: 1, asOf: NOW - 1 };
    const out = html(ready(s));
    expect(out).toContain('data-switch="partialFill" data-state="on"');
    expect(out).toContain('data-switch="keepersPaused" data-state="running"');
    expect(out).toContain('data-switch="autoLend" data-state="unanswered"');
    for (const dark of ['fullTariff', 'serviceCapacity', 'keeperReward', 'discountPriceSource', 'cutoverArming', 'horizon']) {
      expect(out).toContain(`data-switch="${dark}" data-state="notRead"`);
    }
    expect(out).toContain('Class 1a: new positions');
    expect(out).toContain('This page shows a subset');
    expect(out).toContain('never reprices an open loan');
  });
  it('states the global pause from the live read, and its next window', () => {
    const s: ConsoleSettings = { source: 'snapshot', values, unreported: [], block: 1, asOf: NOW - 1 };
    expect(html(ready(s))).toContain('data-pause="none"');
    expect(html(ready(s))).toContain('none has frozen the protocol yet');
    expect(html(ready(s))).toContain('An automatic pause lasts 30 min');
    const auto = html(
      ready(s),
      ready<PauseRead>({ block: 9n, timestamp: NOW, paused: true, manual: false, pausedUntil: BigInt(NOW + 600), escapeOpensAt: 0n }),
    );
    expect(auto).toContain('data-pause="auto"');
    expect(auto).toContain('10 min from now');
    const manual = html(
      ready(s),
      ready<PauseRead>({ block: 9n, timestamp: NOW, paused: true, manual: true, pausedUntil: 0n, escapeOpensAt: BigInt(NOW + 7_200) }),
    );
    expect(manual).toContain('Paused by governance at block 9, with no set end');
    // Withdrawals are not closed for good: the escape route's time is stated.
    expect(manual).toContain('its escape route opens and withdrawals of what is free reopen');
    expect(
      html(ready(s), ready<PauseRead>({ block: 9n, timestamp: NOW, paused: true, manual: true, pausedUntil: 0n, escapeOpensAt: BigInt(NOW - 1) })),
    ).toContain('Its escape route was open at block 9');
    expect(html(ready(s), ready<PauseRead>({ block: 9n, timestamp: NOW, paused: true, manual: true, pausedUntil: 0n, escapeOpensAt: 0n }))).toContain(
      'This pause opens no escape route',
    );
    expect(manual).not.toContain('also runs until');
    // Governance's pause during an automatic window: the window's end is not
    // when the pause ends.
    const both = html(ready(s), ready<PauseRead>({ block: 9n, timestamp: NOW, paused: true, manual: true, pausedUntil: BigInt(NOW + 600), escapeOpensAt: 0n }));
    expect(both).toContain('data-pause="manual"');
    expect(both).toContain('the governance pause stays after it ends');
    expect(both).not.toContain('from now by this device');
    const failed = html(ready(s), { data: null, state: 'failed', error: 'rpc down', refetch: () => {} });
    expect(failed).toContain('data-pause="unknown"');
    // A failed refresh with an older answer held is not shown as current.
    const held = html(ready(s), { ...pauseNone, error: 'rpc down' });
    expect(held).toContain('data-pause="unknown"');
    expect(held).toContain('the latest read failed (rpc down). The last read that answered was at block 77');
    expect(held).not.toContain('Not paused at block');
  });
  it('says it is reading before either answer', () => {
    const out = html(reading, reading);
    expect(out).toContain('Reading the protocol’s settings on Base Sepolia');
    expect(out).toContain('Reading the global pause on Base Sepolia');
  });
});
