import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AlertGame } from './components/AlertGame';
import LegacyLabApp from './LegacyLabApp';
import './alert-game.css';

type Demo = 'alerts' | 'lab';

function demoFromLocation(): Demo {
  return new URLSearchParams(window.location.search).get('demo') === 'lab' ? 'lab' : 'alerts';
}

export default function App() {
  const [demo, setDemo] = useState<Demo>(demoFromLocation);

  useEffect(() => {
    const syncDemo = () => setDemo(demoFromLocation());
    window.addEventListener('popstate', syncDemo);
    return () => window.removeEventListener('popstate', syncDemo);
  }, []);

  function chooseDemo(nextDemo: Demo) {
    const url = new URL(window.location.href);
    if (nextDemo === 'lab') url.searchParams.set('demo', 'lab');
    else url.searchParams.delete('demo');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
    setDemo(nextDemo);
  }

  return (
    <div className={`app-shell app-shell--${demo}`}>
      <a className="skip-link" href={demo === 'lab' ? '#lab-demo-main' : '#alert-game-main'}>
        Skip to demo
      </a>
      <header className="app-header">
        <div className="wordmark">
          <Activity size={30} strokeWidth={2.1} aria-hidden="true" />
          <code>ai_decide</code>
          <span className="wordmark-divider" aria-hidden="true">
            /
          </span>
          <label className="demo-picker">
            <span className="sr-only">Choose demo</span>
            <select aria-label="Choose demo" value={demo} onChange={(event) => chooseDemo(event.target.value as Demo)}>
              <option value="alerts">device alerts</option>
              <option value="lab">lab operations</option>
            </select>
          </label>
        </div>
        <span className="synthetic-note">Real AI_DECIDE · synthetic scenarios</span>
      </header>
      {demo === 'lab' ? <LegacyLabApp /> : <AlertGame />}
    </div>
  );
}
