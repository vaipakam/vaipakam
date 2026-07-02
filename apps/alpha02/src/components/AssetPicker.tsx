/**
 * Token selector: curated per-chain suggestions with live on-chain
 * symbols, plus a paste-an-address escape hatch. The curated-first
 * shape exists because making naive users find contract addresses
 * was a top finding of the 2026-07-02 browser audit (F-20260702-002).
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { erc20Abi } from 'viem';
import { usePublicClient } from 'wagmi';
import { getCanonicalAssetsForChain } from '@vaipakam/lib';
import { useActiveChain } from '../chain/useActiveChain';
import { shortAddress } from '../lib/format';
import { isAddressLike } from '../contracts/erc20';

interface CuratedToken {
  address: `0x${string}`;
  symbol: string;
}

/** Curated tokens for the read chain, symbols resolved live. Tokens
 *  whose reads fail (not deployed / not ERC-20) are dropped. */
function useCuratedTokens(): CuratedToken[] {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['curatedTokens', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: Infinity,
    queryFn: async (): Promise<CuratedToken[]> => {
      const addresses = getCanonicalAssetsForChain(readChain.chainId);
      const rows = await Promise.all(
        addresses.map(async (address) => {
          try {
            const symbol = await publicClient!.readContract({
              address: address as `0x${string}`,
              abi: erc20Abi,
              functionName: 'symbol',
            });
            return { address: address as `0x${string}`, symbol };
          } catch {
            return null;
          }
        }),
      );
      return rows.filter((r): r is CuratedToken => r !== null);
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
  const curated = useCuratedTokens();
  // Case-insensitive match, but the <select> needs the option's EXACT
  // casing — a lowercased address set programmatically (deep links)
  // must still light up the right curated option.
  const curatedMatch = useMemo(
    () => curated.find((t) => t.address.toLowerCase() === value.toLowerCase()),
    [curated, value],
  );
  const [customOpen, setCustomOpen] = useState(false);
  const showCustom = customOpen || (value !== '' && curatedMatch === undefined);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="input"
        value={showCustom ? CUSTOM : (curatedMatch?.address ?? value)}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustomOpen(true);
            onChange('');
          } else {
            setCustomOpen(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">Choose an asset…</option>
        {curated.map((t) => (
          <option key={t.address} value={t.address}>
            {t.symbol} ({shortAddress(t.address)})
          </option>
        ))}
        <option value={CUSTOM}>Paste a token address…</option>
      </select>
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
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
