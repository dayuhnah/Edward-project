
import { MarketStatus } from "../contracts";
import type { MarketInfo } from "../contracts";

type Props = {
  market: MarketInfo;
};

function formatDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString();
}

export default function MarketStateInfo({ market }: Props) {
  let title = "";
  let description = "";

  switch (market.status) {
    case MarketStatus.Upcoming:
      title = "Market not started";
      description = `Trading begins ${formatDate(market.startTime)}.`;
      break;

    case MarketStatus.Open:
      if (market.liquiditySeeded) {
        title = "Trading is open";
        description = `Trading ends ${formatDate(market.endTime)}.`;
      } else {
        title = "Waiting for liquidity";
        description = "Trading is unavailable until funded.";
      }
      break;

    case MarketStatus.Closed:
      title = "Trading closed";
      description = `Awaiting resolution. Deadline: ${formatDate(
        market.resolutionDeadline
      )}.`;
      break;

    case MarketStatus.Resolved:
      title = "Market resolved";
      description =
        market.winningOutcome !== null
          ? `Winning outcome: ${
              market.outcomes[market.winningOutcome] ?? "Unknown"
            }. Eligible holders can claim winnings.`
          : "The market has been resolved.";
      break;

    case MarketStatus.Expired:
      title = "Market expired";
      description =
        "The market expired without resolution. Eligible participants can claim refunds.";
      break;

    default:
      title = "Unknown market status";
      description = "Unable to determine the market state.";
  }

  return (
    <section
      className={`market-state market-state-${market.status}`}
      aria-label="Market state"
    >
      <strong>{title}</strong>
      <p>{description}</p>
    </section>
  );
}
