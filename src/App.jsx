import React, { useMemo, useState } from 'react';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { SgdxVault } from './components/SgdxVault';
import { RPC_URL } from './config';

function CustomWalletConnectButton() {
  const { select, wallets, publicKey, disconnect, connected, connecting } = useWallet();
  const [showModal, setShowModal] = useState(false);

  const truncatedPubkey = useMemo(() => {
    if (!publicKey) return '';
    const str = publicKey.toBase58();
    return `${str.slice(0, 4)}...${str.slice(-4)}`;
  }, [publicKey]);

  if (connected && publicKey) {
    return (
      <button className="custom-wallet-btn connected" onClick={() => disconnect()}>
        <span className="wallet-dot" /> {truncatedPubkey} (Disconnect)
      </button>
    );
  }

  return (
    <>
      <button
        className="custom-wallet-btn"
        onClick={() => setShowModal(true)}
        disabled={connecting}
      >
        {connecting ? 'Connecting...' : 'Connect Wallet'}
      </button>

      {showModal && (
        <div className="wallet-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="wallet-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="wallet-modal-header">
              <h3>Select Wallet</h3>
              <button className="modal-close-btn" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="wallet-options-list">
              {wallets.map((wallet) => (
                <button
                  key={wallet.adapter.name}
                  className="wallet-option-item"
                  onClick={async () => {
                    setShowModal(false);
                    try {
                      select(wallet.adapter.name);
                    } catch (e) {
                      console.warn('Wallet select error:', e);
                    }
                  }}
                >
                  {wallet.adapter.icon && (
                    <img
                      src={wallet.adapter.icon}
                      alt={wallet.adapter.name}
                      className="wallet-icon"
                    />
                  )}
                  <span>{wallet.adapter.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function App() {
  const endpoint = useMemo(() => RPC_URL, []);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <div className="standalone-app-root">
          {/* Top Standalone Header Navbar */}
          <header className="standalone-header">
            <div className="header-container">
              <div className="brand-logo">
                <span className="flag">🇸🇬</span>
                <div className="brand-text">
                  <span className="brand-title">SGDX Vault</span>
                  <span className="brand-subtitle">Solana Devnet Stablecoin Platform</span>
                </div>
              </div>
              <div className="header-actions">
                <div className="network-badge">🟢 Devnet</div>
                <CustomWalletConnectButton />
              </div>
            </div>
          </header>

          {/* Main Application Container */}
          <main className="standalone-main">
            <SgdxVault />
          </main>

          {/* Footer */}
          <footer className="standalone-footer">
            <div className="footer-container">
              <p>SGDX Vault Platform · Token-2022 Stablecoin Protocol · Pyth Live Oracle Feed</p>
            </div>
          </footer>
        </div>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default App;
