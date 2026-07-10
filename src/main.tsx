import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

const PRIMARY_HOST = 'arbiproseller.com';
const LOVABLE_HOSTS = ['repricer.lovable.app'];

// Hard-redirect lovable.app traffic to the primary domain so Google
// consolidates indexing on arbiproseller.com.
if (typeof window !== 'undefined' && LOVABLE_HOSTS.includes(window.location.hostname)) {
  const target = `https://${PRIMARY_HOST}${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(target);
}

// Ensure a per-route canonical pointing at arbiproseller.com is always present
// (overrides any stale or hard-coded canonical injected elsewhere).
const ensureCanonical = () => {
  if (typeof window === 'undefined') return;
  const canonicalHref = `https://${PRIMARY_HOST}${window.location.pathname}`;
  const existing = document.querySelectorAll('link[rel="canonical"]');
  existing.forEach((el) => el.parentNode?.removeChild(el));
  const link = document.createElement('link');
  link.rel = 'canonical';
  link.href = canonicalHref;
  document.head.appendChild(link);
};

const addSearchEngineMetaTag = () => {
  const onLovable = LOVABLE_HOSTS.includes(window.location.hostname);

  // On lovable.app: tell crawlers to drop it from the index but follow
  // links (which carry the canonical to arbiproseller.com). Elsewhere:
  // index normally.
  const robotsContent = onLovable ? 'noindex,follow' : 'index,follow,noarchive';

  const metaTag = document.createElement('meta');
  metaTag.name = 'googlebot';
  metaTag.content = robotsContent;
  document.head.appendChild(metaTag);

  const metaTag2 = document.createElement('meta');
  metaTag2.name = 'robots';
  metaTag2.content = robotsContent;
  document.head.appendChild(metaTag2);
};

addSearchEngineMetaTag();
ensureCanonical();

// Keep canonical in sync as the SPA navigates between routes.
if (typeof window !== 'undefined') {
  const patch = (key: 'pushState' | 'replaceState') => {
    const orig = history[key];
    history[key] = function (...args: Parameters<typeof orig>) {
      const ret = orig.apply(this, args);
      queueMicrotask(ensureCanonical);
      return ret;
    } as typeof orig;
  };
  patch('pushState');
  patch('replaceState');
  window.addEventListener('popstate', ensureCanonical);
}

createRoot(document.getElementById("root")!).render(<App />);
