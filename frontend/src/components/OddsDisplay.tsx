
import { useEffect, useState } from "react";
import { Contract, JsonRpcProvider, isAddress } from "ethers";
import { MARKET_READ_ABI } from "../contracts/MarketABI";

type OddsDisplayProps = {
  yesOdds: number;
  noOdds: number;
  marketAddress?: string;
};

type LiveOdds = {
  address: string;
  yes: number;
  no: number;
};

const RPC_URL = import.meta.env.VITE_RPC_URL;
const provider = RPC_URL ? new JsonRpcProvider(RPC_URL) : null;

export default function OddsDisplay({
  yesOdds,
  noOdds,
  marketAddress,
}: OddsDisplayProps) {
  const [odds, setOdds] = useState<LiveOdds | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!marketAddress || !isAddress(marketAddress) || !provider) {
      return;
    }

    let cancelled = false;
    let loading = false;

    const market = new Contract(
      marketAddress,
      MARKET_READ_ABI,
      provider
    );

    async function fetchOdds() {
      if (loading) return;
      loading = true;

      try {
        const seeded: boolean = await market.liquiditySeeded();
        const reserves: bigint[] = await market.getReserves();

        if (!seeded || reserves.length !== 2) {
          throw new Error("Binary market not ready");
        }

        const total = reserves[0] + reserves[1];

        if (total === 0n) {
          throw new Error("Market has no liquidity");
        }

        // Binary constant-product AMM marginal odds
        // Outcome 0 = YES, outcome 1 = NO
        const yesBasisPoints =
          (reserves[1] * 10000n) / total;

        const yes = Number(yesBasisPoints) / 100;
        const no = 100 - yes;

        if (!cancelled) {
          setOdds({ address: marketAddress!, yes, no });
          setError("");
        }
      } catch {
        if (!cancelled) {
          setOdds(null);
          setError("Unable to fetch on-chain odds");
        }
      } finally {
        loading = false;
      }
    }

    void fetchOdds();

    // Refresh approximately every 15 seconds
    const interval = setInterval(() => {
      void fetchOdds();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [marketAddress]);

  const live = odds?.address === marketAddress ? odds : null;

  const displayedYes = !marketAddress ? yesOdds : live?.yes;
  const displayedNo = !marketAddress ? noOdds : live?.no;

  let message = "Demo odds — not live";

  if (marketAddress) {
    if (!isAddress(marketAddress)) {
      message = "Invalid market address";
    } else if (!provider) {
      message = "RPC connection not configured";
    } else if (error) {
      message = error;
    } else if (live) {
      message = "On-chain estimate · Refreshes every 15s";
    } else {
      message = "Loading on-chain odds...";
    }
  }

  return (
    <>
      <div className="odds">
        <div className="yes">
          YES: {displayedYes?.toFixed(1) ?? "—"}%
        </div>

        <div className="no">
          NO: {displayedNo?.toFixed(1) ?? "—"}%
        </div>
      </div>

      <p className="odds-note">{message}</p>
    </>
  );
}

//It connects to a deployed market, reads the YES and NO reserves, 
//calculates the current marginal odds and checks for updates every 15 seconds.
//It also handles missing liquidity and network errors instead of displaying invented live prices.