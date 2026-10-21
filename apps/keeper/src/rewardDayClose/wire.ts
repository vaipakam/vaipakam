// apps/keeper/src/rewardDayClose/wire.ts
//
// Whether a report this mirror sends would be ACCEPTED where it lands, read
// link by link along the path it takes, on both ends, this run. A close sends
// its report once and stamps it sent here for good, its fee paid; the send
// can succeed on this chain while the receiving end refuses delivery, and a
// day Base finalizes before the wiring is fixed and the failed message is run
// again by hand counts this chain as zero. So every link is a precondition of
// the close, and an unknown one holds it like a known fault does.
//
// The path, as the contracts check it:
//   here    the Diamond's reward messenger sends to Base (`baseChainId`)
//           through its transport (`messenger`), which carries the reward
//           messenger's channel (`channelOf`) and names Base's transport
//           (`remoteMessengerOf(Base)`): the CCIP message is addressed there;
//   on Base that transport accepts this chain's messages only from this
//           chain's transport (`remoteMessengerOf(this chain)`), delivers the
//           channel to Base's reward messenger (`handlerOf`), and accepts it
//           only from this chain's reward messenger (`channelPeerOf`); and
//           Base's reward messenger takes it only from that transport
//           (`messenger`), only as the canonical instance (`isCanonical`), and
//           forwards it to the Base Diamond (`diamond`), the one Base's
//           Diamond names (its reporter config's messenger).
//
// Not read: the CCIP lane and the chain selectors, which are CCIP's, and a
// pause on either end, which fails a delivery only until it is lifted (CCIP
// records the message as failed and re-executable, and the pass's alerts say
// a day is missing before grace ends).

import { zeroAddress, type Abi, type Address } from 'viem';
import { CcipMessengerABI } from '@vaipakam/contracts/abis';
import { ABI, MESSENGER_ABI } from './constants';
import type { ChainRun, PeerReader } from './deps';
import { known, unknown, type Fact } from './fact';
import { readOne } from './reads';

const CCIP_ABI = CcipMessengerABI as Abi;
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

/**
 * The faults on the report path from this mirror to Base (empty = every link
 * reads as wired), or unknown, saying which links could not be read, when
 * none of the links read shows a fault. A known fault is stated even when
 * other links are unread: either holds the close, and the fault says what to fix.
 */
export async function reportWire(c: ChainRun, base: PeerReader | null, messenger: Address, baseChainId: number): Promise<Fact<string[]>> {
  const faults: string[] = [];
  const unread: string[] = [];
  const read = async <T>(client: PeerReader['client'], address: Address, abi: Abi, fn: string, args: readonly unknown[], what: string): Promise<T | null> => {
    const f = await readOne<T>(client, address, abi, fn, args, `${c.where}: report channel, ${what}`);
    if (f.known) return f.value;
    unread.push(`${what} could not be read (${f.why})`);
    return null;
  };
  const result = (): Fact<string[]> => (faults.length > 0 || unread.length === 0 ? known(faults) : unknown(unread.join('; ')));
  const here = c.deps.client;

  // This end.
  const route = await read<bigint>(here, messenger, MESSENGER_ABI, 'baseChainId', [], "where this chain's reward messenger sends reports (its baseChainId)");
  if (route !== null && Number(route) !== baseChainId) {
    faults.push(`this chain's reward messenger ${messenger} sends its reports to chain ${route}, but this Diamond names chain ${baseChainId} as Base (the messenger's setBaseChainId, or the Diamond's reporter config)`);
  }
  const transport = await read<Address>(here, messenger, MESSENGER_ABI, 'messenger', [], "this chain's reward messenger's transport");
  if (transport !== null && same(transport, zeroAddress)) faults.push(`this chain's reward messenger ${messenger} has no transport set`);
  if (transport === null || same(transport, zeroAddress)) return result();
  const channel = await read<`0x${string}`>(here, transport, CCIP_ABI, 'channelOf', [messenger], "the reward messenger's channel on this chain's transport");
  if (channel !== null && BigInt(channel) === 0n) faults.push(`this chain's transport ${transport} has no channel registered for the reward messenger ${messenger} (registerChannel)`);
  const remote = await read<Address>(here, transport, CCIP_ABI, 'remoteMessengerOf', [BigInt(baseChainId)], `the transport this chain's transport names on Base`);
  if (remote !== null && same(remote, zeroAddress)) faults.push(`this chain's transport ${transport} names no transport on Base (chain ${baseChainId}; setRemoteMessenger)`);

  // Base's end.
  if (base === null) {
    unread.push('the receiving end, on Base, cannot be read (this keeper does not serve that chain)');
    return result();
  }
  if (remote === null || same(remote, zeroAddress) || channel === null || BigInt(channel) === 0n) return result();
  const there = base.client;
  const cfg = await read<readonly [Address, ...unknown[]]>(there, base.diamond, ABI, 'getRewardReporterConfig', [], "Base's reward messenger (its Diamond's reporter config)");
  const peerOfSource = await read<Address>(there, remote, CCIP_ABI, 'remoteMessengerOf', [BigInt(c.chainId)], "the transport Base's transport accepts this chain's messages from");
  if (peerOfSource !== null && !same(peerOfSource, transport)) {
    faults.push(`Base's transport ${remote} accepts this chain's messages only from ${peerOfSource}, not from this chain's transport ${transport} (setRemoteMessenger on Base; delivery reverts UnauthorizedSourceMessenger)`);
  }
  const handler = await read<Address>(there, remote, CCIP_ABI, 'handlerOf', [channel], "the handler Base's transport delivers the reward channel to");
  const sender = await read<Address>(there, remote, CCIP_ABI, 'channelPeerOf', [channel, BigInt(c.chainId)], "the sender Base's transport accepts on the reward channel from this chain");
  if (sender !== null && !same(sender, messenger)) {
    faults.push(
      same(sender, zeroAddress)
        ? `Base's transport ${remote} names no sender on the reward channel for this chain (setChannelPeer on Base; delivery reverts NoChannelPeer)`
        : `Base's transport ${remote} accepts the reward channel from this chain only from ${sender}, not from this chain's reward messenger ${messenger} (setChannelPeer on Base; delivery reverts UnauthorizedChannelPeer)`,
    );
  }
  if (cfg === null) return result();
  const rewardOnBase = cfg[0];
  if (handler !== null && !same(handler, rewardOnBase)) {
    faults.push(
      same(handler, zeroAddress)
        ? `Base's transport ${remote} has no handler for the reward channel (registerChannel on Base; delivery reverts UnknownChannel)`
        : `Base's transport ${remote} delivers the reward channel to ${handler}, not to Base's reward messenger ${rewardOnBase} (registerChannel on Base)`,
    );
  }
  if (same(rewardOnBase, zeroAddress)) {
    faults.push("Base's Diamond names no reward messenger");
    return result();
  }
  const itsTransport = await read<Address>(there, rewardOnBase, MESSENGER_ABI, 'messenger', [], "Base's reward messenger's transport");
  if (itsTransport !== null && !same(itsTransport, remote)) {
    faults.push(`Base's reward messenger ${rewardOnBase} takes messages only from transport ${itsTransport}, not from ${remote}, the one this chain's transport sends to (delivery reverts NotMessenger)`);
  }
  const canonical = await read<boolean>(there, rewardOnBase, MESSENGER_ABI, 'isCanonical', [], "whether Base's reward messenger is the canonical instance");
  if (canonical === false) faults.push(`Base's reward messenger ${rewardOnBase} is not set as the canonical instance, so it refuses every report (ReportOnMirror)`);
  const forwards = await read<Address>(there, rewardOnBase, MESSENGER_ABI, 'diamond', [], "the Diamond Base's reward messenger forwards reports to");
  if (forwards !== null && !same(forwards, base.diamond)) {
    faults.push(`Base's reward messenger ${rewardOnBase} forwards reports to ${forwards}, not to Base's Diamond ${base.diamond}`);
  }
  return result();
}
