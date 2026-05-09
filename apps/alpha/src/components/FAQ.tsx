import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, Search } from "lucide-react";
import { L as Link } from "./L";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import "./FAQ.css";

type Category = "basics" | "users" | "economics" | "integrators";

interface FaqEntry {
  id: string;
  category: Category;
  /** Lowercase keyword bag used by the in-page search. English-only on
   *  purpose for now; translating search keywords is out of scope. */
  searchText: string;
  /** Renders the answer body. Receives `t` from the parent so list /
   *  table cells can be translated without invoking a hook inside this
   *  callback (which would break the Rules of Hooks because the call
   *  count varies as items expand/collapse). */
  renderA: (t: TFunction) => ReactNode;
}

const CATEGORIES: { key: Category | "all"; labelKey: string }[] = [
  { key: "all", labelKey: "faq.categoryAll" },
  { key: "basics", labelKey: "faq.categoryBasics" },
  { key: "users", labelKey: "faq.categoryUsers" },
  { key: "economics", labelKey: "faq.categoryEconomics" },
  { key: "integrators", labelKey: "faq.categoryIntegrators" },
];

/**
 * Each entry's answer body is rendered through <Trans> so the translator
 * can reorder inline emphasis / code spans while we keep the JSX skeleton
 * (lists, tables, pre-blocks) in code. Translatable keys live in the
 * `faq.entries.<id>.*` namespace; see locale JSON files.
 */
const FAQS: FaqEntry[] = [
  {
    id: "basics-what-is-vaipakam",
    category: "basics",
    searchText:
      "intro overview plain english simple beginner lending borrowing p2p peer-to-peer marketplace what is defi",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.basics-what-is-vaipakam.a1" />
        </p>
        <p>
          <Trans i18nKey="faq.entries.basics-what-is-vaipakam.a2" />
        </p>
      </>
    ),
  },
  {
    id: "basics-wallet",
    category: "basics",
    searchText:
      "wallet metamask rabby coinbase connect signing key seed phrase account browse browse-only read-only",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.basics-wallet.a1" />
        </p>
        <p>
          <Trans
            i18nKey="faq.entries.basics-wallet.a2"
            components={{ em: <em /> }}
          />
        </p>
      </>
    ),
  },
  {
    id: "basics-collateral",
    category: "basics",
    searchText:
      "collateral secured loan over-collateralized deposit lock pledge trust borrow risk strangers",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.basics-collateral.a1" />
        </p>
        <p>
          <Trans
            i18nKey="faq.entries.basics-collateral.a2"
            components={{ s: <strong /> }}
          />
        </p>
      </>
    ),
  },
  {
    id: "basics-chains",
    category: "basics",
    searchText:
      "chain network blockchain ethereum base polygon arbitrum optimism l2 layer-2 different why many fees speed",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.basics-chains.a1" />
        </p>
        <p>
          <Trans i18nKey="faq.entries.basics-chains.a2" />
        </p>
      </>
    ),
  },
  {
    id: "basics-apr",
    category: "basics",
    searchText:
      "apr annual percentage rate interest yield cost of borrowing prorated pro-rated duration rate",
    renderA: () => (
      <>
        <p>
          <Trans
            i18nKey="faq.entries.basics-apr.a1"
            components={{ s: <strong /> }}
          />
        </p>
        <p>
          <Trans i18nKey="faq.entries.basics-apr.a2" />
        </p>
      </>
    ),
  },
  {
    id: "basics-position-nft",
    category: "basics",
    searchText:
      "position nft receipt proof claim transferable sell bearer ticket onchain metadata erc721",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.basics-position-nft.a1" />
        </p>
        <p>
          <Trans i18nKey="faq.entries.basics-position-nft.a2" />
        </p>
      </>
    ),
  },
  {
    id: "basics-gas",
    category: "basics",
    searchText:
      "gas fee transaction cost validators miners network eth matic native token post stamp signing",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.basics-gas.a1" />
        </p>
        <p>
          <Trans i18nKey="faq.entries.basics-gas.a2" />
        </p>
      </>
    ),
  },
  {
    id: "basics-custody",
    category: "basics",
    searchText:
      "custody non-custodial escrow holding safe safety smart contract audited trust open source uups isolated",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.basics-custody.a1" />
        </p>
        <p>
          <Trans i18nKey="faq.entries.basics-custody.a2" />
        </p>
      </>
    ),
  },
  {
    id: "basics-vpfi-intro",
    category: "basics",
    searchText:
      "vpfi token platform fee discount rewards optional required start using beginners need help",
    renderA: () => (
      <>
        <p>
          <Trans
            i18nKey="faq.entries.basics-vpfi-intro.a1"
            components={{ s: <strong /> }}
          />
        </p>
        <p>
          <Trans i18nKey="faq.entries.basics-vpfi-intro.a2" />
        </p>
      </>
    ),
  },
  {
    id: "assets",
    category: "users",
    searchText:
      "erc-20 erc20 erc-721 erc721 erc-1155 erc1155 nft token collateral principal lend borrow rent lender borrower usdc eth weth wbtc",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.assets.a1" />
        </p>
        <ul>
          <li>
            <Trans
              i18nKey="faq.entries.assets.li1"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.assets.li2"
              components={{ s: <strong />, c: <code /> }}
            />
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "escrow",
    category: "users",
    searchText: "escrow uups proxy clone factory isolated commingled vault",
    renderA: () => (
      <>
        <p>
          <Trans
            i18nKey="faq.entries.escrow.a1"
            components={{ c: <code /> }}
          />
        </p>
        <p>
          <Trans i18nKey="faq.entries.escrow.a2" />
        </p>
      </>
    ),
  },
  {
    id: "default",
    category: "users",
    searchText:
      "default liquidation grace period health factor dex swap 0x slippage fallback illiquid nft claim",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.default.a1" />
        </p>
        <ul>
          <li>
            <Trans
              i18nKey="faq.entries.default.li1"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.default.li2"
              components={{ s: <strong /> }}
            />
          </li>
        </ul>
        <p>
          <Trans i18nKey="faq.entries.default.a2" />
        </p>
      </>
    ),
  },
  {
    id: "early-exit",
    category: "users",
    searchText:
      "early exit preclose refinance transfer offset withdrawal lender borrower sell position repay",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.early-exit.a1" />
        </p>
        <ul>
          <li>
            <Trans
              i18nKey="faq.entries.early-exit.li1"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.early-exit.li2"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.early-exit.li3"
              components={{ s: <strong /> }}
            />
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "durations",
    category: "users",
    searchText: "duration grace period term length days weeks months year",
    renderA: (t) => {
      return (
        <>
          <p>
            <Trans i18nKey="faq.entries.durations.a1" />
          </p>
          <table className="faq-table">
            <thead>
              <tr>
                <th>{t("faq.entries.durations.tableLoanTerm")}</th>
                <th>{t("faq.entries.durations.tableGracePeriod")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t("faq.entries.durations.row1Term")}</td>
                <td>{t("faq.entries.durations.row1Grace")}</td>
              </tr>
              <tr>
                <td>{t("faq.entries.durations.row2Term")}</td>
                <td>{t("faq.entries.durations.row2Grace")}</td>
              </tr>
              <tr>
                <td>{t("faq.entries.durations.row3Term")}</td>
                <td>{t("faq.entries.durations.row3Grace")}</td>
              </tr>
              <tr>
                <td>{t("faq.entries.durations.row4Term")}</td>
                <td>{t("faq.entries.durations.row4Grace")}</td>
              </tr>
              <tr>
                <td>{t("faq.entries.durations.row5Term")}</td>
                <td>{t("faq.entries.durations.row5Grace")}</td>
              </tr>
            </tbody>
          </table>
        </>
      );
    },
  },
  {
    id: "chains",
    category: "users",
    searchText:
      "chains networks base polygon arbitrum optimism ethereum sepolia canonical mirror layerzero bridge",
    renderA: () => (
      <>
        <p>
          <Trans
            i18nKey="faq.entries.chains.a1"
            components={{ s: <strong /> }}
          />
        </p>
        <p>
          <Trans
            i18nKey="faq.entries.chains.a2"
            components={{ s: <strong /> }}
          />
        </p>
      </>
    ),
  },
  {
    id: "sequencer",
    category: "users",
    searchText:
      "sequencer downtime uptime feed chainlink base arbitrum optimism pause liquidation grace",
    renderA: () => (
      <p>
        <Trans i18nKey="faq.entries.sequencer.a1" />
      </p>
    ),
  },
  {
    id: "liquidity-status",
    category: "users",
    searchText:
      "liquidity liquid illiquid classification chainlink oracle uniswap pool depth price feed active network mainnet fallback",
    renderA: () => (
      <>
        <p>
          <Trans
            i18nKey="faq.entries.liquidity-status.a1"
            components={{
              s: <strong />,
              s2: <strong />,
              c: <code />,
            }}
          />
        </p>
        <p>
          <Trans
            i18nKey="faq.entries.liquidity-status.a2"
            components={{ em: <em /> }}
          />
        </p>
      </>
    ),
  },
  {
    id: "preclose-refinance",
    category: "users",
    searchText:
      "preclose refinance early withdrawal strategic flow transfer lock borrower lender nft exit close loan replace",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.preclose-refinance.a1" />
        </p>
        <ul>
          <li>
            <Trans
              i18nKey="faq.entries.preclose-refinance.li1"
              components={{ s: <strong />, s2: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.preclose-refinance.li2"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.preclose-refinance.li3"
              components={{ s: <strong /> }}
            />
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "keepers",
    category: "users",
    searchText:
      "keeper keepers role manager delegate automation third party execution whitelist opt-in advanced mode claim nft",
    renderA: () => (
      <>
        <p>
          <Trans
            i18nKey="faq.entries.keepers.a1"
            components={{
              s: <strong />,
              s2: <strong />,
              c: <code />,
            }}
          />
        </p>
        <p>
          <Trans
            i18nKey="faq.entries.keepers.a2"
            components={{ s: <strong /> }}
          />
        </p>
        <ul>
          <li>
            <Trans
              i18nKey="faq.entries.keepers.li1"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.keepers.li2"
              components={{ s: <strong /> }}
            />
          </li>
        </ul>
        <p>
          <Trans
            i18nKey="faq.entries.keepers.a3"
            components={{ s: <strong /> }}
          />
        </p>
      </>
    ),
  },
  {
    id: "fees",
    category: "economics",
    searchText:
      "fees initiation yield treasury late bps liquidation borrower lender percent discount",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.fees.a1" />
        </p>
        <ul>
          <li>
            <Trans
              i18nKey="faq.entries.fees.li1"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.fees.li2"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.fees.li3"
              components={{ s: <strong /> }}
            />
          </li>
        </ul>
        <p>
          <Trans
            i18nKey="faq.entries.fees.a2"
            components={{ em: <em /> }}
          />
        </p>
      </>
    ),
  },
  {
    id: "vpfi-discount",
    category: "economics",
    searchText:
      "vpfi discount tier escrow borrower lender initiation yield fee basis points",
    renderA: (t) => {
      return (
        <>
          <p>
            <Trans i18nKey="faq.entries.vpfi-discount.a1" />
          </p>
          <table className="faq-table">
            <thead>
              <tr>
                <th>{t("faq.entries.vpfi-discount.tableTier")}</th>
                <th>{t("faq.entries.vpfi-discount.tableEscrow")}</th>
                <th>{t("faq.entries.vpfi-discount.tableDiscount")}</th>
                <th>{t("faq.entries.vpfi-discount.tableInitiation")}</th>
                <th>{t("faq.entries.vpfi-discount.tableYield")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>≥ 100</td>
                <td>10%</td>
                <td>0.090%</td>
                <td>0.90%</td>
              </tr>
              <tr>
                <td>2</td>
                <td>≥ 1,000</td>
                <td>15%</td>
                <td>0.085%</td>
                <td>0.85%</td>
              </tr>
              <tr>
                <td>3</td>
                <td>{t("faq.entries.vpfi-discount.row3Escrow")}</td>
                <td>20%</td>
                <td>0.080%</td>
                <td>0.80%</td>
              </tr>
              <tr>
                <td>4</td>
                <td>{t("faq.entries.vpfi-discount.row4Escrow")}</td>
                <td>24%</td>
                <td>0.076%</td>
                <td>0.76%</td>
              </tr>
            </tbody>
          </table>
        </>
      );
    },
  },
  {
    id: "vpfi-rewards",
    category: "economics",
    searchText:
      "rewards staking interactions apr escrow yield cap per-user interaction earning",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.vpfi-rewards.a1" />
        </p>
        <ul>
          <li>
            <Trans
              i18nKey="faq.entries.vpfi-rewards.li1"
              components={{ s: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.vpfi-rewards.li2"
              components={{ s: <strong />, s2: <strong /> }}
            />
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "tokenomics",
    category: "economics",
    searchText:
      "tokenomics supply allocation cap mint base layerzero oft early purchase wallet limit founders team auditors treasury",
    renderA: (t) => {
      return (
        <>
          <p>
            <Trans
              i18nKey="faq.entries.tokenomics.a1"
              components={{
                s: <strong />,
                s2: <strong />,
                s3: <strong />,
              }}
            />
          </p>
          <p>
            <Trans i18nKey="faq.entries.tokenomics.a2" />
          </p>
          <table className="faq-table">
            <thead>
              <tr>
                <th>{t("faq.entries.tokenomics.tableBucket")}</th>
                <th>{t("faq.entries.tokenomics.tableShare")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t("faq.entries.tokenomics.row1Bucket")}</td>
                <td>30%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row2Bucket")}</td>
                <td>24%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row3Bucket")}</td>
                <td>14%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row4Bucket")}</td>
                <td>12%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row5Bucket")}</td>
                <td>6%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row6Bucket")}</td>
                <td>6%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row7Bucket")}</td>
                <td>3%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row8Bucket")}</td>
                <td>2%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row9Bucket")}</td>
                <td>2%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row10Bucket")}</td>
                <td>1%</td>
              </tr>
              <tr>
                <td>{t("faq.entries.tokenomics.row11Bucket")}</td>
                <td>1%</td>
              </tr>
            </tbody>
          </table>
        </>
      );
    },
  },
  {
    id: "nft-positions",
    category: "users",
    searchText:
      "nft position erc721 metadata onchain on-chain claim ownership marketplace viewer",
    renderA: () => (
      <p>
        <Trans
          i18nKey="faq.entries.nft-positions.a1"
          components={{ s: <strong />, em: <em /> }}
        />
      </p>
    ),
  },
  {
    id: "integrator-rental",
    category: "integrators",
    searchText:
      "integrator erc4907 erc-4907 rental user expires quantity wrapper escrow subgraph event listener",
    renderA: () => (
      <>
        <p>
          <Trans
            i18nKey="faq.entries.integrator-rental.a1"
            components={{
              s: <strong />,
              em: <em />,
              c: <code />,
              c2: <code />,
              c3: <code />,
            }}
          />
        </p>
        <pre className="faq-code">
          <code>{`// Pull state on demand
escrowGetNFTUserOf(lender, nftContract, tokenId)        returns (address)
escrowGetNFTUserExpires(lender, nftContract, tokenId)   returns (uint64)
escrowGetNFTQuantity(lender, nftContract, tokenId)      returns (uint256)

// Push-style updates: subscribe on the Diamond
event EscrowRentalUpdated(
  address indexed lender,
  address indexed nftContract,
  uint256 indexed tokenId,
  address user,
  uint64  expires,
  uint256 quantity,
  uint256 activeTotalQuantity,
  uint64  minActiveExpires
);`}</code>
        </pre>
        <p>
          <Trans
            i18nKey="faq.entries.integrator-rental.a2"
            components={{ s: <strong /> }}
          />
        </p>
      </>
    ),
  },
  {
    id: "integrator-subgraph",
    category: "integrators",
    searchText:
      "subgraph events loan initiated repaid defaulted liquidated fallback indexer graph thegraph",
    renderA: () => (
      <>
        <p>
          <Trans i18nKey="faq.entries.integrator-subgraph.a1" />
        </p>
        <ul>
          <li>
            <Trans
              i18nKey="faq.entries.integrator-subgraph.li1"
              components={{ c: <code /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.integrator-subgraph.li2"
              components={{ c: <code /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.integrator-subgraph.li3"
              components={{ c: <code /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.integrator-subgraph.li4"
              components={{ c: <code /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="faq.entries.integrator-subgraph.li5"
              components={{ c: <code /> }}
            />
          </li>
        </ul>
      </>
    ),
  },
];

const LS_KEY = "vaipakam.faq.lastCategory";

export default function FAQ() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | "all">(() => {
    // Default fresh visitors to the "Basics" (Getting Started) tab — the
    // entries there are the welcoming-the-newcomer set (what is Vaipakam,
    // what's a wallet, what's collateral, etc.). Returning visitors who
    // explicitly picked another category get their last-used choice back
    // from localStorage; the default only applies on a first visit or
    // when the stored value is unrecognised.
    if (typeof window === "undefined") return "basics";
    const stored = window.localStorage.getItem(LS_KEY);
    return stored === "basics" ||
      stored === "users" ||
      stored === "economics" ||
      stored === "integrators" ||
      stored === "all"
      ? stored
      : "basics";
  });
  const [query, setQuery] = useState("");
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LS_KEY, category);
  }, [category]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FAQS.filter((f) => {
      if (category !== "all" && f.category !== category) return false;
      if (!q) return true;
      // Search uses both the (translated) question and the English
      // keyword bag. Translating searchText is out of scope; English
      // keywords still surface the right entry for any locale.
      const questionText = t(`faq.entries.${f.id}.q`);
      return (questionText + " " + f.searchText).toLowerCase().includes(q);
    });
  }, [category, query, t]);

  // Deep-link: open the item matching the URL hash on mount, and whenever hash changes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const applyHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash) return;
      const match = FAQS.find((f) => f.id === hash);
      if (match) {
        if (category !== "all" && match.category !== category)
          setCategory("all");
        setOpen(hash);
        requestAnimationFrame(() => {
          buttonRefs.current[hash]?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        });
      }
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
    // category intentionally omitted — we only react to hash changes, not category state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => {
    setOpen((cur) => (cur === id ? null : id));
    if (typeof window !== "undefined" && window.history.replaceState) {
      window.history.replaceState(null, "", `#${id}`);
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const ids = filtered.map((f) => f.id);
    let nextIdx: number | null = null;
    if (e.key === "ArrowDown") nextIdx = Math.min(index + 1, ids.length - 1);
    else if (e.key === "ArrowUp") nextIdx = Math.max(index - 1, 0);
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = ids.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      buttonRefs.current[ids[nextIdx]]?.focus();
    }
  };

  return (
    <section className="section faq" id="faq">
      <div className="container">
        <div className="faq-header">
          <span className="section-label">{t("faq.sectionLabel")}</span>
          <h2 className="section-title">{t("faq.title")}</h2>
          <p className="section-subtitle">{t("faq.subtitle")}</p>
        </div>

        <div className="faq-toolbar">
          <div className="faq-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              placeholder={t("faq.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("faq.searchAria")}
            />
          </div>
          <div
            className="faq-tabs"
            role="tablist"
            aria-label={t("faq.tabsAria")}
          >
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                role="tab"
                aria-selected={category === c.key}
                className={`faq-tab ${category === c.key ? "active" : ""}`}
                onClick={() => setCategory(c.key as Category | "all")}
              >
                {t(c.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="faq-list">
          {filtered.length === 0 && (
            <div className="faq-empty">
              {t("faq.empty", { query })}
            </div>
          )}
          {filtered.map((faq, i) => {
            const isOpen = open === faq.id;
            return (
              <div
                key={faq.id}
                id={faq.id}
                className={`faq-item ${isOpen ? "open" : ""}`}
              >
                <button
                  ref={(el) => {
                    buttonRefs.current[faq.id] = el;
                  }}
                  className="faq-question"
                  onClick={() => toggle(faq.id)}
                  onKeyDown={(e) => handleKey(e, i)}
                  aria-expanded={isOpen}
                  aria-controls={`${faq.id}-answer`}
                >
                  <span>{t(`faq.entries.${faq.id}.q`)}</span>
                  <ChevronDown
                    size={20}
                    className="faq-chevron"
                    aria-hidden="true"
                  />
                </button>
                <div
                  id={`${faq.id}-answer`}
                  role="region"
                  aria-labelledby={faq.id}
                  className="faq-answer"
                  hidden={!isOpen}
                >
                  <div className="faq-answer-inner">{faq.renderA(t)}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="faq-cta">
          {t("faq.ctaPrefix")}
          <a
            href="https://github.com/vaipakam/vaipakam/issues"
            target="_blank"
            rel="noreferrer"
          >
            {t("faq.ctaGithubLink")}
          </a>
          {t("faq.ctaMiddle")}
          <Link to="/discord">{t("faq.ctaDiscordLink")}</Link>
          {t("faq.ctaSuffix")}
        </div>
      </div>
    </section>
  );
}
