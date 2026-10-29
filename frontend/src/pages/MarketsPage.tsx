
import { useEffect, useState } from "react";
import MarketCard from "../components/MarketCard";
import { readAllMarkets } from "../contracts";
import type { MarketInfo } from "../contracts";

export default function MarketsPage() {
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadMarkets() {
      try {
        const data = await readAllMarkets();

        if (active) {
          setMarkets(data);
          setError("");
        }
      } catch {
        if (active) {
          setError("Unable to load markets from blockchain");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadMarkets();

    const interval = setInterval(() => {
      void loadMarkets();
    }, 15000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <main className="container">
      <h1>Edward Prediction Markets</h1>

      <p>Explore markets and predict future outcomes.</p>

      <p>Live market data — refreshes every 15 seconds.</p>

      {loading && <p>Loading markets...</p>}

      {error && <p role="alert">{error}</p>}

      {!loading && !error && markets.length === 0 && (
        <p>No markets available.</p>
      )}

      <div className="market-grid">
        {markets.map((market) => (
          <MarketCard
            key={market.address}
            market={market}
          />
        ))}
      </div>
    </main>
  );
}
