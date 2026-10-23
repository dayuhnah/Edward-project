
import MarketCard from "../components/MarketCard";

export default function MarketsPage() {
  // Temporary sample data
  const markets = [
    {
      id: 1,
      question: "Will Bitcoin reach $120,000?",
      yesOdds: 65,
      noOdds: 35,
      status: "Open",
    },
    {
      id: 2,
      question: "Will Ethereum reach $5,000?",
      yesOdds: 40,
      noOdds: 60,
      status: "Open",
    },
    {
      id: 3,
      question: "Will Arsenal win the Premier League?",
      yesOdds: 75,
      noOdds: 25,
      status: "Closed",
    },
  ];

  return (
    <main className="container">
      <h1>Edward Prediction Markets</h1>
      <p>Explore markets and predict future outcomes.</p>
      <p>Demo markets — odds are not live.</p>

      <div className="market-grid">
        {markets.map((market) => (
          <MarketCard key={market.id} {...market} />
        ))}
      </div>
    </main>
  );
}
