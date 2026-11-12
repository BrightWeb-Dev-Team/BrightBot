import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import packageInfo from '../package.json';

function CopyrightNotice() {
  return <footer className="global-copyright" aria-label="版权信息">
    <span>Powered By</span>
    <a href="https://github.com/BrightWeb-Dev-Team" target="_blank" rel="noreferrer">BrightWeb Dev Team</a>
    <a href="https://github.com/BrightWeb-Dev-Team/BrightBot" target="_blank" rel="noreferrer">BrightBot-v{packageInfo.version}</a>
  </footer>;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <CopyrightNotice />
  </React.StrictMode>,
);
