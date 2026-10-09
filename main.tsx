import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import NasGate from './NasGate';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><NasGate><App /></NasGate></StrictMode>,
);