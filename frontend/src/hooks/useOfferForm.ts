import { useReducer } from 'react';
import {
  initialOfferForm,
  validateOfferForm,
  toCreateOfferPayload,
  type OfferFormState,
  type CreateOfferPayload,
  type OfferPayloadDecimals,
} from '../lib/offerSchema';

type FieldKey = keyof OfferFormState;

type Action =
  | { type: 'SET'; key: FieldKey; value: OfferFormState[FieldKey] }
  | { type: 'RESET' };

function makeReducer(base: OfferFormState) {
  return function reducer(state: OfferFormState, action: Action): OfferFormState {
    if (action.type === 'RESET') return base;
    return { ...state, [action.key]: action.value };
  };
}

/**
 * Consolidates the Create Offer page's ~14 `useState` calls behind a single
 * reducer. `setField` is type-safe — `value` must match the declared type of
 * the field being set — so pages can't accidentally stuff a string into a
 * boolean checkbox field, a class of bug the old prose useState layout
 * couldn't catch.
 *
 * @param overrides Optional partial initial state (e.g. deep-linked from a
 *   Refinance flow that needs to preserve asset continuity). Applied on mount
 *   and on RESET.
 */
export function useOfferForm(overrides?: Partial<OfferFormState>) {
  const base: OfferFormState = { ...initialOfferForm, ...(overrides ?? {}) };
  const [state, dispatch] = useReducer(makeReducer(base), base);

  const setField = <K extends FieldKey>(key: K, value: OfferFormState[K]) => {
    dispatch({ type: 'SET', key, value });
  };

  const reset = () => dispatch({ type: 'RESET' });

  const validate = (): string | null => validateOfferForm(state);

  const toPayload = (decimals: OfferPayloadDecimals = {}): CreateOfferPayload =>
    toCreateOfferPayload(state, decimals);

  return { state, setField, reset, validate, toPayload };
}
