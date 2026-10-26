
import MarketsPage from "./pages/MarketsPage";
import ConnectWallet from "./components/ConnectWallet";
import { WalletProvider } from "./wallet/WalletContext";

function App() {
  return (
    <WalletProvider>
      <header className="app-header">
        <ConnectWallet />
      </header>
      <MarketsPage />
    </WalletProvider>
  );
}

export default App;
