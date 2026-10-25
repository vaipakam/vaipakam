/**
 * #2841 — the live drives read chain answers through the app's answer-shape
 * rule (`@vaipakam/lib/staticReturn`).
 *
 * viem's `readContract` and `multicall` decode a static-output answer BY
 * POSITION and ignore anything past the bytes the ABI expects. So against a
 * Diamond whose facet is not the build under review, a tuple answer of a
 * different shape decodes without an error, and every field after the
 * first one that moved comes back as its neighbour's value (#2812 moved
 * `maxOfferDurationDays` two places that way). A drive would then use the
 * neighbour in a PASS/FAIL check.
 *
 * `shapeChecked(pub, loadRule)` returns the same client with those two
 * reads replaced, plus `readRaw` for a drive that decodes the answer itself
 * (a write confirmation keeps a malformed reply apart from a failure to
 * reach anything, so it takes the bytes, #2107). All three make the rule's
 * one comparison first:
 * an answer to a getter whose outputs are all static must be exactly as
 * long as this build's ABI describes. An answer of another length is not
 * decoded. The read throws `LiveShapeMismatchError`, and the mismatch is
 * recorded here (`shapeBlock()`), because a drive's own catch may treat
 * any read failure as FAIL or carry on; the driver's exit applies the
 * record, so the run ends BLOCKED with the reason whichever path it took.
 *
 * Everything else is viem's own behaviour, kept: the same `call` action,
 * the same error wrapping (`getContractError`), an empty answer left to the
 * decoder (a revert-less empty answer is still viem's zero-data error), and
 * dynamic-output getters decoded as before, since their length is not
 * fixed and the rule does not apply to them. A parameter these versions do
 * not implement is refused rather than dropped, so a drive cannot believe
 * it read at a block tag or an account it did not.
 */
import {
  AbiDecodingZeroDataError,
  RawContractError,
  decodeFunctionResult,
  encodeFunctionData,
  multicall3Abi,
} from 'viem';
import { call } from 'viem/actions';
import { getAction, getContractError } from 'viem/utils';
import { LivePreconditionError } from './liveErrors.mjs';

/** The chain's answer is not the shape this build's ABI describes, or the
 *  rule that would say so could not be loaded: the drive cannot verify
 *  anything against that chain. BLOCKED, never FAIL. */
export class LiveShapeMismatchError extends LivePreconditionError {
  constructor(why) {
    super(why);
    this.name = 'LiveShapeMismatchError';
  }
}

// The first reason this process could not trust a chain answer. Module
// state on purpose: it outlives whatever catch the drive wrapped the read
// in, which is the point.
let BLOCK = null;

/** The first shape mismatch (or rule-load failure) this process saw, or
 *  null. The driver's exit reads it. */
export function shapeBlock() {
  return BLOCK;
}

function refuse(reason) {
  BLOCK ??= reason;
  return new LiveShapeMismatchError(reason);
}

const READ_PARAMS = new Set(['address', 'abi', 'functionName', 'args', 'blockNumber']);
const MULTICALL_PARAMS = new Set(['contracts', 'allowFailure', 'blockNumber', 'multicallAddress']);

function refuseUnsupported(what, params, supported) {
  const extra = Object.keys(params).filter((k) => params[k] !== undefined && !supported.has(k));
  if (extra.length > 0) {
    // A programming error in the drive, not a chain fact: thrown plain.
    throw new Error(`${what} (shape-checked): unsupported parameter(s) ${extra.join(', ')}`);
  }
}

/**
 * @param {import('viem').PublicClient} pub
 * @param {() => Promise<{ staticReturnBytes: Function, describeShapeMismatch: Function }>} loadRule
 *   resolves the shared rule; called on the first read, so a drive that
 *   never reads the chain never loads it.
 */
export function shapeChecked(pub, loadRule) {
  let rule;
  const theRule = async () => {
    if (rule) return rule;
    try {
      rule = await loadRule();
    } catch (err) {
      throw refuse(`cannot load the answer-shape rule (@vaipakam/lib/staticReturn): ${err?.message ?? err}`);
    }
    return rule;
  };

  /** Throws when `data` is a non-empty answer of the wrong length. */
  const checkShape = (r, { abi, functionName, args, address, blockNumber }, data) => {
    const expectedBytes = r.staticReturnBytes(abi, functionName, args);
    if (expectedBytes === null || !data || data === '0x') return;
    const gotBytes = (data.length - 2) / 2;
    if (gotBytes === expectedBytes) return;
    const at = blockNumber === undefined ? '' : ` at block ${blockNumber}`;
    throw refuse(`${r.describeShapeMismatch(functionName, { gotBytes, expectedBytes })} (${address}${at})`);
  };

  return pub.extend((client) => {
    async function readContract(params) {
      refuseUnsupported('readContract', params, READ_PARAMS);
      const r = await theRule();
      const { abi, address, args, functionName, blockNumber } = params;
      const wrap = (error) =>
        getContractError(error, { abi, address, args, docsPath: '/docs/contract/readContract', functionName });
      let data;
      try {
        ({ data } = await getAction(client, call, 'call')({
          to: address,
          data: encodeFunctionData({ abi, args, functionName }),
          blockNumber,
        }));
      } catch (error) {
        throw wrap(error);
      }
      checkShape(r, params, data);
      try {
        return decodeFunctionResult({ abi, args, functionName, data: data || '0x' });
      } catch (error) {
        throw wrap(error);
      }
    }

    // The undecoded answer, checked: the same request `readContract`
    // makes, its bytes returned as they came (`0x` for an empty one, so a
    // decoder raises viem's own zero-data error), and errors left as the
    // raw `call` raises them, as the drives' own `pub.call` did.
    async function readRaw(params) {
      refuseUnsupported('readRaw', params, READ_PARAMS);
      const r = await theRule();
      const { abi, address, args, functionName, blockNumber } = params;
      const { data } = await getAction(client, call, 'call')({
        to: address,
        data: encodeFunctionData({ abi, args, functionName }),
        blockNumber,
      });
      checkShape(r, params, data);
      return data ?? '0x';
    }

    // viem's multicall, minus what no drive uses: one aggregate3 call (no
    // chunking) to an address the drive names. Each entry is checked
    // before it is decoded; a mismatch throws for the whole call rather
    // than becoming a failed slot, which a caller could read as "unknown"
    // and still reach a verdict around.
    async function multicall(params) {
      refuseUnsupported('multicall', params, MULTICALL_PARAMS);
      const { contracts, allowFailure = true, blockNumber, multicallAddress } = params;
      if (!multicallAddress) throw new Error('multicall (shape-checked): multicallAddress is required');
      const r = await theRule();
      const wrap = (error, { abi, address, args, functionName }) =>
        getContractError(error, { abi, address, args, docsPath: '/docs/contract/multicall', functionName });
      const calls = contracts.map((c) => {
        try {
          return {
            target: c.address,
            allowFailure: true,
            callData: encodeFunctionData({ abi: c.abi, args: c.args, functionName: c.functionName }),
          };
        } catch (err) {
          if (!allowFailure) throw wrap(err, c);
          return { target: c.address, allowFailure: true, callData: '0x' };
        }
      });
      let answers;
      try {
        answers = await readContract({
          address: multicallAddress,
          abi: multicall3Abi,
          functionName: 'aggregate3',
          args: [calls],
          blockNumber,
        });
      } catch (error) {
        if (error instanceof LiveShapeMismatchError || !allowFailure) throw error;
        return contracts.map(() => ({ status: 'failure', error, result: undefined }));
      }
      // Every entry is checked before any is decoded or returned.
      answers.forEach(({ success, returnData }, i) => {
        if (success && calls[i].callData !== '0x') checkShape(r, { ...contracts[i], blockNumber }, returnData);
      });
      return answers.map(({ success, returnData }, i) => {
        const c = contracts[i];
        try {
          if (calls[i].callData === '0x') throw new AbiDecodingZeroDataError();
          if (!success) throw new RawContractError({ data: returnData });
          const result = decodeFunctionResult({ abi: c.abi, args: c.args, functionName: c.functionName, data: returnData });
          return allowFailure ? { result, status: 'success' } : result;
        } catch (err) {
          const error = wrap(err, c);
          if (!allowFailure) throw error;
          return { error, result: undefined, status: 'failure' };
        }
      });
    }

    return { readContract, readRaw, multicall };
  });
}
