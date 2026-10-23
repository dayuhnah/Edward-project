
import OddsDisplay from "./OddsDisplay";

type MarketCardProps = {
  question: string;
  yesOdds: number;
  noOdds: number;
  status: string;
  marketAddress?: string;
};

export default function MarketCard({
  question,
  yesOdds,
  noOdds,
  status,
  marketAddress,
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
    </div>
  );
}
