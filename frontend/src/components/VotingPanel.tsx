import { useCallback, useEffect, useState } from "react";
import { isAddress } from "ethers";
import type { ContractTransactionResponse } from "ethers";
import { useWallet } from "../wallet/WalletContext";
import {
  NETWORK_NAME,
  castVote,
  finalizeVoting,
  readVoter,
  readVoting,
  readableError,
  setReputation,
  updateReputation,
} from "../contracts";
import type { MarketInfo, VoterInfo, VotingInfo } from "../contracts";

type Props = {
  market: MarketInfo;
};

type Stage = "idle" | "wallet" | "pending" | "success" | "failed";

const STAGE_TITLE: Record<Exclude<Stage, "idle">, string> = {
  wallet: "Waiting for MetaMask",
  pending: "Transaction submitted",
  success: "Transaction confirmed",
  failed: "Transaction failed",
};

function formatTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleString();
}

function timeLeft(seconds: number) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

export default function VotingPanel({ market }: Props) {
  const { account, signer, isCorrectNetwork } = useWallet();

  const [voting, setVoting] = useState<VotingInfo | null>(null);
  const [voter, setVoter] = useState<VoterInfo | null>(null);
  const [loadError, setLoadError] = useState("");

  const [stage, setStage] = useState<Stage>("idle");
  const [message, setMessage] = useState("");
  const [hash, setHash] = useState("");

  const [newVoter, setNewVoter] = useState("");
  const [newWeight, setNewWeight] = useState("1");

  const load = useCallback(async () => {
    try {
      const [v, me] = await Promise.all([readVoting(market), account ? readVoter(account) : Promise.resolve(null)]);
      setVoting(v);
      setVoter(me);
      setLoadError("");
    } catch (err) {
      setLoadError(readableError(err));
    }
  }, [market, account]);

  // Read now and every few seconds, so phases, totals and reputation stay current.
  useEffect(() => {
    let active = true;
    const tick = () => {
      if (active) void load();
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);

  async function send(action: () => Promise<ContractTransactionResponse>, done: string) {
    setHash("");
    setStage("wallet");
    setMessage("Approve the transaction in your wallet.");
    try {
      const tx = await action();
      setHash(tx.hash);
      setStage("pending");
      setMessage("Waiting for the transaction to be mined...");
      await tx.wait();
      setStage("success");
      setMessage(done);
      await load();
    } catch (err) {
      setStage("failed");
      setMessage(readableError(err));
    }
  }

  if (!voting) {
    return (
      <section className="voting-panel">
        <h3>Decided by reputation vote</h3>
        <p>{loadError || "Loading voting..."}</p>
      </section>
    );
  }

  const busy = stage === "wallet" || stage === "pending";
  const canSend = !!signer && isCorrectNetwork && !busy;
  const isAdmin = !!account && account.toLowerCase() === voting.admin.toLowerCase();
  const total = voting.totalWeight;
  const tied =
    total > 0n && voting.totals.filter((t) => t === voting.totals.reduce((a, b) => (b > a ? b : a), 0n)).length > 1;

  let phaseText = "";
  switch (voting.phase) {
    case "before":
      phaseText = `Voting opens when trading ends (${formatTime(voting.votingStart)}) and closes ${formatTime(voting.votingDeadline)}.`;
      break;
    case "voting":
      phaseText = `Voting is open. Closes in ${timeLeft(voting.votingDeadline - voting.chainTime)}.`;
      break;
    case "counting":
      phaseText =
        total === 0n
          ? "Voting has closed and nobody voted. The market will expire and traders get refunds."
          : tied
            ? "Voting has closed with a tie, so it can't be counted. The market will expire and traders get refunds."
            : "Voting has closed. Anyone can count the votes, which resolves the market.";
      break;
    case "finalized":
      phaseText = `Votes counted: ${market.outcomes[voting.winningOutcome ?? 0]} won. The market is resolved.`;
      break;
    case "other-round":
      phaseText = "This market was decided in an earlier voting round.";
      break;
  }

  return (
    <section className="voting-panel" aria-label="Reputation voting">
      <h3>Decided by reputation vote</h3>
      <p className="voting-phase">{phaseText}</p>

      {voting.isCurrentMarket && (
        <ul className="vote-totals">
          {market.outcomes.map((label, i) => {
            const weight = voting.totals[i] ?? 0n;
            const pct = total > 0n ? Number((weight * 1000n) / total) / 10 : 0;
            const winner = voting.winningOutcome === i;
            return (
              <li key={label} className={winner ? "vote-winner" : undefined}>
                <div className="vote-row">
                  <span>{label}</span>
                  <span>
                    {weight.toString()} weight{total > 0n ? ` · ${pct}%` : ""}
                  </span>
                </div>
                <div className="vote-bar" aria-hidden="true">
                  <div style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!account && <p className="voting-note">Connect your wallet to see your reputation and vote.</p>}
      {account && !isCorrectNetwork && <p className="voting-note">Switch your wallet to {NETWORK_NAME} to vote.</p>}

      {account && voter && (
        <div className="voter-box">
          <div className="vote-row">
            <span>Your reputation</span>
            <strong>
              {voter.reputation.toString()}
              {voter.pendingUpdate && ` → ${voter.currentReputation.toString()}`}
            </strong>
          </div>

          {voting.isCurrentMarket && voter.hasVoted && voter.choice !== null && (
            <p className="voting-note">
              You voted {market.outcomes[voter.choice]} with weight {voter.reputation.toString()}.
            </p>
          )}

          {voting.phase === "voting" && !voter.hasVoted && voter.currentReputation > 0n && (
            <div className="vote-buttons">
              {market.outcomes.map((label, i) => (
                <button
                  key={label}
                  type="button"
                  disabled={!canSend}
                  onClick={() => void send(() => castVote(i, signer!), `Vote for ${label} recorded.`)}
                >
                  Vote {label}
                </button>
              ))}
            </div>
          )}

          {voter.currentReputation === 0n && voting.phase !== "other-round" && (
            <p className="voting-note">
              This account has no reputation, so it can't vote. The voting admin gives voters reputation before trading
              ends.
            </p>
          )}

          {voter.pendingUpdate && (
            <>
              <p className="voting-note">
                Your last vote was {voter.currentReputation > voter.reputation ? "right" : "wrong"}, so your reputation
                changes to {voter.currentReputation.toString()}. It is also applied automatically next time you vote.
              </p>
              <button
                type="button"
                className="secondary-action"
                disabled={!canSend}
                onClick={() => void send(() => updateReputation(account, signer!), "Reputation updated.")}
              >
                Apply reputation update
              </button>
            </>
          )}
        </div>
      )}

      {voting.phase === "counting" && total > 0n && !tied && (
        <button
          type="button"
          className="confirm-buy"
          disabled={!canSend}
          onClick={() => void send(() => finalizeVoting(signer!), "Votes counted and the market is resolved.")}
        >
          Count votes and resolve market
        </button>
      )}

      {isAdmin && voting.phase === "before" && (
        <form
          className="admin-box"
          onSubmit={(e) => {
            e.preventDefault();
            void send(
              () => setReputation(newVoter.trim(), Number(newWeight), signer!),
              `Reputation ${newWeight} given to ${newVoter.trim().slice(0, 8)}…`,
            );
          }}
        >
          <strong>Admin: give reputation</strong>
          <input
            id={`voter-${market.address}`}
            placeholder="Voter address 0x..."
            value={newVoter}
            onChange={(e) => setNewVoter(e.target.value)}
          />
          <input
            id={`weight-${market.address}`}
            type="number"
            min="1"
            step="1"
            value={newWeight}
            onChange={(e) => setNewWeight(e.target.value)}
          />
          <button
            type="submit"
            className="secondary-action"
            disabled={!canSend || !isAddress(newVoter.trim()) || !(Number(newWeight) >= 1)}
          >
            Set reputation
          </button>
        </form>
      )}

      {stage !== "idle" && (
        <div className={`transaction-status transaction-${stage}`} role={stage === "failed" ? "alert" : "status"}>
          <strong>{STAGE_TITLE[stage]}</strong>
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
