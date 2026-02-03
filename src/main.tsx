import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import AppProviders from './components/providers/AppProviders';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>
);
