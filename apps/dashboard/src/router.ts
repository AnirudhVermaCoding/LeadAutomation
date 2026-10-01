import { useEffect, useState } from 'react';

/** Tiny pushState router: a handful of top-level pages doesn't need a routing library. */
export function navigate(to: string) {
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation() {
  const [location, setLocation] = useState(() => ({
    path: window.location.pathname,
    search: window.location.search,
  }));
  useEffect(() => {
    const update = () => setLocation({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return location;
}
