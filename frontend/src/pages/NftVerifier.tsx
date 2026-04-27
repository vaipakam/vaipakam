import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  createPublicClient,
  http,
  getAddress,
  isAddress,
  type Address,
  type PublicClient,
} from "viem";
import { DIAMOND_ABI_VIEM } from "../contracts/abis";
import {
  CHAIN_REGISTRY,
  type DeployedChain,
} from "../contracts/config";
import {
  decodeContractError,
  extractRevertSelector,
} from "../lib/decodeContractError";
import { beginStep } from "../lib/journeyLog";
import { loadLoanIndex } from "../lib/logIndex";
import type { NFTMetadata } from "../types/nft";
import type { LoanDetails } from "../types/loan";
import { LoanStatus, LOAN_STATUS_LABELS } from "../types/loan";
import {
  Search,
  ExternalLink,
  AlertTriangle,
  CheckCircle,
  Flame,
  ShieldCheck,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { AssetSymbol } from "../components/app/AssetSymbol";
import { TokenAmount } from "../components/app/TokenAmount";
import { CardInfo } from "../components/CardInfo";
import { bpsToPercent } from "../lib/format";
import "./NftVerifier.css";

// OZ v5 ERC721 uses this selector for "token doesn't exist" — raised by
// both `ownerOf` and `tokenURI` after a burn or for never-minted ids.
const ERC721_NONEXISTENT_SELECTOR = "0x7e273289";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type Verdict =
  | { kind: "idle" }
  | { kind: "verifying" }
  | { kind: "invalid-input"; message: string }
  | { kind: "not-vaipakam"; address: string }
  | {
      kind: "live";
      chain: DeployedChain;
      tokenId: string;
      owner: string;
      metadata: NFTMetadata | null;
      role: "lender" | "borrower" | null;
      loanDetails: LoanDetails | null;
      hf: bigint | null;
      ltv: bigint | null;
    }
  | {
      kind: "burned";
      chain: DeployedChain;
      tokenId: string;
      role: "lender" | "borrower" | null;
      loanDetails: LoanDetails | null;
      lastOwner: string | null;
      offerContext: {
        offerId: string;
        creator: string;
        status: "accepted" | "canceled" | "open";
      } | null;
    }
  | { kind: "never-minted"; chain: DeployedChain; tokenId: string }
  | { kind: "error"; message: string };

// Deployed chains, sorted mainnet-first then alphabetical — used in the
// "supported chains" helper text under the address input so a user pasting
// in an unknown address can see which networks the Verifier recognises.
function deployedChains(): DeployedChain[] {
  return Object.values(CHAIN_REGISTRY)
    .filter((c): c is DeployedChain => c.diamondAddress !== null)
    .sort(
      (a, b) =>
        Number(a.testnet) - Number(b.testnet) || a.name.localeCompare(b.name),
    );
}

// Match a user-pasted contract address against every deployed Diamond. We
// normalise both sides with `getAddress` so case differences don't sink a
// legitimate match.
function findChainByDiamond(addr: string): DeployedChain | null {
  let canonical: string;
  try {
    canonical = getAddress(addr.trim());
  } catch {
    return null;
  }
  for (const c of Object.values(CHAIN_REGISTRY)) {
    if (c.diamondAddress && getAddress(c.diamondAddress) === canonical) {
      return c as DeployedChain;
    }
  }
  return null;
}

type DiamondHandles = {
  publicClient: PublicClient;
  address: Address;
};

function makeDiamondFor(chain: DeployedChain): DiamondHandles {
  const publicClient = createPublicClient({ transport: http(chain.rpcUrl) });
  return {
    publicClient: publicClient as PublicClient,
    address: chain.diamondAddress as Address,
  };
}

/**
 * Vaipakam NFTs encode metadata either as a base64 JSON data-URI (new mints)
 * or as raw JSON (older facet versions). Anything else — IPFS, HTTP, empty —
 * returns null so the caller can show the "no metadata" state.
 */
function parseTokenURI(uri: string): NFTMetadata | null {
  if (uri.startsWith("data:application/json;base64,")) {
    return JSON.parse(atob(uri.split(",")[1])) as NFTMetadata;
  }
  if (uri.startsWith("{")) {
    return JSON.parse(uri) as NFTMetadata;
  }
  return null;
}

// The Diamond's `tokenURI` bakes the position's Loan ID and Role directly
// into the attribute array (see `VaipakamNFTFacet._buildAttributes`), so the
// page can resolve a tokenId → loanId without a reverse-lookup call.
function readAttr(meta: NFTMetadata | null, trait: string): string | null {
  if (!meta?.attributes) return null;
  for (const a of meta.attributes) {
    if (a?.trait_type === trait && a.value != null) return String(a.value);
  }
  return null;
}

function extractLoanId(meta: NFTMetadata | null): bigint | null {
  const raw = readAttr(meta, "Loan ID");
  if (!raw) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function extractRole(meta: NFTMetadata | null): "lender" | "borrower" | null {
  const raw = readAttr(meta, "Role")?.toLowerCase();
  if (raw === "lender") return "lender";
  if (raw === "borrower") return "borrower";
  return null;
}

// Normalises the `getLoanDetails` response. Ethers returns both struct-like
// objects (with named props) AND an Array, depending on ABI source — this
// lets us trust the named fields we consume below.
function normaliseLoan(raw: unknown): LoanDetails {
  return raw as LoanDetails;
}

export default function NftVerifier() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [addressInput, setAddressInput] = useState(
    () => searchParams.get("contract") ?? "",
  );
  const [tokenIdInput, setTokenIdInput] = useState(
    () => searchParams.get("id") ?? "",
  );
  const [verdict, setVerdict] = useState<Verdict>({ kind: "idle" });
  const chains = useMemo(() => deployedChains(), []);

  const runVerify = useCallback(async (addr: string, tokenIdStr: string) => {
    const trimmedAddr = addr.trim();
    const trimmedId = tokenIdStr.trim();
    if (!trimmedAddr || !trimmedId) {
      setVerdict({
        kind: "invalid-input",
        message: "Enter both a contract address and a token ID to verify.",
      });
      return;
    }
    if (!isAddress(trimmedAddr)) {
      setVerdict({
        kind: "invalid-input",
        message: "The contract address is not a valid Ethereum address.",
      });
      return;
    }
    let tokenIdBig: bigint;
    try {
      tokenIdBig = BigInt(trimmedId);
      if (tokenIdBig <= 0n) throw new Error("not positive");
    } catch {
      setVerdict({
        kind: "invalid-input",
        message: "The token ID must be a positive integer.",
      });
      return;
    }

    const chain = findChainByDiamond(trimmedAddr);
    if (!chain) {
      setVerdict({ kind: "not-vaipakam", address: trimmedAddr });
      return;
    }

    setVerdict({ kind: "verifying" });
    const step = beginStep({
      area: "nft-verifier",
      flow: "verify",
      step: "ownerOf+tokenURI",
      nftId: trimmedId,
      chainId: chain.chainId,
    });

    const diamond = makeDiamondFor(chain);
    const { publicClient, address } = diamond;
    try {
      const owner = (await publicClient.readContract({
        address,
        abi: DIAMOND_ABI_VIEM,
        functionName: "ownerOf",
        args: [tokenIdBig],
      })) as string;
      if (owner === ZERO_ADDRESS) {
        // Defensive: `ownerOf` on OZ v5 reverts for burned tokens, but if a
        // future facet returns 0x0 instead we still want to render the
        // burned-NFT branch.
        throw { code: "CALL_EXCEPTION", data: ERC721_NONEXISTENT_SELECTOR };
      }

      let metadata: NFTMetadata | null = null;
      try {
        const uri = (await publicClient.readContract({
          address,
          abi: DIAMOND_ABI_VIEM,
          functionName: "tokenURI",
          args: [tokenIdBig],
        })) as string;
        metadata = parseTokenURI(uri);
      } catch {
        // Older facet versions may revert on tokenURI; owner is still the
        // authoritative proof of authenticity.
      }

      const role = extractRole(metadata);
      const loanId = extractLoanId(metadata);

      let loanDetails: LoanDetails | null = null;
      let hf: bigint | null = null;
      let ltv: bigint | null = null;
      if (loanId != null) {
        try {
          loanDetails = normaliseLoan(
            await publicClient.readContract({
              address,
              abi: DIAMOND_ABI_VIEM,
              functionName: "getLoanDetails",
              args: [loanId],
            }),
          );
        } catch {
          // Non-fatal: metadata referenced a loanId the contract no longer
          // exposes (shouldn't happen on a live NFT, but don't wreck the
          // verification over it).
        }
        if (loanDetails && Number(loanDetails.status) === LoanStatus.Active) {
          try {
            const [hfRaw, ltvRaw] = await Promise.all([
              publicClient.readContract({
                address,
                abi: DIAMOND_ABI_VIEM,
                functionName: "calculateHealthFactor",
                args: [loanId],
              }) as Promise<bigint>,
              publicClient.readContract({
                address,
                abi: DIAMOND_ABI_VIEM,
                functionName: "calculateLTV",
                args: [loanId],
              }) as Promise<bigint>,
            ]);
            hf = hfRaw;
            ltv = ltvRaw;
          } catch {
            // Illiquid loans can't compute HF/LTV — leave null, renderer
            // just hides those rows.
          }
        }
      }

      setVerdict({
        kind: "live",
        chain,
        tokenId: trimmedId,
        owner,
        metadata,
        role,
        loanDetails,
        hf,
        ltv,
      });
      step.success();
    } catch (err) {
      if (extractRevertSelector(err) === ERC721_NONEXISTENT_SELECTOR) {
        // Burned vs never-minted: load the per-chain log index (cached in
        // localStorage by chainId+diamond, so repeat lookups on the same
        // chain are instant) and consult the Transfer cache.
        try {
          const idx = await loadLoanIndex(
            chain.rpcUrl,
            chain.diamondAddress,
            chain.deployBlock,
            chain.chainId,
          );
          const lastOwner = idx.getLastOwner(tokenIdBig);
          if (lastOwner === ZERO_ADDRESS) {
            const hit = idx.getLoanInitiatedForToken(tokenIdBig);
            let loanDetails: LoanDetails | null = null;
            if (hit) {
              try {
                loanDetails = normaliseLoan(
                  await publicClient.readContract({
                    address,
                    abi: DIAMOND_ABI_VIEM,
                    functionName: "getLoanDetails",
                    args: [BigInt(hit.loanId)],
                  }),
                );
              } catch {
                // Contract cleared the mapping on burn — fallback to the
                // event args we already attributed.
              }
            }
            // Fallback for creator-side NFTs whose offer was canceled before
            // any loan initiated — no `LoanInitiated` attribution exists, but
            // the `OfferCreated` mint can still explain the burn.
            const offerCtx = hit ? null : idx.getOfferForToken(tokenIdBig);
            const lastOwner = idx.getPreviousOwner(tokenIdBig);
            setVerdict({
              kind: "burned",
              chain,
              tokenId: trimmedId,
              role: hit?.role ?? null,
              loanDetails,
              lastOwner,
              offerContext: offerCtx
                ? {
                    offerId: offerCtx.offerId,
                    creator: offerCtx.creator,
                    status: offerCtx.status,
                  }
                : null,
            });
            step.success({ note: "burned NFT shown as warning" });
            return;
          }
        } catch {
          // Log-index scan failed (rate-limited, etc). Fall through to the
          // never-minted path — better than a hard error.
        }
        setVerdict({ kind: "never-minted", chain, tokenId: trimmedId });
        step.failure(err);
        return;
      }
      setVerdict({
        kind: "error",
        message: decodeContractError(
          err,
          "Verification failed. The RPC may be rate-limited — try again.",
        ),
      });
      step.failure(err);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Keep the URL in sync so the verification is shareable / refreshable.
    const next: Record<string, string> = {};
    if (addressInput.trim()) next.contract = addressInput.trim();
    if (tokenIdInput.trim()) next.id = tokenIdInput.trim();
    setSearchParams(next, { replace: true });
    runVerify(addressInput, tokenIdInput);
  };

  // Auto-verify on load if both `?contract=` and `?id=` are present.
  useEffect(() => {
    const c = searchParams.get("contract");
    const i = searchParams.get("id");
    if (c && i && verdict.kind === "idle") {
      setAddressInput(c);
      setTokenIdInput(i);
      runVerify(c, i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="nft-verifier">
      <div className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {t('nav.nftVerifier')}
          <CardInfo id="nft-verifier.lookup" />
        </h1>
        <p className="page-subtitle">{t('nftVerifier.pageSubtitle')}</p>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <form onSubmit={handleSubmit} className="verifier-form-stacked">
          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="form-label">{t('nftVerifier.contractAddressLabel')}</label>
            <input
              className="form-input"
              type="text"
              placeholder="0x…"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              required
            />
            <div className="form-hint">{t('nftVerifier.contractAddressHint')}</div>
          </div>
          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="form-label">{t('nftVerifier.tokenIdLabel')}</label>
            <input
              className="form-input"
              type="number"
              min="1"
              placeholder="e.g. 9"
              value={tokenIdInput}
              onChange={(e) => setTokenIdInput(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={verdict.kind === "verifying"}
          >
            <Search size={16} />
            {verdict.kind === "verifying" ? t('nftVerifier.verifying') : t('nftVerifier.verifyButton')}
          </button>
        </form>

        <div className="verifier-supported-chains">
          <span className="data-label">{t('nftVerifier.recognisedOn')}</span>
          {chains.map((c) => (
            <span key={c.chainId} className="verifier-chain-pill">
              {c.name}
            </span>
          ))}
        </div>
      </div>

      {verdict.kind === "invalid-input" && (
        <ErrorAlert message={verdict.message} />
      )}

      {verdict.kind === "error" && <ErrorAlert message={verdict.message} />}

      {verdict.kind === "not-vaipakam" && (
        <NotVaipakamCard address={verdict.address} />
      )}

      {verdict.kind === "never-minted" && (
        <NeverMintedCard chain={verdict.chain} tokenId={verdict.tokenId} />
      )}

      {verdict.kind === "burned" && <BurnedCard verdict={verdict} />}

      {verdict.kind === "live" && <LiveCard verdict={verdict} />}
    </div>
  );
}

function NotVaipakamCard({ address }: { address: string }) {
  return (
    <div className="card verifier-result verifier-not-vaipakam">
      <div className="verifier-verdict-row">
        <XCircle size={22} style={{ color: "var(--accent-red)" }} />
        <span className="verifier-verdict-title verifier-verdict-title--bad">
          Not a Vaipakam NFT
        </span>
      </div>
      <p className="page-subtitle" style={{ marginTop: 12 }}>
        The contract address <span className="mono">{address}</span> does not
        match any Vaipakam deployment on any supported chain. This is either a
        different NFT collection or an impersonation of a Vaipakam position.
      </p>
      <div className="verifier-advisory verifier-advisory--bad">
        <AlertTriangle size={16} />
        <span>
          Do not purchase. Only Vaipakam-issued position NFTs carry claim rights
          over the underlying loan &mdash; any other contract offering a
          "Vaipakam position" is not recognised by the protocol and cannot be
          used to claim funds or collateral.
        </span>
      </div>
    </div>
  );
}

function NeverMintedCard({
  chain,
  tokenId,
}: {
  chain: DeployedChain;
  tokenId: string;
}) {
  return (
    <div className="card verifier-result verifier-burned">
      <div className="verifier-verdict-row">
        <AlertTriangle size={22} style={{ color: "var(--accent-orange)" }} />
        <span className="verifier-verdict-title verifier-verdict-title--warn">
          Token ID not available
        </span>
      </div>
      <p className="page-subtitle" style={{ marginTop: 12 }}>
        The contract is a genuine Vaipakam deployment on{" "}
        <span className="verifier-chain-highlight">{chain.name}</span>, but
        token <span className="mono">#{tokenId}</span> has not been minted on
        this chain. The seller may have typed the wrong token ID, or the
        listing may be referring to a token on a different Vaipakam
        deployment.
      </p>
      <div className="verifier-advisory verifier-advisory--warn">
        <AlertTriangle size={16} />
        <span>
          Hold off on the purchase. Double-check the token ID with the seller,
          or ask them to confirm which chain the NFT was minted on, then
          re-run the verifier on that chain.
        </span>
      </div>
    </div>
  );
}

function BurnedCard({
  verdict,
}: {
  verdict: Extract<Verdict, { kind: "burned" }>;
}) {
  const { t } = useTranslation();
  const { chain, tokenId, role, loanDetails, offerContext, lastOwner } =
    verdict;
  const offerStatusLabel =
    offerContext?.status === "canceled"
      ? "canceled by the creator before any borrower / lender accepted it"
      : offerContext?.status === "accepted"
        ? "accepted and has since migrated to a replacement NFT"
        : "still open at the time of the burn";
  return (
    <div className="card verifier-result verifier-burned">
      <div className="verifier-verdict-row">
        <Flame size={22} style={{ color: "var(--accent-orange)" }} />
        <span className="verifier-verdict-title verifier-verdict-title--warn">
          Genuine Vaipakam NFT &mdash; but burned
        </span>
      </div>
      <p className="page-subtitle" style={{ marginTop: 12 }}>
        Token <span className="mono">#{tokenId}</span> was a Vaipakam position
        NFT on <span className="verifier-chain-highlight">{chain.name}</span>,
        but has since been burned. This happens when a loan reaches a terminal
        state (Repaid, Settled, Defaulted, Preclosed, or Early-Withdrawn)
        &mdash; the position NFT is destroyed and the token ID can never be
        reused or transferred.
      </p>
      {lastOwner && (
        <div className="verifier-details-col" style={{ marginTop: 12 }}>
          <div className="data-row">
            <span className="data-label">{t('nftVerifier.lastOwnerBeforeBurn')}</span>
            <a
              href={`${chain.blockExplorer}/address/${lastOwner}`}
              target="_blank"
              rel="noreferrer"
              className="data-value mono"
              style={{ color: "var(--brand)", fontSize: "0.82rem" }}
            >
              {lastOwner} <ExternalLink size={12} />
            </a>
          </div>
        </div>
      )}
      {loanDetails ? (
        <div className="verifier-details-col" style={{ marginTop: 12 }}>
          <div className="data-row">
            <span className="data-label">{t('nftVerifier.loanLabel')}</span>
            <span className="data-value mono">
              #{loanDetails.id.toString()}
            </span>
          </div>
          {role && (
            <div className="data-row">
              <span className="data-label">{t('common.role')}</span>
              <span className="data-value">
                {role === "lender" ? t('nftVerifier.lenderPosition') : t('nftVerifier.borrowerPosition')}
              </span>
            </div>
          )}
          <div className="data-row">
            <span className="data-label">{t('common.status')}</span>
            <span className="data-value">
              {LOAN_STATUS_LABELS[Number(loanDetails.status) as LoanStatus] ??
                t('nftVerifier.unknown')}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('nftVerifier.principal')}</span>
            <span className="data-value">
              <TokenAmount
                amount={loanDetails.principal}
                address={loanDetails.principalAsset}
              />{" "}
              <AssetSymbol address={loanDetails.principalAsset} />
            </span>
          </div>
          {loanDetails.collateralAsset &&
            loanDetails.collateralAsset !== ZERO_ADDRESS && (
              <div className="data-row">
                <span className="data-label">{t('nftVerifier.collateral')}</span>
                <span className="data-value">
                  <TokenAmount
                    amount={loanDetails.collateralAmount}
                    address={loanDetails.collateralAsset}
                  />{" "}
                  <AssetSymbol address={loanDetails.collateralAsset} />
                </span>
              </div>
            )}
          <div className="data-row">
            <span className="data-label">{t('common.interestRate')}</span>
            <span className="data-value">
              {bpsToPercent(loanDetails.interestRateBps)}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('nftVerifier.duration')}</span>
            <span className="data-value">
              {loanDetails.durationDays.toString()} {t('nftVerifier.daysSuffix')}
            </span>
          </div>
        </div>
      ) : offerContext ? (
        <div className="verifier-details-col" style={{ marginTop: 12 }}>
          <div className="data-row">
            <span className="data-label">{t('nftVerifier.origin')}</span>
            <span className="data-value">Offer #{offerContext.offerId}</span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('nftVerifier.offerStatus')}</span>
            <span className="data-value">
              {offerContext.status === "canceled"
                ? t('nftVerifier.offerCanceled')
                : offerContext.status === "accepted"
                  ? t('nftVerifier.offerAccepted')
                  : t('nftVerifier.offerOpen')}
            </span>
          </div>
          <p className="page-subtitle" style={{ marginTop: 12 }}>
            This NFT was minted when the creator posted the offer and was burned
            when the offer was {offerStatusLabel}. No loan was ever initiated
            through this specific tokenId, so there is no loan-side history to
            show.
          </p>
        </div>
      ) : (
        <p className="page-subtitle">
          Historical loan context isn't available in the local event index (the
          mint may predate the scan range).
        </p>
      )}
      <div
        className="verifier-advisory verifier-advisory--bad"
        style={{ marginTop: 12 }}
      >
        <AlertTriangle size={16} />
        <span>
          Do not purchase. A burned NFT has no claim rights and cannot be
          transferred.
        </span>
      </div>
    </div>
  );
}

function LiveCard({
  verdict,
}: {
  verdict: Extract<Verdict, { kind: "live" }>;
}) {
  const { t } = useTranslation();
  const { chain, tokenId, owner, metadata, role, loanDetails, hf, ltv } =
    verdict;
  const blockExplorer = chain.blockExplorer;
  const status =
    loanDetails != null ? (Number(loanDetails.status) as LoanStatus) : null;

  return (
    <div className="card verifier-result verifier-live">
      <div className="verifier-verdict-row">
        <CheckCircle size={22} style={{ color: "var(--accent-green)" }} />
        <span className="verifier-verdict-title verifier-verdict-title--good">
          Genuine Vaipakam NFT on{" "}
          <span className="verifier-chain-highlight">{chain.name}</span>
        </span>
      </div>

      <div className="verifier-layout" style={{ marginTop: 16 }}>
        {metadata?.image && (
          <div className="verifier-image-col">
            <img src={metadata.image} alt="NFT" className="nft-image" />
          </div>
        )}

        <div className="verifier-details-col">
          <div className="data-row">
            <span className="data-label">{t('nftVerifier.tokenIdLabelShort')}</span>
            <span className="data-value mono">#{tokenId}</span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('common.network')}</span>
            <span className="data-value">{chain.name}</span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('nftVerifier.currentOwner')}</span>
            <a
              href={`${blockExplorer}/address/${owner}`}
              target="_blank"
              rel="noreferrer"
              className="data-value mono"
              style={{ color: "var(--brand)", fontSize: "0.82rem" }}
            >
              {owner} <ExternalLink size={12} />
            </a>
          </div>
          {role && (
            <div className="data-row">
              <span className="data-label">{t('common.role')}</span>
              <span className="data-value">
                {role === "lender" ? t('nftVerifier.lenderPosition') : t('nftVerifier.borrowerPosition')}
              </span>
            </div>
          )}
          {loanDetails && (
            <>
              <div className="data-row">
                <span className="data-label">{t('nftVerifier.loanLabel')}</span>
                <span className="data-value mono">
                  #{loanDetails.id.toString()}
                </span>
              </div>
              <div className="data-row">
                <span className="data-label">{t('common.status')}</span>
                <span className="data-value">
                  {LOAN_STATUS_LABELS[status ?? LoanStatus.Active] ?? t('nftVerifier.unknown')}
                </span>
              </div>
              <div className="data-row">
                <span className="data-label">{t('nftVerifier.principal')}</span>
                <span className="data-value">
                  <TokenAmount
                    amount={loanDetails.principal}
                    address={loanDetails.principalAsset}
                  />{" "}
                  <AssetSymbol address={loanDetails.principalAsset} />
                </span>
              </div>
              {loanDetails.collateralAsset &&
                loanDetails.collateralAsset !== ZERO_ADDRESS && (
                  <div className="data-row">
                    <span className="data-label">{t('nftVerifier.collateral')}</span>
                    <span className="data-value">
                      <TokenAmount
                        amount={loanDetails.collateralAmount}
                        address={loanDetails.collateralAsset}
                      />{" "}
                      <AssetSymbol address={loanDetails.collateralAsset} />
                    </span>
                  </div>
                )}
              <div className="data-row">
                <span className="data-label">{t('common.interestRate')}</span>
                <span className="data-value">
                  {bpsToPercent(loanDetails.interestRateBps)}
                </span>
              </div>
              <div className="data-row">
                <span className="data-label">{t('nftVerifier.duration')}</span>
                <span className="data-value">
                  {loanDetails.durationDays.toString()} {t('nftVerifier.daysSuffix')}
                </span>
              </div>
              {hf != null && (
                <div className="data-row">
                  <span className="data-label">{t('nftVerifier.healthFactor')}</span>
                  <span className="data-value mono">{formatScaled18(hf)}</span>
                </div>
              )}
              {ltv != null && (
                <div className="data-row">
                  <span className="data-label">{t('nftVerifier.ltv')}</span>
                  <span className="data-value">{bpsToPercent(ltv)}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <BuyerAdvisory
        status={status}
        role={role}
        hf={hf}
        loanDetails={loanDetails}
      />
    </div>
  );
}

/**
 * Plain-language guidance for a prospective secondary-market buyer. The block
 * shifts between three tones — good (safe to evaluate), warn (position is
 * active but under pressure), bad (position is closed / liquidatable) — so
 * the user can size up risk before committing USDC to a marketplace bid.
 */
function BuyerAdvisory({
  status,
  role,
  hf,
  loanDetails,
}: {
  status: LoanStatus | null;
  role: "lender" | "borrower" | null;
  hf: bigint | null;
  loanDetails: LoanDetails | null;
}) {
  if (status == null || loanDetails == null) {
    return null;
  }
  // Closed statuses — any claim rights have already been exercised or will
  // be via the Claim Center. Buying makes no economic sense unless the NFT
  // still carries unclaimed funds (and the Claim Center is the right UI for
  // that, not a marketplace).
  if (status === LoanStatus.Repaid || status === LoanStatus.Settled) {
    return (
      <div className="verifier-advisory verifier-advisory--bad">
        <AlertTriangle size={16} />
        <span>
          This loan has already been closed (
          <em>{LOAN_STATUS_LABELS[status]}</em>). Any claim rights should
          already have been exercised by the original holder — buying this NFT
          is very likely to net you nothing. If the seller insists there are
          outstanding claims, verify in the protocol's Claim Center before
          purchasing.
        </span>
      </div>
    );
  }
  if (
    status === LoanStatus.Defaulted ||
    status === LoanStatus.FallbackPending
  ) {
    return (
      <div className="verifier-advisory verifier-advisory--warn">
        <ShieldAlert size={16} />
        <span>
          This loan has defaulted. The lender position governs collateral claim
          rights under Vaipakam's default rules; the borrower position has lost
          its collateral. Confirm exactly what funds or assets are still
          claimable before buying.
        </span>
      </div>
    );
  }
  // Active — risk call depends on HF.
  const hfNum = hf != null ? Number(hf) / 1e18 : null;
  if (hfNum != null && hfNum < 1) {
    return (
      <div className="verifier-advisory verifier-advisory--bad">
        <ShieldAlert size={16} />
        <span>
          This loan's health factor is <strong>{hfNum.toFixed(2)}</strong>{" "}
          &mdash; already eligible for permissionless liquidation. Buying either
          position is high risk: the borrower side is one liquidator call away
          from losing collateral, and the lender side's recovery depends on the
          0x swap proceeds when the liquidation fires.
        </span>
      </div>
    );
  }
  if (hfNum != null && hfNum < 1.5) {
    return (
      <div className="verifier-advisory verifier-advisory--warn">
        <ShieldAlert size={16} />
        <span>
          This loan's health factor is <strong>{hfNum.toFixed(2)}</strong>{" "}
          &mdash; below the 1.5 threshold Vaipakam requires at loan origination.
          A further collateral-price drop can push it into the liquidation zone.
          Factor the volatility of{" "}
          <AssetSymbol address={loanDetails.collateralAsset} /> into your bid.
        </span>
      </div>
    );
  }
  if (role === "lender") {
    return (
      <div className="verifier-advisory verifier-advisory--good">
        <ShieldCheck size={16} />
        <span>
          As the lender, you'd earn principal + interest if the borrower repays
          on time, or claim the collateral on default. Compare the interest
          yield to current market rates and weigh the borrower's default risk
          from the health factor above before bidding.
        </span>
      </div>
    );
  }
  if (role === "borrower") {
    return (
      <div className="verifier-advisory verifier-advisory--good">
        <ShieldCheck size={16} />
        <span>
          As the borrower, you'd take over the collateral (on repayment) or owe
          the outstanding principal + interest before the duration expires. You
          will also inherit the obligation to maintain the position's health
          factor above 1 or face liquidation.
        </span>
      </div>
    );
  }
  return null;
}

/**
 * Formats an 18-decimal scaled bigint (health factor) as a plain decimal
 * with two fractional digits. Uses string math to avoid the precision loss
 * of Number(bigint) for values near 2^256.
 */
function formatScaled18(v: bigint): string {
  const whole = v / 10n ** 18n;
  const frac = v % 10n ** 18n;
  const twoDigit = (frac * 100n) / 10n ** 18n;
  return `${whole.toString()}.${twoDigit.toString().padStart(2, "0")}`;
}
