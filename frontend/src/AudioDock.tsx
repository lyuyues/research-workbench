import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { postJson } from "./common";

/** Audiobook playback that keeps going while the user switches panels: the <audio> lives in a dock at the bottom of
 *  the main area (rendered by App), not inside the Audiobooks panel. Audiobooks just calls play(). */

export interface Chapter { n: number; title: string; file: string; duration: number; ready: boolean }
export interface Book {
  slug: string; title: string; author: string; feed: "books" | "research"; lang: string; added: string;
  episodes: number; ready: number; hours: number; complete: boolean; feed_url: string | null;
  chapters: Chapter[];
}
export type Progress = Record<string, { file: string; pos: number; updated: string }>;
interface Now { book: Book; file: string; start: number }
interface Ctx { now: Now | null; play: (book: Book, file: string, start: number) => void; stop: () => void; saved: Progress;
  report: (slug: string, file: string, pos: number) => void }

const AudioCtx = createContext<Ctx>({ now: null, play: () => {}, stop: () => {}, saved: {}, report: () => {} });
export const useAudio = () => useContext(AudioCtx);

export function AudioProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState<Now | null>(null);
  const [saved, setSaved] = useState<Progress>({});
  const play = useCallback((book: Book, file: string, start: number) => setNow({ book, file, start }), []);
  const stop = useCallback(() => setNow(null), []);
  const report = useCallback((slug: string, file: string, pos: number) =>
    setSaved((p) => ({ ...p, [slug]: { file, pos, updated: new Date().toISOString() } })), []);
  return <AudioCtx.Provider value={{ now, play, stop, saved, report }}>{children}</AudioCtx.Provider>;
}

export const mmss = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
const fileUrl = (slug: string, file: string) => `/api/audiobooks/file/${encodeURIComponent(slug)}/${file}`;

/** The persistent player bar. Remembers the position on the server every 15 s / on pause, plays the next chapter. */
export function AudioDock() {
  const { now, play, stop, report } = useAudio();
  const audio = useRef<HTMLAudioElement>(null);
  const lastSave = useRef(0);
  const [speed, setSpeed] = useState(() => {
    try { return Number(localStorage.getItem("ab-speed")) || 1; } catch { return 1; }
  });
  const book = now?.book;
  const chapter = book?.chapters.find((c) => c.file === now!.file);
  const save = useCallback(() => {
    const a = audio.current;
    if (!a || !book || !chapter) return;
    lastSave.current = Date.now();
    report(book.slug, chapter.file, a.currentTime);
    void postJson("/api/audiobooks/progress", { slug: book.slug, file: chapter.file, pos: a.currentTime });
  }, [book, chapter, report]);
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    a.playbackRate = speed;
    try { localStorage.setItem("ab-speed", String(speed)); } catch { /* private mode */ }
  }, [speed]);
  useEffect(() => {
    const a = audio.current;
    if (!a || !now) return;
    const seek = () => { if (now.start > 0 && now.start < (a.duration || Infinity) - 2) a.currentTime = now.start; a.playbackRate = speed; };
    a.addEventListener("loadedmetadata", seek, { once: true });
    void a.play().catch(() => { /* autoplay blocked: user presses play */ });
    return () => a.removeEventListener("loadedmetadata", seek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now?.book.slug, now?.file, now?.start]);
  if (!book || !chapter) return null;
  const next = book.chapters.find((c) => c.n > chapter.n && c.ready);
  const prev = [...book.chapters].reverse().find((c) => c.n < chapter.n && c.ready);
  const skip = (d: number) => { const a = audio.current; if (a) a.currentTime = Math.max(0, a.currentTime + d); };
  return (
    <div className="audio-dock" role="region" aria-label="Audiobook player">
      <div className="ab-now">
        <div className="ab-title">🎧 {chapter.title}</div>
        <div className="muted small">{book.title}{book.author && ` · ${book.author}`} · {chapter.n}/{book.episodes}</div>
      </div>
      <audio ref={audio} src={fileUrl(book.slug, chapter.file)} controls preload="metadata"
        onTimeUpdate={() => { if (Date.now() - lastSave.current > 15000) save(); }}
        onPause={save}
        onEnded={() => { save(); if (next) play(book, next.file, 0); }} />
      <div className="ab-controls">
        <button className="ask" disabled={!prev} onClick={() => { save(); if (prev) play(book, prev.file, 0); }} aria-label="Previous chapter">⏮</button>
        <button className="ask" onClick={() => skip(-15)}>−15s</button>
        <button className="ask" onClick={() => skip(15)}>+15s</button>
        <button className="ask" disabled={!next} onClick={() => { save(); if (next) play(book, next.file, 0); }} aria-label="Next chapter">⏭</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
          {SPEEDS.map((x) => <option key={x} value={x}>{x}×</option>)}
        </select>
        <button className="linkish small" onClick={() => { save(); audio.current?.pause(); stop(); }} aria-label="Close player">✕</button>
      </div>
    </div>
  );
}
