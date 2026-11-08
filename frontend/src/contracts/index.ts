// Contract interface for the dApp: everything the components need to read from and write
// to the contracts. Addresses and ABIs are written here by prediction-market/scripts/deploy.js,
// so re-run the deploy script after changing a contract.
//
// The network comes from VITE_NETWORK:
//   npm run dev          local Hardhat node (deployments.json)
//   npm run dev:sepolia  Sepolia (deployments.sepolia.json)
import { Contract, JsonRpcProvider, formatEther, isAddress, parseEther } from "ethers";
import type { ContractRunner, ContractTransactionResponse } from "ethers";
import marketFactoryAbi from "./abis/MarketFactory.json";
import marketAbi from "./abis/Market.json";
import outcomeTokenAbi from "./abis/OutcomeToken.json";
import votingAbi from "./abis/ReputationWeightedVoting.json";

type Deployments = {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorer?: string | null;
  factory: string;
  arbitrator: string;
  /** ReputationWeightedVoting contract (bonus), if deployed. */
  voting?: string;
  voters?: { address: string; reputation: number }[];
  markets: { address: string; question: string; decidedBy?: "voting" }[];
  deployedAt: string;
};

const deploymentFiles = import.meta.glob("./deployments*.json", { eager: true, import: "default" }) as Record<string, Deployments>;
export const NETWORK: string = import.meta.env.VITE_NETWORK ?? "localhost";
const file = NETWORK === "localhost" ? "./deployments.json" : `./deployments.${NETWORK}.json`;
const found = deploymentFiles[file];
if (!found) {
  throw new Error(`No ${file.slice(2)} found. Run the deploy script for "${NETWORK}" first (see README).`);
}
export const deployments: Deployments = found;

export const EXPECTED_CHAIN_ID = deployments.chainId;
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? deployments.rpcUrl;
/** Network name shown in the UI, e.g. in "switch to Sepolia". */
export const NETWORK_NAME = EXPECTED_CHAIN_ID === 31337 ? "Hardhat Local" : EXPECTED_CHAIN_ID === 11155111 ? "Sepolia" : `chain ${EXPECTED_CHAIN_ID}`;
/** Etherscan-style link for a transaction or address, or null on the local chain. */
export function explorerLink(kind: "tx" | "address", value: string): string | null {
  return deployments.explorer ? `${deployments.explorer}/${kind}/${value}` : null;
}

/** Read-only connection to the chain, works without a wallet. */
export const readProvider = new JsonRpcProvider(RPC_URL);

// Market status (matches Market.status() in Market.sol)
export const MarketStatus = {
  Upcoming: 0,
  Open: 1,
  Closed: 2,
  Resolved: 3,
  Expired: 4,
} as const;
export type MarketStatus = (typeof MarketStatus)[keyof typeof MarketStatus];
export const STATUS_LABEL: Record<MarketStatus, string> = {
  0: "Upcoming",
  1: "Open",
  2: "Closed",
  3: "Resolved",
  4: "Expired",
};

// Contract objects
/** Pass a wallet signer to send transactions, or leave empty for read-only. */
export function getFactory(runner: ContractRunner = readProvider) {
  return new Contract(deployments.factory, marketFactoryAbi, runner);
}

export function getMarket(address: string, runner: ContractRunner = readProvider) {
  if (!isAddress(address)) throw new Error(`Not a valid market address: ${address}`);
  return new Contract(address, marketAbi, runner);
}

export function getOutcomeToken(address: string, runner: ContractRunner = readProvider) {
  return new Contract(address, outcomeTokenAbi, runner);
}

// Reading
export type MarketInfo = {
  address: string;
  question: string;
  outcomes: string[];
  creator: string;
  arbitrator: string;
  startTime: number; // unix seconds
  endTime: number;
  resolutionDeadline: number;
  status: MarketStatus;
  statusLabel: string;
  liquiditySeeded: boolean;
  resolved: boolean;
  winningOutcome: number | null; // only set when resolved
  reserves: bigint[];
  /** Price of each outcome in % (0–100). Empty until liquidity is seeded. */
  odds: number[];
  collateral: bigint; // ETH held by the market, in wei
  outcomeToken: string;
};

/**
 * Constant-product odds: price_i = (product of the OTHER reserves) / (sum over j of product of all reserves except j).
 * For 2 outcomes this is price_YES = reserve_NO / (reserve_YES + reserve_NO).
 */
export function oddsFromReserves(reserves: bigint[]): number[] {
  if (reserves.length === 0 || reserves.some((r) => r === 0n)) return [];
  const others = reserves.map((_, i) => reserves.reduce((acc, r, j) => (j === i ? acc : acc * r), 1n));
  const total = others.reduce((a, b) => a + b, 0n);
  return others.map((o) => Number((o * 1_000_000n) / total) / 10_000);
}

/** All market addresses registered in the factory. */
export async function getMarketAddresses(): Promise<string[]> {
  return [...(await getFactory().getMarkets())];
}

/** Everything the UI needs about one market, in one call. */
export async function readMarket(address: string): Promise<MarketInfo> {
  const m = getMarket(address);
  const [question, outcomes, creator, arbitrator, startTime, endTime, deadline, status, seeded, resolved, winning, reserves, token, collateral] =
    await Promise.all([
      m.question(),
      m.getOutcomes(),
      m.creator(),
      m.arbitrator(),
      m.startTime(),
      m.endTime(),
      m.resolutionDeadline(),
      m.status(),
      m.liquiditySeeded(),
      m.resolved(),
      m.winningOutcome(),
      m.getReserves(),
      m.outcomeToken(),
      readProvider.getBalance(address),
    ]);
  const st = Number(status) as MarketStatus;
  const res = [...reserves].map((r: bigint) => BigInt(r));
  return {
    address,
    question,
    outcomes: [...outcomes],
    creator,
    arbitrator,
    startTime: Number(startTime),
    endTime: Number(endTime),
    resolutionDeadline: Number(deadline),
    status: st,
    statusLabel: STATUS_LABEL[st],
    liquiditySeeded: seeded,
    resolved,
    winningOutcome: resolved ? Number(winning) : null,
    reserves: res,
    odds: seeded ? oddsFromReserves(res) : [],
    collateral,
    outcomeToken: token,
  };
}

export async function readAllMarkets(): Promise<MarketInfo[]> {
  return Promise.all((await getMarketAddresses()).map(readMarket));
}

/** A user's position in one market: shares per outcome, what they can claim or get refunded. */
export async function readPosition(marketAddress: string, user: string) {
  const m = getMarket(marketAddress);
  const token = getOutcomeToken(await m.outcomeToken());
  const count = Number(await m.getOutcomeCount());
  const [shares, payout, paid] = await Promise.all([
    Promise.all(Array.from({ length: count }, (_, i) => token.balanceOf(user, i) as Promise<bigint>)),
    m.getPayout(user) as Promise<bigint>,
    m.collateralPaid(user) as Promise<bigint>,
  ]);
  return { shares, claimable: payout, refundable: paid };
}

/** How many shares `ethAmount` (e.g. "0.5") would buy right now. */
export async function quoteBuy(marketAddress: string, outcomeId: number, ethAmount: string): Promise<bigint> {
  return getMarket(marketAddress).calcBuyAmount(parseEther(ethAmount), outcomeId);
}

// Reputation voting (bonus)
export const VOTING_ADDRESS: string | null = deployments.voting ?? null;

export function getVoting(runner: ContractRunner = readProvider) {
  if (!VOTING_ADDRESS) throw new Error("No voting contract in deployments.json. Re-run the deploy script.");
  return new Contract(VOTING_ADDRESS, votingAbi, runner);
}

/** True if this market is resolved by the voting contract instead of a single arbitrator. */
export function isVotedMarket(market: Pick<MarketInfo, "arbitrator">): boolean {
  return !!VOTING_ADDRESS && market.arbitrator.toLowerCase() === VOTING_ADDRESS.toLowerCase();
}

export type VotingPhase = "before" | "voting" | "counting" | "finalized" | "other-round";

export type VotingInfo = {
  round: number;
  admin: string;
  /** False when the voting contract has moved on to a later market. */
  isCurrentMarket: boolean;
  phase: VotingPhase;
  votingStart: number; // the market's end time
  votingDeadline: number;
  chainTime: number; // latest block time (so advance-time.js works locally)
  totals: bigint[];
  totalWeight: bigint;
  winningOutcome: number | null;
};

export type VoterInfo = {
  reputation: bigint;
  /** Reputation including an update that hasn't been applied yet. */
  currentReputation: bigint;
  hasVoted: boolean;
  choice: number | null; // what they voted in their latest round
  pendingUpdate: boolean;
};

/** Voting state for one market. */
export async function readVoting(market: MarketInfo): Promise<VotingInfo> {
  const v = getVoting();
  const [round, admin, current, deadline, finalized, winning, totals, totalWeight, block] = await Promise.all([
    v.round(),
    v.admin(),
    v.market(),
    v.votingDeadline(),
    v.finalized(),
    v.winningOutcome(),
    v.getVoteTotals(),
    v.totalWeightCast(),
    readProvider.getBlock("latest"),
  ]);
  const chainTime = block?.timestamp ?? Math.floor(Date.now() / 1000);
  const isCurrentMarket = (current as string).toLowerCase() === market.address.toLowerCase();
  let phase: VotingPhase;
  if (!isCurrentMarket) phase = "other-round";
  else if (finalized) phase = "finalized";
  else if (chainTime < market.endTime) phase = "before";
  else if (chainTime < Number(deadline)) phase = "voting";
  else phase = "counting";
  return {
    round: Number(round),
    admin,
    isCurrentMarket,
    phase,
    votingStart: market.endTime,
    votingDeadline: Number(deadline),
    chainTime,
    totals: isCurrentMarket ? [...totals].map((t: bigint) => BigInt(t)) : [],
    totalWeight: isCurrentMarket ? BigInt(totalWeight) : 0n,
    winningOutcome: isCurrentMarket && finalized ? Number(winning) : null,
  };
}

/** One account's standing in the voting system. */
export async function readVoter(user: string): Promise<VoterInfo> {
  const v = getVoting();
  const [reputation, current, voted, last, pending] = await Promise.all([
    v.reputation(user),
    v.currentReputation(user),
    v.hasVoted(user),
    v.lastChoice(user),
    v.hasPendingUpdate(user),
  ]);
  return {
    reputation: BigInt(reputation),
    currentReputation: BigInt(current),
    hasVoted: voted,
    choice: last[0] ? Number(last[1]) : null,
    pendingUpdate: pending,
  };
}

/** Cast a reputation-weighted vote for an outcome (after trading ends, before the deadline). */
export function castVote(outcomeId: number, signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getVoting(signer).vote(outcomeId);
}

/** Count the votes after the deadline; this resolves the market with the winning outcome. */
export function finalizeVoting(signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getVoting(signer).finalizeVoting();
}

/** Apply a voter's reputation change from their last finalized vote. Anyone can call it. */
export function updateReputation(voter: string, signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getVoting(signer).updateReputation(voter);
}

/** Admin only: give an address voting weight (before the market's trading ends). */
export function setReputation(voter: string, weight: number, signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getVoting(signer).setReputation(voter, weight);
}

// Writing (needs a wallet signer)
/**
 * Buy shares. `slippageBps` is how far below the quote we still accept (100 = 1%).
 * Returns the transaction, so the caller can `await tx.wait()`.
 */
export async function buyShares(
  marketAddress: string,
  outcomeId: number,
  ethAmount: string,
  signer: ContractRunner,
  slippageBps = 100,
): Promise<ContractTransactionResponse> {
  const value = parseEther(ethAmount);
  const quote: bigint = await getMarket(marketAddress).calcBuyAmount(value, outcomeId);
  const minOut = (quote * BigInt(10_000 - slippageBps)) / 10_000n;
  return getMarket(marketAddress, signer).buyOutcomeTokens(outcomeId, minOut, { value });
}

/** Claim all winning shares after the market is resolved. */
export function claimPayout(marketAddress: string, signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getMarket(marketAddress, signer).claimPayout();
}

/** Refund from an expired (never resolved) market. */
export function claimRefund(marketAddress: string, signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getMarket(marketAddress, signer).claimRefund();
}

/** Arbitrator only: declare the winning outcome after the end time. */
export function resolveMarket(marketAddress: string, outcomeId: number, signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getMarket(marketAddress, signer).resolve(outcomeId);
}

// Errors
const contractInterfaces = [
  new Contract(deployments.factory, marketAbi).interface,
  new Contract(deployments.factory, outcomeTokenAbi).interface,
  new Contract(deployments.factory, votingAbi).interface,
];

/** Turns a failed call into a short message for the UI, using the contract's custom error name. */
export function readableError(e: unknown): string {
  const err = e as { code?: string; data?: string; info?: { error?: { data?: string } }; shortMessage?: string; message?: string };
  if (err?.code === "ACTION_REJECTED") return "Transaction cancelled in wallet";
  const data = err?.data ?? err?.info?.error?.data;
  if (typeof data === "string") {
    for (const iface of contractInterfaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return ERROR_TEXT[parsed.name] ?? parsed.name;
      } catch {
        /* not this contract */
      }
    }
  }
  return err?.shortMessage ?? err?.message ?? "Something went wrong";
}

const ERROR_TEXT: Record<string, string> = {
  ZeroAmount: "Enter an amount greater than 0",
  InvalidOutcome: "That outcome doesn't exist",
  LiquidityNotSeeded: "This market has no liquidity yet",
  MarketClosed: "This market is already resolved",
  MarketNotStarted: "Trading hasn't started yet",
  MarketExpired: "Trading has ended for this market",
  SlippageExceeded: "Price moved too much, try again",
  NotArbitrator: "Only the arbitrator can resolve this market",
  AlreadyResolved: "This market is already resolved",
  MarketNotEnded: "The market hasn't ended yet",
  NotResolved: "The market isn't resolved yet",
  NothingToRedeem: "You have no winning shares to claim",
  ResolutionWindowClosed: "The resolution deadline has passed",
  NotExpired: "Refunds are only available for expired markets",
  NothingToRefund: "You have nothing to refund",
  TransferFailed: "ETH transfer failed",
  // voting
  NotAdmin: "Only the voting admin can do this",
  NotEligible: "You have no reputation, so you can't vote",
  AlreadyVoted: "You have already voted on this market",
  VotingNotStarted: "Voting opens when trading ends",
  VotingClosed: "Voting has closed",
  VotingStillOpen: "Voting is still open",
  AlreadyFinalized: "The vote has already been counted",
  NoVotes: "Nobody has voted",
  VotingTied: "The vote is tied, so it can't be counted",
  ReputationLocked: "Reputation can't change once voting has started",
  InvalidReputation: "Enter a reputation greater than 0",
  NothingToUpdate: "There's no reputation change to apply",
  NotInitialized: "Voting hasn't been set up yet",
};

export { formatEther, parseEther };
