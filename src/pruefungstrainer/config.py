"""Einstellungen: liegen in ~/.config/pruefungstrainer/config.json."""

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "pruefungstrainer"
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "pruefungstrainer"
CONFIG_FILE = CONFIG_DIR / "config.json"
DB_FILE = DATA_DIR / "fragen.sqlite3"


@dataclass
class Config:
    # Nur noch Startordner für Dateidialoge und Grundlage der Datenübernahme aus Version 1
    vault_path: str = ""
    last_dir: str = ""
    api_key: str = ""
    model: str = "claude-opus-5-5"
    questions_per_section: int = 5
    # Ordner im Vault, die ignoriert werden (z. B. Templates)
    ignore_dirs: str = ".obsidian, .trash, Templates"

    def effective_api_key(self) -> str:
        return self.api_key or os.environ.get("ANTHROPIC_API_KEY", "")

    def ignored(self) -> set[str]:
        return {d.strip() for d in self.ignore_dirs.split(",") if d.strip()}


def load() -> Config:
    try:
        data = json.loads(CONFIG_FILE.read_text())
    except (OSError, ValueError):
        return Config()
    known = Config.__dataclass_fields__
    return Config(**{k: v for k, v in data.items() if k in known})


def save(cfg: Config) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(asdict(cfg), indent=2))
    # Enthält ggf. den API-Key
    CONFIG_FILE.chmod(0o600)
