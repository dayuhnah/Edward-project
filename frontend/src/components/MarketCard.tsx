
type MarketCardProps = {
  question: string;
  yesOdds: number;
  noOdds: number;
  status: string;
};

export default function MarketCard({
  question,
  yesOdds,
  noOdds,
  status,
}: MarketCardProps) {
  return (
    <div className="market-card">
      <span className="status">{status}</span>

      <h2>{question}</h2>

      <div className="odds">
        <div className="yes">YES: {yesOdds}%</div>
        <div className="no">NO: {noOdds}%</div>
      </div>
    </div>
  );
}
//creates a reusable React component for displaying an individual prediction market.