/**
 * Token selector: curated per-chain suggestions with live on-chain
 * symbols, plus a paste-an-address escape hatch. The curated-first
 * shape exists because making naive users find contract addresses
 * was a top finding of the 2026-07-02 browser audit (F-20260702-002).
 *
 * On TEST networks the list additionally offers the faucet's mock
 * ERC-20s (user directive 2026-07-06): the faucet page mints tLIQ /
 * mUSDC / mWETH / tILQ / tILQ2 precisely so people can try lending and
 * borrowing, but the pickers then made them paste those addresses
 * back by hand. Faucet rows are badged so it stays obvious they are
 * test tokens; addresses come from the same deployments bundle the
 * faucet page reads, symbols resolved live like the curated set.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { erc20Abi } from 'viem';
import { usePublicClient } from 'wagmi';
import { getCanonicalAssetsForChain } from '@vaipakam/lib';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { useTokenSecurity } from '../data/tokenSecurity';
import { reputationNotice, useTokenReputation } from '../data/tokenReputation';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { shortAddress } from '../lib/format';
import { isAddressLike } from '../contracts/erc20';
import { SelectMenu, type SelectMenuOption } from './SelectMenu';

interface PickerToken {
  address: `0x${string}`;
  symbol: string;
  faucet: boolean;
}

/** The testnetMocks keys that are mintable faucet ERC-20s — the same
 *  five the /faucet page offers. Feeds, pools, NFTs, and swap infra
 *  stay out of a TOKEN picker. */
const FAUCET_ERC20_KEYS = [
  'liquidToken',
  'liquidToken2',
  'mWeth',
  'illiquidToken',
  'illiquidToken2',
] as const;

/** Suggested tokens for the read chain: curated canonical assets
 *  first, then (testnets only) the faucet mocks. Symbols resolved
 *  live; tokens whose reads fail (not deployed / not ERC-20) are
 *  dropped; a faucet token that is ALSO curated dedupes to the
 *  curated row. */
function usePickerTokens(): PickerToken[] {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['curatedTokens', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: Infinity,
    queryFn: async (): Promise<PickerToken[]> => {
      const curated = getCanonicalAssetsForChain(readChain.chainId).map(
        (address) => ({ address, faucet: false }),
      );
      const mocks = readChain.testnet
        ? getDeployment(readChain.chainId)?.testnetMocks
        : undefined;
      const seen = new Set(curated.map((c) => c.address.toLowerCase()));
      const faucet = FAUCET_ERC20_KEYS.flatMap((key) => {
        const address = (mocks as Record<string, string> | undefined)?.[key];
        return address && !seen.has(address.toLowerCase())
          ? [{ address, faucet: true }]
          : [];
      });
      const rows = await Promise.all(
        [...curated, ...faucet].map(async ({ address, faucet: isFaucet }) => {
          try {
            const symbol = await publicClient!.readContract({
              address: address as `0x${string}`,
              abi: erc20Abi,
              functionName: 'symbol',
            });
            return {
              address: address as `0x${string}`,
              symbol,
              faucet: isFaucet,
            };
          } catch {
            return null;
          }
        }),
      );
      return rows.filter((r): r is PickerToken => r !== null);
    },
  });

  return data ?? [];
}

const CUSTOM = '__custom__';

export function AssetPicker({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  /** Current token address ('' = none picked). */
  value: string;
  onChange: (address: string) => void;
}) {
  const tokens = usePickerTokens();
  const { readChain } = useActiveChain();
  // Case-insensitive match, but the menu needs the option's EXACT
  // casing — a lowercased address set programmatically (deep links)
  // must still light up the right suggested option.
  const curatedMatch = useMemo(
    () => tokens.find((t) => t.address.toLowerCase() === value.toLowerCase()),
    [tokens, value],
  );
  const [customOpen, setCustomOpen] = useState(false);
  const showCustom = customOpen || (value !== '' && curatedMatch === undefined);
  // #1036 — screen NON-curated pasted addresses through GoPlus. The
  // picker WARNS at entry; the flows' gates enforce blocking, because
  // a malicious offer can also arrive from the contract path where no
  // picker was ever involved.
  const security = useTokenSecurity(
    readChain.chainId,
    showCustom && isAddressLike(value) ? value : undefined,
  );
  // #1036 fallback layer — the market-listing SOFT signal beside the
  // security verdict. Complementary, not redundant: GoPlus says
  // "booby-trapped or not", CoinGecko says "does the market know this
  // token at all", and a positive match doubles as identity
  // confirmation against paste mistakes. Renders nothing on chains
  // without market data (testnets) and nothing on a failed lookup.
  const reputation = useTokenReputation(
    readChain.chainId,
    showCustom && isAddressLike(value) ? value : undefined,
  );
  const reputationLine = reputationNotice(reputation.data);

  const menuOptions = useMemo<SelectMenuOption[]>(
    () => [
      ...tokens.map((t) => ({
        value: t.address as string,
        label: t.symbol,
        sub: shortAddress(t.address),
        controlLabel: `${t.symbol} (${shortAddress(t.address)})`,
        ...(t.faucet
          ? { badge: { text: copy.assetPicker.faucetBadge, tone: 'info' as const } }
          : {}),
      })),
      { value: CUSTOM, label: copy.assetPicker.pasteOption },
    ],
    [tokens],
  );

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <SelectMenu
        id={id}
        placeholder={copy.assetPicker.placeholder}
        options={menuOptions}
        value={showCustom ? CUSTOM : (curatedMatch?.address ?? value)}
        onChange={(next) => {
          if (next === CUSTOM) {
            setCustomOpen(true);
            onChange('');
          } else {
            setCustomOpen(false);
            onChange(next);
          }
        }}
      />
      {showCustom ? (
        <input
          aria-label={`${label} contract address`}
          className={`input ${value !== '' && !isAddressLike(value) ? 'input-invalid' : ''}`}
          placeholder="0x…"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          spellCheck={false}
          autoComplete="off"
        />
      ) : null}
      {/* UX-017 — a bad/half-typed paste got only a red border and
          silence; say WHAT's expected instead of signalling by colour
          alone. */}
      {showCustom && value !== '' && !isAddressLike(value) ? (
        <span className="field-hint" style={{ color: 'var(--danger)' }}>
          {copy.assetPicker.invalidAddress}
        </span>
      ) : null}
      {showCustom && isAddressLike(value) && security.data ? (
        security.data.kind === 'block' ? (
          <span className="field-hint" style={{ color: 'var(--danger)' }}>
            {copy.tokenSecurity.pickerBlock(security.data.reasons)}
          </span>
        ) : security.data.kind === 'warn' ? (
          <span className="field-hint" style={{ color: 'var(--danger)' }}>
            {copy.tokenSecurity.pickerWarn(security.data.reasons)}
          </span>
        ) : security.data.kind === 'unsupported' ? (
          <span className="field-hint">{copy.tokenSecurity.pickerUnsupported}</span>
        ) : null
      ) : showCustom && isAddressLike(value) && security.isError ? (
        <span className="field-hint">{copy.tokenSecurity.pickerUnknown}</span>
      ) : null}
      {showCustom && isAddressLike(value) && reputationLine !== null ? (
        <span className="field-hint">{reputationLine}</span>
      ) : null}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
