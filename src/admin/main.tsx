/**
 * The admin dashboard's entry (dashboard.html): its own Vite page, so React, visx and every byte here stay out
 * of the game's bundle. It sends no analytics: the dashboard is internal and its views are not plays.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './dashboard.scss';

const root = document.getElementById('root');
if (!root) throw new Error('dashboard.html has no #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
