import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    research_root: Path
    git_dir: Path
    claude_bin: str = "claude"
    static_dir: Path | None = None
    require_access_header: bool = False
    agent_timeout: float = 1800.0
    # Cloudflare Access (used only when require_access_header is on)
    access_team: str | None = None   # e.g. "myteam" -> https://myteam.cloudflareaccess.com
    access_aud: str | None = None    # Access application AUD tag
    access_email: str | None = None  # the owner: full access
    access_file: Path | None = None  # viewers (read-only, some panels): see roles.py
    allowed_origin: str = "https://research.example.com"
    study_root: Path | None = None  # study session data (read-only)
    study_files_root: Path | None = None  # mirror of the study files (read-only)
    oplog_path: Path | None = None  # default: <git_dir>/../oplog.jsonl
    state_dir: Path | None = None  # jobs/ + nextcloud.json; default: oplog's directory
    zotero_file: Path | None = None  # {"user_id", "api_key"} for the Reading panel's Zotero sync
    music_dir: Path | None = None  # background music (owner only); default ~/music
    google_file: Path | None = None  # read-only Google Docs/Calendar token (deploy/google_login.py)
    notion_file: Path | None = None  # {"token"} Notion integration for meeting-recap pushes (deploy/notion_login.py, OAuth)
    audiobook_root: Path | None = None  # ~/audiobooks (backend/audiobook.py); feed at /podcast/<token>/
    podcast_token_file: Path | None = None  # secret path segment for the podcast feed
    audiobook_python: str = "python3"  # venv with edge-tts + pymupdf, runs backend/paper_audio.py jobs

    @classmethod
    def from_env(cls) -> "Settings":
        static = os.environ.get("RP_STATIC_DIR")
        study = os.environ.get("RP_STUDY_ROOT")
        files = os.environ.get("RP_STUDY_FILES_ROOT")
        oplog = os.environ.get("RP_OPLOG")
        state = os.environ.get("RP_STATE_DIR")
        zot = os.environ.get("RP_ZOTERO_FILE") or str(Path.home() / ".config/research-platform/zotero.json")
        acl = os.environ.get("RP_ACCESS_FILE") or str(Path.home() / ".config/research-platform/access.json")
        return cls(
            research_root=Path(os.environ["RP_RESEARCH_ROOT"]),
            git_dir=Path(os.environ["RP_GIT_DIR"]),
            claude_bin=os.environ.get("RP_CLAUDE_BIN", "claude"),
            static_dir=Path(static) if static else None,
            require_access_header=os.environ.get("RP_REQUIRE_ACCESS") == "1",
            agent_timeout=float(os.environ.get("RP_AGENT_TIMEOUT", "1800")),
            access_team=os.environ.get("RP_ACCESS_TEAM") or None,
            access_aud=os.environ.get("RP_ACCESS_AUD") or None,
            access_email=os.environ.get("RP_ACCESS_EMAIL") or None,
            access_file=Path(acl),
            allowed_origin=os.environ.get("RP_ALLOWED_ORIGIN", "https://research.example.com"),
            study_root=Path(study) if study else None,
            study_files_root=Path(files) if files else None,
            oplog_path=Path(oplog) if oplog else None,
            state_dir=Path(state) if state else None,
            zotero_file=Path(zot),
            google_file=Path(os.environ.get("RP_GOOGLE_FILE") or str(Path.home() / ".config/research-platform/google.json")),
            notion_file=Path(os.environ.get("RP_NOTION_FILE") or str(Path.home() / ".config/research-platform/notion.json")),
            music_dir=Path(os.environ.get("RP_MUSIC_DIR") or str(Path.home() / "music")),
            audiobook_root=Path(os.environ.get("RP_AUDIOBOOK_ROOT") or str(Path.home() / "audiobooks")),
            podcast_token_file=Path(os.environ.get("RP_PODCAST_TOKEN_FILE")
                                    or str(Path.home() / ".config/research-platform/podcast_token")),
            audiobook_python=os.environ.get("RP_AUDIOBOOK_PYTHON") or str(Path.home() / "audiobooks/.venv/bin/python"),
        )
