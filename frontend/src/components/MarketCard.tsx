
import OddsDisplay from "./OddsDisplay";
import BuyPanel from "./BuyPanel";

type MarketCardProps = {
  question: string;
  yesOdds: number;
  noOdds: number;
  status: string;
  marketAddress?: string;
  marketStatus?: number;
  liquiditySeeded?: boolean;
};

export default function MarketCard({
  question,
  yesOdds,
  noOdds,
  status,
  marketAddress,
  marketStatus,
  liquiditySeeded,
}: MarketCardProps) {
  return (
    <div className="market-card">
      <span className="status">{status}</span>

      <h2>{question}</h2>

      <OddsDisplay
        yesOdds={yesOdds}
        noOdds={noOdds}
        marketAddress={marketAddress}
      />

      {marketAddress && marketStatus !== undefined && (
        <BuyPanel
          marketAddress={marketAddress}
          isOpen={marketStatus === 1}
          liquiditySeeded={liquiditySeeded === true}
        />
      )}
    </div>
  );
}
