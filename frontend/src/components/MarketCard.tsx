
import OddsDisplay from "./OddsDisplay";
import BuyPanel from "./BuyPanel";
import MarketStateInfo from "./MarketStateInfo";
import ClaimPanel from "./ClaimPanel";

import { MarketStatus } from "../contracts";
import type { MarketInfo } from "../contracts";

type Props = {
  market: MarketInfo;
};

export default function MarketCard({ market }: Props) {
  const isOpen = market.status === MarketStatus.Open;
  const canTrade = isOpen && market.liquiditySeeded;

  const canClaim =
    market.status === MarketStatus.Resolved ||
    market.status === MarketStatus.Expired;

  return (
    <div className="market-card">
      <span className="status">
        {market.statusLabel}
      </span>

      <h2>{market.question}</h2>

      <OddsDisplay
        yesOdds={market.odds[0] ?? 0}
        noOdds={market.odds[1] ?? 0}
        marketAddress={market.address}
      />

      <MarketStateInfo market={market} />

      {canTrade && (
        <BuyPanel
          marketAddress={market.address}
          isOpen={true}
          liquiditySeeded={true}
        />
      )}

      {canClaim && (
        <ClaimPanel market={market} />
      )}
    </div>
  );
}
