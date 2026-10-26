// Wallet connection (MetaMask or any injected wallet), shared with the whole app.
//
// Use it in any component:
//   const { account, signer, isCorrectNetwork, connect } = useWallet();
//   if (signer) await buyShares(market, 0, "0.1", signer);
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { BrowserProvider } from "ethers";
import type { JsonRpcSigner } from "ethers";
import { EXPECTED_CHAIN_ID, RPC_URL } from "../contracts";

type WalletState = {
  /** True if the browser has a wallet extension (e.g. MetaMask). */
  hasWallet: boolean;
  account: string | null;
  chainId: number | null;
  isCorrectNetwork: boolean;
  /** Ready to send transactions: connected AND on the right network. */
  signer: JsonRpcSigner | null;
  connecting: boolean;
  error: string;
  connect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  disconnect: () => void;
};

const WalletContext = createContext<WalletState | null>(null);

const CHAIN_HEX = "0x" + EXPECTED_CHAIN_ID.toString(16);
const NETWORK_PARAMS = {
  chainId: CHAIN_HEX,
  chainName: EXPECTED_CHAIN_ID === 31337 ? "Hardhat Local" : `Chain ${EXPECTED_CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [RPC_URL],
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [signerFor, setSignerFor] = useState<{ account: string; signer: JsonRpcSigner } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [userDisconnected, setUserDisconnected] = useState(false);

  const isCorrectNetwork = chainId === EXPECTED_CHAIN_ID;

  // Get a signer for the connected account (only usable on the right network).
  useEffect(() => {
    if (!eth || !account || !isCorrectNetwork) return;
    let cancelled = false;
    new BrowserProvider(eth)
      .getSigner(account)
      .then((s) => !cancelled && setSignerFor({ account, signer: s }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [eth, account, isCorrectNetwork]);
  const signer = signerFor && signerFor.account === account && isCorrectNetwork ? signerFor.signer : null;

  // Pick up an existing connection on page load, and react to changes in the wallet.
  useEffect(() => {
    if (!eth) return;
    const onAccounts = (accs: unknown) => {
      const list = accs as string[];
      setAccount(list.length ? list[0] : null);
    };
    const onChain = (id: unknown) => setChainId(Number(id as string));

    eth.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    if (!userDisconnected) eth.request({ method: "eth_accounts" }).then(onAccounts).catch(() => {});

    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [eth, userDisconnected]);

  const switchNetwork = useCallback(async () => {
    if (!eth) return;
    setError("");
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    } catch (e) {
      // 4902 = the wallet doesn't know this network yet, so add it
      if ((e as { code?: number }).code === 4902) {
        try {
          await eth.request({ method: "wallet_addEthereumChain", params: [NETWORK_PARAMS] });
        } catch {
          setError("Could not add the network to your wallet");
        }
      } else {
        setError("Please switch your wallet to the Hardhat Local network");
      }
    }
  }, [eth]);

  const connect = useCallback(async () => {
    if (!eth) {
      setError("No wallet found. Install MetaMask to trade.");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      const accs = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      setUserDisconnected(false);
      setAccount(accs[0] ?? null);
      const id = Number((await eth.request({ method: "eth_chainId" })) as string);
      setChainId(id);
      if (id !== EXPECTED_CHAIN_ID) await switchNetwork();
    } catch (e) {
      setError((e as { code?: number }).code === 4001 ? "Connection request was rejected" : "Could not connect wallet");
    } finally {
      setConnecting(false);
    }
  }, [eth, switchNetwork]);

  // Wallets can't be disconnected from a website; we just forget the account in this tab.
  const disconnect = useCallback(() => {
    setUserDisconnected(true);
    setAccount(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({ hasWallet: !!eth, account, chainId, isCorrectNetwork, signer, connecting, error, connect, switchNetwork, disconnect }),
    [eth, account, chainId, isCorrectNetwork, signer, connecting, error, connect, switchNetwork, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
