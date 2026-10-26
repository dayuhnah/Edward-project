// Contract interface for the dApp.
// Addresses and ABIs come from deployments.json and abis/*.json, which are written by
// prediction-market/scripts/deploy.js. Re-run the deploy script after changing contracts.
import { Contract, JsonRpcProvider, formatEther, isAddress, parseEther } from "ethers";
import type { ContractRunner, ContractTransactionResponse } from "ethers";
import deployments from "./deployments.json";
import marketFactoryAbi from "./abis/MarketFactory.json";
import marketAbi from "./abis/Market.json";
import outcomeTokenAbi from "./abis/OutcomeToken.json";

export { deployments };

export const EXPECTED_CHAIN_ID = deployments.chainId;
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? deployments.rpcUrl;

/** Read-only connection to the chain, works without a wallet. */
export const readProvider = new JsonRpcProvider(RPC_URL);

// ───────────── Market status (matches Market.status() in Market.sol) ─────────────
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

// ───────────── Contract objects ─────────────
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

// ───────────── Reading ─────────────
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

// ───────────── Writing (needs a wallet signer) ─────────────
/**
 * Buy shares. `slippageBps` = how much worse than the quote you accept (100 = 1%).
 * Returns the transaction; call `await tx.wait()` to wait for it to be mined.
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

/** Get your ETH back from an expired (never resolved) market. */
export function claimRefund(marketAddress: string, signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getMarket(marketAddress, signer).claimRefund();
}

/** Arbitrator only: declare the winning outcome after the end time. */
export function resolveMarket(marketAddress: string, outcomeId: number, signer: ContractRunner): Promise<ContractTransactionResponse> {
  return getMarket(marketAddress, signer).resolve(outcomeId);
}

// ───────────── Errors ─────────────
const contractInterfaces = [new Contract(deployments.factory, marketAbi).interface, new Contract(deployments.factory, outcomeTokenAbi).interface];

/** Turns a failed call into a short readable message, e.g. "MarketExpired" -> "Trading has ended for this market". */
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
};

export { formatEther, parseEther };
