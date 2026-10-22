import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PresenterView } from './PresenterView';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const params = new URLSearchParams(location.search);
const sessionId = params.get('session');

createRoot(root).render(
  params.get('presenter') === '1' && sessionId ? (
    <PresenterView sessionId={sessionId} />
  ) : (
    <App />
  )
);
