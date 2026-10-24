import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LocaleProvider } from './i18n';
import { PresenterView } from './PresenterView';
import { ThemeProvider } from './theme';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const params = new URLSearchParams(location.search);
const sessionId = params.get('session');

createRoot(root).render(
  <LocaleProvider>
    {params.get('presenter') === '1' && sessionId ? (
      <PresenterView sessionId={sessionId} />
    ) : (
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )}
  </LocaleProvider>
);
