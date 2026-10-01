import { AlertGame } from './components/AlertGame';
import LegacyLabApp from './LegacyLabApp';
import './alert-game.css';

export default function App() {
  return new URLSearchParams(window.location.search).get('demo') === 'lab' ? <LegacyLabApp /> : <AlertGame />;
}
