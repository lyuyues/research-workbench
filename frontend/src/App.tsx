import { useEffect, useRef, useState } from "react";
import { NavTree } from "./Nav";
import type { Badge } from "./Nav";
import { Books } from "./Books";
import { AgentChat } from "./AgentChat";
import type { Attachment } from "./AgentChat";
import { Story } from "./Story";
import { SystemLog } from "./SystemLog";
import { Automation } from "./Automation";
import { Today } from "./Today";
import { Projects } from "./Projects";
import { Literature } from "./Literature";
import { Trends } from "./Trends";
import { Reading } from "./Reading";
import { Brain } from "./Brain";
import { Audiobooks } from "./Audiobooks";
import { Meetings } from "./Meetings";
import { Annotations } from "./Annotations";
import { Writing } from "./Writing";
import { Weekly } from "./Weekly";
import { FileView, resolveLink, Toasts } from "./common";
import { LivePdf } from "./LivePdf";
import { Splitter, useColumnWidths } from "./Splitter";
import { MusicPlayer } from "./MusicPlayer";
import { AudioDock, AudioProvider } from "./AudioDock";
import { navigate, useRoute } from "./route";

interface Panel { id: string; title: string; phase: number; ready?: boolean }

const MOBILE = "(max-width: 900px)";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof matchMedia === "function" && matchMedia(MOBILE).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(MOBILE);
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

// Keeps the drawer above the on-screen keyboard: iOS Safari ignores
// interactive-widget=resizes-content, so size from the visual viewport instead.
function useVisualViewportVars() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--vv-h", `${vv.height}px`);
      root.style.setProperty("--vv-bottom", `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, []);
}

type PanelsState = { status: "loading" } | { status: "ok"; panels: Panel[] } | { status: "error"; message: string };

export default function App() {
  // #/pdf/<project>: stand-alone live PDF page for a second screen (no sidebar)
  const pdfMatch = /^#\/pdf\/([A-Za-z][\w-]*)\b/.exec(window.location.hash);
  if (pdfMatch) return <LivePdf project={pdfMatch[1]} />;
  return <MainApp />;
}

function MainApp() {
  const [panels, setPanels] = useState<PanelsState>({ status: "loading" });
  // Viewers (colleagues): read-only, no agent. The server enforces this; the UI just hides what they can't use.
  const [me, setMe] = useState<{ email: string | null; role: string } | null>(null);
  const readOnly = me?.role === "viewer";
  // Sidebar dots: things waiting for the user (backend/badges.py). Refreshed every 5 min and on every panel switch.
  const [badges, setBadges] = useState<Record<string, Badge>>({});
  // The address says where we are (#/<panel>/…), so Back/Forward and reload work.
  const route = useRoute();
  const active = route.panel || "today";
  useEffect(() => {
    if (readOnly || !me) return;
    let stop = false;
    const load = async () => {
      if (active === "today" || active === "internships") {
        await fetch("/api/badges/seen", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ panel: active }) }).catch(() => undefined);
      }
      const r = await fetch("/api/badges").catch(() => null);
      if (!stop && r?.ok) setBadges(await r.json() as Record<string, Badge>);
    };
    void load();
    const t = window.setInterval(() => void load(), 5 * 60_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [active, readOnly, me]);
  const go = (panel: string) => navigate(panel);
  const [drawer, setDrawer] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const ask = (label: string, text: string) => { setAttachment({ label, text }); setDrawer(true); };
  const [preset, setPreset] = useState<{ text: string; n: number; send?: boolean } | null>(null);
  const prompt = (text: string) => { setPreset((p) => ({ text, n: (p?.n ?? 0) + 1 })); setDrawer(true); };
  const run = (text: string) => { setPreset((p) => ({ text, n: (p?.n ?? 0) + 1, send: true })); setDrawer(true); };
  // Inline reply under a card: attach the card as context and send the reply right away.
  const reply = (label: string, context: string, text: string) => {
    setAttachment({ label, text: context });
    setPreset((p) => ({ text, n: (p?.n ?? 0) + 1, send: true }));
    setDrawer(true);
  };
  // A markdown file opened from a link is part of the address too (#/<panel>/~file/<path>[/<anchor>]).
  const viewer = route.rest[0] === "~file" && route.rest[1] ? { path: route.rest[1], anchor: route.rest[2] ?? null } : null;
  const pushedViewer = useRef(false);
  const setViewer = (t: { path: string; anchor: string | null } | null) => {
    if (t) { pushedViewer.current = true; navigate(active, ["~file", t.path, ...(t.anchor ? [t.anchor] : [])]); return; }
    if (!viewer) return;
    if (pushedViewer.current) { pushedViewer.current = false; window.history.back(); } else navigate(active);
  };
  // Relative links inside rendered markdown open in the in-app viewer instead of navigating away.
  const onMainClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    const base = (a.closest("[data-base]") as HTMLElement | null)?.dataset.base;
    if (base === undefined) return;
    if (href.startsWith("#")) return;
    const target = resolveLink(href, base);
    if (!target) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noreferrer"); return; }
    e.preventDefault();
    setViewer(target);
  };
  const aside = useRef<HTMLElement>(null);
  const mobile = useIsMobile();
  const hidden = mobile && !drawer;
  const [widths, setWidths] = useColumnWidths();
  useVisualViewportVars();

  useEffect(() => {
    const onNav = (e: Event) => navigate(String((e as CustomEvent).detail));
    window.addEventListener("rp:navigate", onNav);
    return () => window.removeEventListener("rp:navigate", onNav);
  }, []);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((m: unknown) => setMe(m && typeof m === "object" && !Array.isArray(m) ? m as { email: string | null; role: string } : null))
      .catch(() => setMe(null));
    fetch("/api/panels")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: unknown = await r.json();
        if (!Array.isArray(data)) throw new Error("unexpected response format");
        setPanels({ status: "ok", panels: data as Panel[] });
      })
      .catch((e: unknown) => {
        const why = e instanceof Error && e.message.startsWith("HTTP") ? e.message : `network error: ${String(e)}`;
        setPanels({ status: "error", message: `Could not load (${why}) — you may need to sign in again` });
      });
  }, []);

  // React 18 has no `inert` prop: set the attribute by hand, then move focus into the drawer.
  useEffect(() => {
    const el = aside.current;
    if (!el) return;
    el.toggleAttribute("inert", hidden);
    if (mobile && drawer) el.querySelector("textarea")?.focus();
  }, [hidden, mobile, drawer]);

  const list = panels.status === "ok" ? panels.panels : [];
  const current = list.find((p) => p.id === active) ?? (readOnly ? list[0] : undefined);
  useEffect(() => { document.title = current ? `${current.title} · Research` : "Research"; }, [current]);

  return (
    <AudioProvider>
    <div className={`layout${readOnly ? " readonly" : ""}`}
      style={{ "--nav-w": `${widths.nav}px`, "--agent-w": `${widths.agent}px` } as React.CSSProperties}>
      {!mobile && <Splitter side="nav" widths={widths} onChange={setWidths} />}
      {!mobile && !readOnly && <Splitter side="agent" widths={widths} onChange={setWidths} />}
      <nav className="nav">
        <div className="brand">Research</div>
        <NavTree panels={list} current={current?.id} flat={mobile} badges={badges}
          onGo={(id) => { pushedViewer.current = false; go(id); }} />
        {!readOnly && me && <MusicPlayer />}
        {readOnly && <p className="muted viewer-note">Read-only view shared by the user{me?.email ? ` · signed in as ${me.email}` : ""}</p>}
      </nav>
      <main className="main" onClick={onMainClick}>
        {panels.status === "error" ? (
          <p className="error" role="alert">{panels.message}</p>
        ) : (
          <>
            <h1>{current?.title ?? ""}</h1>
            {viewer && (
              <div className="viewer">
                <FileView path={viewer.path} anchor={viewer.anchor} onClose={() => setViewer(null)} />
              </div>
            )}
            {viewer ? null
              : current?.id === "story" ? <Story onAsk={ask} onPrompt={prompt} />
              : current?.id === "today" ? <Today onAsk={ask} onPrompt={prompt} onReply={reply} onRun={run} />
              : current?.id === "projects" ? <Projects onAsk={ask} onPrompt={prompt} />
              : current?.id === "literature" ? <Literature onAsk={ask} onPrompt={prompt} />
              : current?.id === "trends" ? <Trends onAsk={ask} onPrompt={prompt} onReply={reply} />
              : current?.id === "reading" ? <Reading onAsk={ask} onPrompt={prompt} />
              : current?.id === "books" ? <Books onAsk={ask} onPrompt={prompt} />
              : current?.id === "audiobooks" ? <Audiobooks />
              : current?.id === "brain" ? <Brain />
              : current?.id === "annotations" ? <Annotations onAsk={ask} onPrompt={prompt} />
              : current?.id === "writing" ? <Writing onAsk={ask} onPrompt={prompt} readOnly={readOnly} />
              : current?.id === "meetings" ? <Meetings onAsk={ask} onPrompt={prompt} onReply={reply} />
              : current?.id === "weekly" ? <Weekly onAsk={ask} onPrompt={prompt} />
              : current?.id === "log" ? <SystemLog />
              : current?.id === "automation" ? <Automation />
              : current && <p className="muted">This panel arrives in Phase {current.phase}. For now, ask the agent on the right.</p>}
          </>
        )}
        {!readOnly && <AudioDock />}
        <Toasts />
      </main>
      {!readOnly && <aside id="agent-drawer" ref={aside} className={`agent ${drawer ? "open" : ""}`} aria-hidden={hidden || undefined}>
        <AgentChat panel={active} attachment={attachment} preset={preset} onDetach={() => setAttachment(null)}
          onClose={() => setDrawer(false)} />
      </aside>}
      {/* Only while closed: when open it would sit on top of Send/Stop. */}
      {!drawer && !readOnly && (
        <button className="drawer-toggle" onClick={() => setDrawer(true)} aria-expanded="false" aria-controls="agent-drawer">
          Agent
        </button>
      )}
    </div>
    </AudioProvider>
  );
}
