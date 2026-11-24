import { useCallback, useEffect, useState } from "react";

/** Hash routes: #/<panel>/<sub>/<sub>… — every panel (and an open paper, a Literature tab, an open file) has its own
 * address, so the browser's Back/Forward and reload work and links can be bookmarked. Hash, not path, so the static
 * file server needs no SPA fallback. */
export interface Route { panel: string; rest: string[] }

const EVENT = "rp:route";

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  return { panel: parts[0] ?? "", rest: parts.slice(1) };
}

export const routeHash = (panel: string, rest: string[] = []) =>
  "#/" + [panel, ...rest].map((s) => encodeURIComponent(s)).join("/");

/** Go to a panel / sub-view. `replace` swaps the current history entry instead of adding one (e.g. a redirect). */
export function navigate(panel: string, rest: string[] = [], replace = false) {
  const h = routeHash(panel, rest);
  if (window.location.hash === h) return;
  if (replace) {
    window.history.replaceState(window.history.state, "", h);
    window.dispatchEvent(new Event(EVENT));
  } else {
    window.location.hash = h; // fires hashchange
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    window.addEventListener(EVENT, on);
    return () => { window.removeEventListener("hashchange", on); window.removeEventListener(EVENT, on); };
  }, []);
  return route;
}

/** A panel's own part of the address (after #/<panel>/). Setting it adds a history entry unless `replace`. */
export function useSubRoute(panel: string): [string[], (rest: string[], replace?: boolean) => void] {
  const route = useRoute();
  const set = useCallback((rest: string[], replace = false) => navigate(panel, rest, replace), [panel]);
  return [route.panel === panel ? route.rest : [], set];
}
