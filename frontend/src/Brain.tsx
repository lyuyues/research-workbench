import { useEffect, useRef, useState } from "react";
import { postJson, useJson } from "./common";

interface ImportStatus {
  running: boolean;
  error: string | null;
  zotero_configured: boolean;
  last: { timestamp: string | null; new_highlights: number; new_sources: number; updated?: number; removed?: number };
}

/** Brain = the 3D concept map (frontend/public/brain/, a standalone page on /api/brain/...), embedded full-size,
 *  plus a "Refresh from Zotero" action (the same import the daily job runs). */
export function Brain() {
  const status = useJson<ImportStatus>("/api/brain/import");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  const poll = () => {
    timer.current = window.setInterval(async () => {
      try {
        const s = (await (await fetch("/api/brain/import")).json()) as ImportStatus;
        if (s.running) return;
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        setBusy(false);
        status.reload();
        if (s.error) setMsg(`Refresh failed: ${s.error}`);
        else {
          setMsg(`Refreshed: +${s.last.new_highlights} highlights, +${s.last.new_sources} sources`);
          setFrameKey((k) => k + 1);
        }
      } catch { /* keep polling */ }
    }, 3000);
  };

  const refresh = async () => {
    setMsg(null);
    setBusy(true);
    const err = await postJson("/api/brain/import", {});
    if (err) { setBusy(false); setMsg(`Refresh failed: ${err}`); return; }
    poll();
  };

  const s = status.data;
  const last = s?.last.timestamp ? new Date(s.last.timestamp).toLocaleString() : "never";
  return (
    <div className="brain-panel">
      <div className="brain-bar">
        <button onClick={refresh} disabled={busy || s?.running || s?.zotero_configured === false}
          title={s?.zotero_configured === false ? "Zotero is not configured on the server" : "Import new Zotero highlights and notes"}>
          {busy || s?.running ? "Refreshing…" : "Refresh from Zotero"}
        </button>
        <span className="muted small">Last import: {last}</span>
        {msg && <span className="small" role="status">{msg}</span>}
        <a className="small" href="/brain/index.html" target="_blank" rel="noopener">Open in a new tab</a>
      </div>
      <iframe key={frameKey} src="/brain/index.html" title="Brain" className="brain-frame" />
    </div>
  );
}
