
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "ethers";
import { useWallet } from "../wallet/WalletContext";
import {
  buyShares,
  quoteBuy,
  readableError,
} from "../contracts";

import TransactionStatus from "./TransactionStatus";
import type { TransactionInfo } from "./TransactionStatus";

type BuyPanelProps = {
  marketAddress: string;
  isOpen: boolean;
  liquiditySeeded: boolean;
};

function validAmount(value: string): boolean {
  try {
    return parseEther(value) > 0n;
  } catch {
    return false;
  }
}

export default function BuyPanel({
  marketAddress,
  isOpen,
  liquiditySeeded,
}: BuyPanelProps) {
  const { signer, account, isCorrectNetwork } = useWallet();

  const [outcome, setOutcome] = useState(0);
  const [amount, setAmount] = useState("0.1");

  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteError, setQuoteError] = useState("");

  const [busy, setBusy] = useState(false);

  const [transaction, setTransaction] =
    useState<TransactionInfo>({ stage: "idle" });

  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch the latest estimated shares
  useEffect(() => {
    let active = true;

    setQuote(null);
    setQuoteError("");

    if (!isOpen || !liquiditySeeded || !validAmount(amount)) {
      return;
    }

    async function loadQuote() {
      try {
        const result = await quoteBuy(
          marketAddress,
          outcome,
          amount
        );

        if (active) {
          setQuote(result);
          setQuoteError("");
        }
      } catch (error) {
        if (active) {
          setQuote(null);
          setQuoteError(readableError(error));
        }
      }
    }

    void loadQuote();

    const interval = setInterval(() => {
      void loadQuote();
    }, 15000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [
    marketAddress,
    outcome,
    amount,
    isOpen,
    liquiditySeeded,
    refreshKey,
  ]);

  // Process a YES or NO purchase
  async function handleBuy() {
    if (
      !signer ||
      busy ||
      !isOpen ||
      !liquiditySeeded ||
      quote === null ||
      quote <= 0n ||
      !validAmount(amount)
    ) {
      return;
    }

    setBusy(true);

    // Stage 1: Waiting for wallet approval
    setTransaction({ stage: "wallet" });

    let transactionHash: string | undefined;

    try {
      const tx = await buyShares(
        marketAddress,
        outcome,
        amount,
        signer
      );

      transactionHash = tx.hash;

      // Stage 2: Transaction sent to blockchain
      setTransaction({
        stage: "pending",
        hash: transactionHash,
      });

      const receipt = await tx.wait();

      if (!receipt) {
        setTransaction({
          stage: "unknown",
          hash: transactionHash,
          detail:
            "No confirmation received. Check the transaction before retrying.",
        });
        return;
      }

      if (receipt.status !== 1) {
        setTransaction({
          stage: "failed",
          hash: transactionHash,
          detail: "The transaction reverted on-chain.",
        });
        return;
      }

      // Stage 3: Transaction confirmed successfully
      setTransaction({
        stage: "success",
        hash: transactionHash,
        detail: `Successfully purchased ${
          outcome === 0 ? "YES" : "NO"
        } shares using ${amount} test ETH.`,
      });

      // Fetch a fresh purchase quote
      setRefreshKey((previous) => previous + 1);

    } catch (error) {
      // Stage 4: Transaction error
      if (transactionHash) {
        setTransaction({
          stage: "unknown",
          hash: transactionHash,
          detail:
            `Unable to verify confirmation: ${readableError(error)}. ` +
            "Check the transaction before retrying.",
        });
      } else {
        setTransaction({
          stage: "failed",
          detail: readableError(error),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="buy-panel">
      <h3>Place a prediction</h3>

      <div className="trade-options">
        <button
          type="button"
          className={
            outcome === 0 ? "selected-yes" : ""
          }
          onClick={() => {
            setOutcome(0);
            setTransaction({ stage: "idle" });
          }}
          disabled={busy || !isOpen}
        >
          Buy YES
        </button>

        <button
          type="button"
          className={
            outcome === 1 ? "selected-no" : ""
          }
          onClick={() => {
            setOutcome(1);
            setTransaction({ stage: "idle" });
          }}
          disabled={busy || !isOpen}
        >
          Buy NO
        </button>
      </div>

      <label htmlFor={`amount-${marketAddress}`}>
        Amount (ETH)
      </label>

      <input
        id={`amount-${marketAddress}`}
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setQuote(null);
          setTransaction({ stage: "idle" });
        }}
        disabled={busy || !isOpen}
      />

      <p>
        Estimated shares:{" "}
        {quote !== null
          ? Number(formatEther(quote)).toFixed(6)
          : "—"}
      </p>

      {quoteError && (
        <p role="alert">{quoteError}</p>
      )}

      {!isOpen && <p>Trading is closed.</p>}

      {isOpen && !liquiditySeeded && (
        <p>Market liquidity is not available.</p>
      )}

      {!account && (
        <p>Connect your wallet to trade.</p>
      )}

      {account && !isCorrectNetwork && (
        <p>Switch MetaMask to Hardhat Local.</p>
      )}

      <button
        type="button"
        className="confirm-buy"
        onClick={() => void handleBuy()}
        disabled={
          busy ||
          !signer ||
          !isOpen ||
          !liquiditySeeded ||
          quote === null ||
          quote <= 0n ||
          !validAmount(amount)
        }
      >
        {busy
          ? "Processing transaction..."
          : `Confirm Buy ${
              outcome === 0 ? "YES" : "NO"
            }`}
      </button>

      <TransactionStatus {...transaction} />

      <p className="trade-note">
        Local Hardhat test ETH only. Quotes may change
        before confirmation. Trades use a 1% slippage limit.
      </p>
    </div>
  );
}
