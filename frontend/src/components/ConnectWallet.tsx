import { useEffect, useState } from "react";
import { useWallet } from "../wallet/WalletContext";
import { readProvider, formatEther } from "../contracts";
import "./ConnectWallet.css";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function ConnectWallet() {
  const { hasWallet, account, isCorrectNetwork, connecting, error, connect, switchNetwork, disconnect } = useWallet();
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    if (!account || !isCorrectNetwork) return;
    let cancelled = false;
    readProvider
      .getBalance(account)
      .then((b) => !cancelled && setBalance(Number(formatEther(b)).toFixed(3)))
      .catch(() => !cancelled && setBalance(null));
    return () => {
      cancelled = true;
    };
  }, [account, isCorrectNetwork]);

  if (!hasWallet) {
    return (
      <div className="wallet">
        <a className="wallet-button" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
          Install MetaMask
        </a>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="wallet">
        <button className="wallet-button" onClick={connect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect Wallet"}
        </button>
        {error && <span className="wallet-error">{error}</span>}
      </div>
    );
  }

  if (!isCorrectNetwork) {
    return (
      <div className="wallet">
        <span className="wallet-address">{short(account)}</span>
        <button className="wallet-button wrong-network" onClick={switchNetwork}>
          Wrong network – switch to Hardhat Local
        </button>
        {error && <span className="wallet-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="wallet">
      <span className="wallet-dot" aria-hidden="true" />
      <span className="wallet-address" title={account}>
        {short(account)}
      </span>
      {balance !== null && <span className="wallet-balance">{balance} ETH</span>}
      <button className="wallet-button secondary" onClick={disconnect}>
        Disconnect
      </button>
    </div>
  );
}
