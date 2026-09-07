import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { PrivacyProvider } from './lib/privacy.js';
import { SessionProvider } from './lib/session.js';
import { VaultProvider } from './lib/vault.js';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <PrivacyProvider>
          {/*
            Inside the session, because the vault status is an authenticated read and there
            is nothing to ask about before somebody is signed in.
          */}
          <VaultProvider>
            <App />
          </VaultProvider>
        </PrivacyProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
