import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProposeChangeModal } from '../../src/components/admin/ProposeChangeModal';
import type { KnobMeta } from '../../src/lib/protocolConsoleKnobs';

/*
 * #1520 — the modal's arg pre-fill.
 *
 * The pre-fill used to be a `useMemo` that called `setArgs` for its side
 * effect, with `args` in its own dependency list. The only thing that stopped
 * it re-running forever was the value it wrote being non-empty, so a knob whose
 * current value is the empty string looped. These tests pin the behaviour the
 * derived replacement has to keep, and the empty-string case that used to hang.
 *
 * No i18n mock — this modal renders literal English, not translation keys.
 */

const singleArgKnob: KnobMeta = {
  id: 'testSingle',
  label: 'Single-arg knob',
  short: 'A knob whose setter takes one argument.',
  category: 'fees',
  unit: 'bps',
  hardMin: '0',
  hardMax: '1000',
  safeMin: '0',
  safeMax: '500',
  midMin: '0',
  midMax: '800',
  getter: { facet: 'ConfigFacet', fn: 'getThing', returns: 'uint16' },
  setter: { facet: 'ConfigFacet', fn: 'setThing', args: [{ name: 'thing', type: 'uint16' }] },
  infoAnchor: 'thing',
  hasNumericRange: true,
};

const multiArgKnob: KnobMeta = {
  ...singleArgKnob,
  id: 'testMulti',
  label: 'Multi-arg knob',
  setter: {
    facet: 'ConfigFacet',
    fn: 'setThings',
    args: [
      { name: 'first', type: 'uint16' },
      { name: 'second', type: 'uint16' },
    ],
  },
};

const addressKnob: KnobMeta = {
  ...singleArgKnob,
  id: 'testAddress',
  label: 'Address knob',
  unit: 'address',
  hasNumericRange: false,
  setter: {
    facet: 'ConfigFacet',
    fn: 'setSomeAddress',
    args: [{ name: 'who', type: 'address' }],
  },
};

function renderModal(knob: KnobMeta, currentValue: bigint | string | boolean | null) {
  return render(
    <ProposeChangeModal
      knob={knob}
      currentValue={currentValue}
      diamondAddress="0x1111111111111111111111111111111111111111"
      chainId={84532}
      onClose={vi.fn()}
    />,
  );
}

/** The modal renders one text input per setter arg, plus the Safe-address
 *  input. Only the Safe input mentions the multisig, and an address-typed arg
 *  otherwise carries a very similar `0x…` placeholder — so exclude by that word
 *  rather than by a `0x…` prefix, which would also swallow address args. */
function argInputs(): HTMLInputElement[] {
  return screen
    .getAllByRole('textbox')
    .filter(
      (el) => !(el as HTMLInputElement).placeholder.includes('multisig'),
    ) as HTMLInputElement[];
}

describe('ProposeChangeModal — arg pre-fill', () => {
  it('pre-fills a single-arg setter with the current value', () => {
    renderModal(singleArgKnob, 250n);
    const inputs = argInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].value).toBe('250');
  });

  it('leaves a multi-arg setter empty so each arg is confirmed deliberately', () => {
    renderModal(multiArgKnob, 250n);
    const inputs = argInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.value)).toEqual(['', '']);
  });

  it('leaves the field empty when there is no current value to pre-fill from', () => {
    renderModal(singleArgKnob, null);
    expect(argInputs()[0].value).toBe('');
  });

  it('renders without hanging when the current value is the empty string', () => {
    // The regression case. Under the old side-effecting `useMemo`, writing ['']
    // failed the "has the user typed" guard, so the memo re-ran on every render
    // and never settled.
    renderModal(addressKnob, '');
    expect(argInputs()[0].value).toBe('');
  });

  it('keeps what the operator types, and does not revert to the pre-filled value', () => {
    renderModal(singleArgKnob, 250n);
    const input = argInputs()[0];
    expect(input.value).toBe('250');
    fireEvent.change(input, { target: { value: '300' } });
    expect(argInputs()[0].value).toBe('300');
  });

  it('keeps a field the operator has deliberately cleared', () => {
    // The old guard was "no arg is non-empty ⇒ nothing has been typed", so
    // clearing a pre-filled field re-filled it and the operator could not empty
    // it. Edited-ness is now tracked separately from the field contents.
    renderModal(singleArgKnob, 250n);
    fireEvent.change(argInputs()[0], { target: { value: '' } });
    expect(argInputs()[0].value).toBe('');
  });
});
