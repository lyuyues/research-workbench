import { useEffect, useRef, useState } from "react";

/** Background music in the nav: lives outside the panels, so switching panels never stops it.
 * Remembers track, position and volume per browser; resumes where you left off. */

interface Track { name: string; file: string }

const KEY = "rp:music";
interface Saved { file?: string; pos?: Record<string, number>; vol?: number }

function load(): Saved {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Saved) ?? {}; } catch { return {}; }
}
function save(s: Saved) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00";
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function MusicPlayer() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(() => load().vol ?? 0.5);
  const audio = useRef<HTMLAudioElement>(null);
  const lastSave = useRef(0);

  useEffect(() => {
    fetch("/api/music").then((r) => (r.ok ? r.json() : [])).then((t: unknown) => {
      const list = Array.isArray(t) ? (t as Track[]) : [];
      setTracks(list);
      const want = load().file;
      setFile(list.find((x) => x.file === want)?.file ?? list[0]?.file ?? null);
    }).catch(() => setTracks([]));
  }, []);

  useEffect(() => { if (audio.current) audio.current.volume = vol; save({ ...load(), vol }); }, [vol]);

  if (!tracks.length || !file) return null;
  const a = () => audio.current;
  const remember = (t: number) => {
    const s = load();
    save({ ...s, file, pos: { ...(s.pos ?? {}), [file]: t } });
  };
  const toggle = () => {
    const el = a();
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const pick = (f: string) => {
    if (f === file) return;
    if (a()) remember(a()!.currentTime);
    setFile(f);
    setPlaying(false);
    save({ ...load(), file: f });
  };

  return (
    <div className="music" aria-label="Background music">
      <audio
        ref={audio}
        src={`/api/music/file?name=${encodeURIComponent(file)}`}
        preload="metadata"
        loop
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.volume = vol;
          setDur(el.duration);
          const p = load().pos?.[file];
          if (p && p < el.duration - 5) el.currentTime = p;
        }}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setTime(t);
          if (Math.abs(t - lastSave.current) > 5) { lastSave.current = t; remember(t); }
        }}
        onPlay={() => setPlaying(true)}
        onPause={(e) => { setPlaying(false); remember(e.currentTarget.currentTime); }}
      />
      <div className="music-row">
        <button className="music-play" onClick={toggle} aria-label={playing ? "Pause music" : "Play music"}
          title={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
        {tracks.length > 1 ? (
          <select className="music-name" value={file} onChange={(e) => pick(e.target.value)} aria-label="Track">
            {tracks.map((t) => <option key={t.file} value={t.file}>{t.name}</option>)}
          </select>
        ) : <span className="music-name" title={tracks[0].name}>{tracks[0].name}</span>}
      </div>
      <input className="music-seek" type="range" min={0} max={dur || 0} step={1} value={Math.min(time, dur || 0)}
        aria-label="Position" onChange={(e) => { const el = a(); if (el) el.currentTime = Number(e.target.value); }} />
      <div className="music-row small muted">
        <span>{fmt(time)} / {fmt(dur)}</span>
        <input className="music-vol" type="range" min={0} max={1} step={0.05} value={vol} aria-label="Volume"
          onChange={(e) => setVol(Number(e.target.value))} />
      </div>
    </div>
  );
}
