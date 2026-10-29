
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "ethers";
import { useWallet } from "../wallet/WalletContext";
import {
  buyShares,
  quoteBuy,
  readableError,
} from "../contracts";

type BuyPanelProps = {
  marketAddress: string;
  isOpen: boolean;
  liquiditySeeded: boolean;
};

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
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;

    setQuote(null);
    setQuoteError("");

    if (!isOpen || !liquiditySeeded) return;

    try {
      if (parseEther(amount) <= 0n) return;
    } catch {
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
  ]);

  async function handleBuy() {
    if (!signer || busy || !isOpen || !quote) return;

    setBusy(true);
    setMessage("Confirm the transaction in MetaMask...");

    try {
      const tx = await buyShares(
        marketAddress,
        outcome,
        amount,
        signer
      );

      setMessage("Transaction submitted. Waiting for confirmation...");

      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        throw new Error("Transaction failed");
      }

      setMessage("Purchase successful! Transaction confirmed.");
    } catch (error) {
      setMessage(readableError(error));
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
          className={outcome === 0 ? "selected-yes" : ""}
          onClick={() => {
            setOutcome(0);
            setMessage("");
          }}
          disabled={busy || !isOpen}
        >
          Buy YES
        </button>

        <button
          type="button"
          className={outcome === 1 ? "selected-no" : ""}
          onClick={() => {
            setOutcome(1);
            setMessage("");
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
          setMessage("");
        }}
        disabled={busy || !isOpen}
      />

      <p>
        Estimated shares:{" "}
        {quote !== null
          ? `${Number(formatEther(quote)).toFixed(6)}`
          : "—"}
      </p>

      {quoteError && <p role="alert">{quoteError}</p>}

      {!isOpen && <p>Trading is closed.</p>}

      {isOpen && !liquiditySeeded && (
        <p>Market liquidity is not available.</p>
      )}

      {!account && <p>Connect your wallet to trade.</p>}

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
          quote <= 0n
        }
      >
        {busy
          ? "Processing..."
          : `Confirm Buy ${outcome === 0 ? "YES" : "NO"}`}
      </button>

      {message && <p role="status">{message}</p>}
      <p className="trade-note">
        Local Hardhat test ETH only. Quote may change before
        confirmation; the trade uses a 1% slippage limit.
      </p>
    </div>
  );
}
