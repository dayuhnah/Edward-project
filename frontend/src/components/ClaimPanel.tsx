
import { useEffect, useState } from "react";
import { formatEther } from "ethers";
import { useWallet } from "../wallet/WalletContext";
import {
  MarketStatus,
  readPosition,
  claimPayout,
  claimRefund,
  readableError,
} from "../contracts";
import type { MarketInfo } from "../contracts";

type Props = {
  market: MarketInfo;
};

type Position = Awaited<ReturnType<typeof readPosition>>;

type ClaimStage =
  | "idle"
  | "wallet"
  | "pending"
  | "success"
  | "failed"
  | "unknown";

export default function ClaimPanel({ market }: Props) {
  const { account, signer, isCorrectNetwork } = useWallet();

  const [position, setPosition] = useState<Position | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [stage, setStage] = useState<ClaimStage>("idle");
  const [message, setMessage] = useState("");
  const [hash, setHash] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const isResolved = market.status === MarketStatus.Resolved;
  const isExpired = market.status === MarketStatus.Expired;

  // Read the connected user's claimable balance
  useEffect(() => {
    let active = true;

    setPosition(null);
    setError("");
    setLoading(Boolean(account));

    if (!account) {
      return () => {
        active = false;
      };
    }

    async function loadPosition() {
      try {
        const result = await readPosition(
          market.address,
          account!
        );

        if (active) {
          setPosition(result);
          setError("");
        }
      } catch (err) {
        if (active) {
          setPosition(null);
          setError(readableError(err));
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadPosition();

    const interval = setInterval(() => {
      void loadPosition();
    }, 15000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [account, market.address, market.status, refreshKey]);

  const eligibleAmount = isResolved
    ? position?.claimable
    : position?.refundable;

  async function handleClaim() {
    if (
      !signer ||
      !isCorrectNetwork ||
      busy ||
      (!isResolved && !isExpired) ||
      !eligibleAmount ||
      eligibleAmount <= 0n
    ) {
      return;
    }

    setBusy(true);
    setStage("wallet");
    setMessage("Approve the request in MetaMask.");
    setHash("");

    let submittedHash = "";

    try {
      const tx = isResolved
        ? await claimPayout(market.address, signer)
        : await claimRefund(market.address, signer);

      submittedHash = tx.hash;
      setHash(submittedHash);
      setStage("pending");
      setMessage("Waiting for blockchain confirmation...");

      const receipt = await tx.wait();

      if (!receipt) {
        setStage("unknown");
        setMessage(
          "Confirmation unavailable. Verify the transaction before retrying."
        );
        return;
      }

      if (receipt.status !== 1) {
        setStage("failed");
        setMessage("The transaction reverted on-chain.");
        return;
      }

      setStage("success");
      setMessage(
        isResolved
          ? "Winnings claimed successfully!"
          : "Refund claimed successfully!"
      );

      setRefreshKey((previous) => previous + 1);
    } catch (err) {
      if (submittedHash) {
        setStage("unknown");
        setMessage(
          "Unable to verify confirmation: " +
          readableError(err) +
          ". Check the transaction before retrying."
        );
      } else {
        setStage("failed");
        setMessage(readableError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!isResolved && !isExpired) return null;

  return (
    <section className="claim-panel">
      <h3>
        {isResolved ? "Claim winnings" : "Claim refund"}
      </h3>

      {!account && (
        <p>Connect your wallet to check your claim.</p>
      )}

      {account && !isCorrectNetwork && (
        <p>Switch your wallet to Hardhat Local.</p>
      )}

      {loading && <p>Checking your position...</p>}

      {error && <p role="alert">{error}</p>}

      {account && !loading && position && (
        <>
          <p>
            Eligible amount:{" "}
            <strong>
              {formatEther(eligibleAmount ?? 0n)} ETH
            </strong>
          </p>

          {eligibleAmount === 0n && (
            <p>
              {isResolved
                ? "No winning shares available to redeem."
                : "No refundable collateral available."}
            </p>
          )}

          <button
            type="button"
            className="confirm-buy"
            disabled={
              busy ||
              !signer ||
              !isCorrectNetwork ||
              !eligibleAmount ||
              eligibleAmount <= 0n ||
              stage === "unknown"
            }
            onClick={() => void handleClaim()}
          >
            {busy
              ? "Processing..."
              : isResolved
                ? "Claim Winnings"
                : "Claim Refund"}
          </button>
        </>
      )}

      {stage !== "idle" && (
        <div
          className={`transaction-status transaction-${stage}`}
          role={stage === "failed" ? "alert" : "status"}
        >
          <strong>
            {stage === "success"
              ? "Transaction confirmed"
              : stage === "failed"
                ? "Transaction failed"
                : stage === "unknown"
                  ? "Confirmation not verified"
                  : stage === "wallet"
                    ? "Waiting for MetaMask"
                    : "Transaction submitted"}
          </strong>

          <p>{message}</p>

          {hash && (
            <div className="transaction-hash">
              <small>Transaction hash:</small>
              <code>{hash}</code>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
