import { useEffect, useState } from "react";

interface P { id: string; title: string }

/** Sidebar groups (Zotero-style tree): a group expands in place to show its panels. Panels in no group are
 *  listed at the top level after the groups; a group with one visible panel shows as that panel. */
export const NAV_GROUPS: { id: string; title: string; panels: string[]; labels?: Record<string, string> }[] = [
  { id: "g-today", title: "Today", panels: ["today"] },
  { id: "g-projects", title: "Projects", panels: ["projects", "writing"], labels: { projects: "Overview" } },
  { id: "g-meetings", title: "Meetings", panels: ["meetings", "weekly"] },
  { id: "g-story", title: "Story canvas", panels: ["story"] },
  { id: "g-reading", title: "Reading", panels: ["literature", "trends", "reading", "books", "audiobooks", "brain"], labels: { reading: "Papers" } },
  { id: "g-system", title: "System", panels: ["automation", "log"] },
];

const KEY = "nav:open";
/** Panels reachable by URL but not listed (Annotations now lives in Today as "Questions for you"). */
const HIDDEN = new Set(["annotations"]);
const load = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
};

export type Badge = { count: number; title: string; alert?: boolean };

function Dot({ b }: { b?: Badge }) {
  if (!b) return null;
  return <span className={`nav-badge${b.alert ? " alert" : ""}`} title={b.title} aria-label={b.title}>{b.count > 1 ? b.count : ""}</span>;
}

export function NavTree({ panels, current, onGo, flat = false, badges = {} }: { panels: P[]; current: string | undefined;
  onGo: (id: string) => void; flat?: boolean; badges?: Record<string, Badge> }) {
  const [open, setOpen] = useState<string[]>(load);
  panels = panels.filter((p) => !HIDDEN.has(p.id));
  const byId = new Map(panels.map((p) => [p.id, p]));
  const grouped = new Set(NAV_GROUPS.flatMap((g) => g.panels));
  const item = (p: P, label?: string, child = false) => (
    <button key={p.id} className={`${p.id === current ? "active" : ""}${child ? " nav-child" : ""}`}
      aria-current={p.id === current ? "page" : undefined} onClick={() => onGo(p.id)}>{label ?? p.title}<Dot b={badges[p.id]} /></button>
  );
  const save = (n: string[]) => { try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* private mode */ } };
  const toggle = (id: string) => setOpen((o) => { const n = o.includes(id) ? o.filter((x) => x !== id) : [...o, id]; save(n); return n; });
  // Going to a panel (link, Back, a shortcut) opens its group, like Zotero revealing the selected item.
  useEffect(() => {
    const g = NAV_GROUPS.find((x) => x.panels.length > 1 && current && x.panels.includes(current));
    if (g) setOpen((o) => { if (o.includes(g.id)) return o; const n = [...o, g.id]; save(n); return n; });
  }, [current]);
  if (flat) return <>{panels.map((p) => item(p))}</>;  // phone: one horizontal row, as before
  return (
    <>
      {NAV_GROUPS.map((g) => {
        const kids = g.panels.map((id) => byId.get(id)).filter((p): p is P => !!p);
        if (kids.length === 0) return null;
        if (kids.length === 1) return item(kids[0], g.panels.length === 1 ? g.title : undefined);  // e.g. viewers
        const hasCurrent = kids.some((p) => p.id === current);
        const isOpen = open.includes(g.id);
        return (
          <div key={g.id} className="nav-group">
            <button className={`nav-group-head${hasCurrent && !isOpen ? " active" : ""}`} aria-expanded={isOpen}
              onClick={() => toggle(g.id)}>
              <span className="nav-caret" aria-hidden>{isOpen ? "▾" : "▸"}</span>{g.title}
              {!isOpen && (() => {
                const bs = kids.map((p) => badges[p.id]).filter((x): x is Badge => !!x);
                return bs.length ? <Dot b={{ count: bs.reduce((a, x) => a + x.count, 0), title: bs.map((x) => x.title).join("\n"),
                  alert: bs.some((x) => x.alert) }} /> : null;
              })()}
            </button>
            {isOpen && kids.map((p) => item(p, g.labels?.[p.id], true))}
          </div>
        );
      })}
      {panels.filter((p) => !grouped.has(p.id)).map((p) => item(p))}
    </>
  );
}
