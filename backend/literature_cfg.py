"""Literature panel settings: the editable part of literature-radar/config.yaml (keyword groups, tracked authors,
venues, research areas, look-back window). radar.py (weekly, Mondays) and the scoring prompt read the same file.

Edits are applied in place to a round-trip YAML document, so the file's other keys, order and comments survive;
items that stay keep their comments, new ones are appended at the end of their list."""
from __future__ import annotations

import io
import os
import re
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq

CONFIG = "literature-radar/config.yaml"
GROUP_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
AUTHOR_ID = re.compile(r"^\d{1,12}$")
TIERS = ("S", "A", "B", "self")
BASE_PROJECTS = ("all", "cross")
MAX_GROUPS, MAX_AUTHORS, MAX_VENUES, MAX_AREAS = 30, 60, 120, 20


def _yaml() -> YAML:
    y = YAML()  # round-trip; layout close to the PyYAML dump radar.py writes (80 cols, explicit null)
    y.indent(mapping=2, sequence=4, offset=2)
    y.width = 80
    y.preserve_quotes = True
    y.representer.add_representer(type(None), lambda r, _: r.represent_scalar("tag:yaml.org,2002:null", "null"))
    return y


def _text(v: object, n: int) -> str:
    return re.sub(r"\s+", " ", str(v if v is not None else "")).strip()[:n]


class LiteratureConfig:
    def __init__(self, research_root: Path):
        self.path = Path(research_root) / CONFIG

    def _load(self) -> CommentedMap:
        try:
            doc = _yaml().load(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ValueError("literature-radar/config.yaml not found")
        if not isinstance(doc, dict):
            raise ValueError("config.yaml is not a mapping")
        return doc

    def projects(self, doc: CommentedMap) -> list[str]:
        prof = (doc.get("research_profile") or {}).get("projects") or {}
        return [*BASE_PROJECTS, *[str(k) for k in prof]]

    def view(self) -> dict:
        doc = self._load()
        groups = [{"id": str(k), "query": str((v or {}).get("query", "")), "project": str((v or {}).get("project", "all"))}
                  for k, v in (doc.get("keyword_groups") or {}).items()]
        authors = [{"name": str(a.get("name", "")), "id": "" if a.get("id") is None else str(a.get("id")),
                    "tier": str(a.get("tier", "A"))} for a in doc.get("tracked_authors") or [] if isinstance(a, dict)]
        venues = doc.get("venues") or {}
        return {"keyword_groups": groups, "tracked_authors": authors,
                "venues": {"tier1": [str(v) for v in venues.get("tier1") or []], "tier2": [str(v) for v in venues.get("tier2") or []]},
                "areas": [str(a) for a in (doc.get("research_profile") or {}).get("areas") or []],
                "lookback_days": int((doc.get("discovery") or {}).get("lookback_days", 7)),
                "projects": self.projects(doc), "tiers": list(TIERS)}

    @staticmethod
    def validate(cfg: dict, projects: list[str]) -> dict:
        """Normalized settings, or ValueError with a message the panel can show."""
        if not isinstance(cfg, dict):
            raise ValueError("settings must be an object")
        groups, seen = [], set()
        for g in cfg.get("keyword_groups") or []:
            query = _text(g.get("query"), 200)
            gid = _text(g.get("id"), 32).lower() or re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")[:32]
            if not query:
                raise ValueError(f"keyword group {gid or '(new)'} needs a search query")
            if len(query.split()) < 2:
                raise ValueError(f"keyword group {gid!r}: use at least 2 words — the radar keeps a paper only when "
                                 "2 or more words of a group appear in its title/abstract")
            if not GROUP_ID.match(gid) or gid in seen:
                raise ValueError(f"bad or duplicate keyword group name {gid!r} (lowercase letters, digits, - or _)")
            project = _text(g.get("project"), 40) or "all"
            if project not in projects:
                raise ValueError(f"keyword group {gid!r}: project must be one of {projects}")
            seen.add(gid)
            groups.append({"id": gid, "query": query, "project": project})
        if not groups:
            raise ValueError("keep at least one keyword group")
        if len(groups) > MAX_GROUPS:
            raise ValueError(f"at most {MAX_GROUPS} keyword groups (each is one search per week)")
        authors, names = [], set()
        for a in cfg.get("tracked_authors") or []:
            name = _text(a.get("name"), 80)
            if not name:
                raise ValueError("every tracked author needs a name")
            if name.lower() in names:
                raise ValueError(f"author {name!r} is listed twice")
            aid = _text(a.get("id"), 12)
            if aid and not AUTHOR_ID.match(aid):
                raise ValueError(f"author {name!r}: Semantic Scholar ID must be digits (or leave it blank)")
            tier = _text(a.get("tier"), 8) or "A"
            if tier not in TIERS:
                raise ValueError(f"author {name!r}: tier must be one of {TIERS}")
            names.add(name.lower())
            authors.append({"name": name, "id": aid or None, "tier": tier})
        if len(authors) > MAX_AUTHORS:
            raise ValueError(f"at most {MAX_AUTHORS} tracked authors")

        def strings(xs: object, n: int, label: str, cap: int) -> list[str]:
            out: list[str] = []
            for x in xs or []:
                s = _text(x, n)
                if s and s not in out:
                    out.append(s)
            if len(out) > cap:
                raise ValueError(f"at most {cap} {label}")
            return out
        v = cfg.get("venues") or {}
        venues = {"tier1": strings(v.get("tier1"), 120, "tier-1 venues", MAX_VENUES),
                  "tier2": strings(v.get("tier2"), 120, "tier-2 venues", MAX_VENUES)}
        both = set(venues["tier1"]) & set(venues["tier2"])
        if both:
            raise ValueError(f"venue in both tiers: {sorted(both)[0]!r}")
        areas = strings(cfg.get("areas"), 160, "research areas", MAX_AREAS)
        try:
            lookback = int(cfg.get("lookback_days", 7))
        except (TypeError, ValueError):
            raise ValueError("look-back days must be a number")
        if not 1 <= lookback <= 60:
            raise ValueError("look-back days must be between 1 and 60")
        return {"keyword_groups": groups, "tracked_authors": authors, "venues": venues, "areas": areas, "lookback_days": lookback}

    @staticmethod
    def _merge_strings(seq: CommentedSeq | None, new: list[str]) -> CommentedSeq:
        """Keep surviving items (and their comments) in place, drop removed ones, append new ones."""
        if not isinstance(seq, CommentedSeq):
            return CommentedSeq(new)
        for i in range(len(seq) - 1, -1, -1):
            if str(seq[i]) not in new:
                del seq[i]
        have = {str(x) for x in seq}
        seq.extend(s for s in new if s not in have)
        return seq

    def save(self, cfg: dict) -> dict:
        doc = self._load()
        clean = self.validate(cfg, self.projects(doc))

        groups = doc.get("keyword_groups")
        if not isinstance(groups, CommentedMap):
            groups = doc["keyword_groups"] = CommentedMap()
        new_ids = [g["id"] for g in clean["keyword_groups"]]
        for k in [k for k in groups if k not in new_ids]:
            del groups[k]
        for g in clean["keyword_groups"]:
            cur = groups.get(g["id"])
            if isinstance(cur, CommentedMap):
                cur["query"], cur["project"] = g["query"], g["project"]
            else:
                groups[g["id"]] = CommentedMap(query=g["query"], project=g["project"])

        old = {str(a.get("name", "")).lower(): a for a in doc.get("tracked_authors") or [] if isinstance(a, dict)}
        authors = doc.get("tracked_authors")
        if not isinstance(authors, CommentedSeq):
            authors = doc["tracked_authors"] = CommentedSeq()
        keep = {a["name"].lower() for a in clean["tracked_authors"]}
        for i in range(len(authors) - 1, -1, -1):
            if not isinstance(authors[i], dict) or str(authors[i].get("name", "")).lower() not in keep:
                del authors[i]
        for a in clean["tracked_authors"]:
            cur = old.get(a["name"].lower())
            if cur is not None and cur in authors:
                if str(cur.get("id") or "") != str(a["id"] or ""):
                    cur["id"] = a["id"]  # None → radar.py resolves it by name on the next run
                cur["tier"] = a["tier"]
            else:
                authors.append(CommentedMap(name=a["name"], id=a["id"], tier=a["tier"]))

        venues = doc.get("venues")
        if not isinstance(venues, CommentedMap):
            venues = doc["venues"] = CommentedMap()
        for t in ("tier1", "tier2"):
            venues[t] = self._merge_strings(venues.get(t), clean["venues"][t])
        prof = doc.get("research_profile")
        if not isinstance(prof, CommentedMap):
            prof = doc["research_profile"] = CommentedMap()
        prof["areas"] = self._merge_strings(prof.get("areas"), clean["areas"])
        disc = doc.get("discovery")
        if not isinstance(disc, CommentedMap):
            disc = doc["discovery"] = CommentedMap()
        disc["lookback_days"] = clean["lookback_days"]

        buf = io.StringIO()
        _yaml().dump(doc, buf)
        tmp = self.path.with_suffix(".yaml.tmp")
        tmp.write_text(buf.getvalue(), encoding="utf-8")
        os.replace(tmp, self.path)
        return self.view()
