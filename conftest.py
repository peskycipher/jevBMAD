"""Pytest conveniences for this repo.

The skill-script test suites carry PEP 723 headers (`# /// script`) declaring
their dependencies, so the canonical zero-config run is::

    uv run <path/to/test_file>.py

Plain `pytest .agents/skills modules/bmad-jev` also works when the optional
test deps are installed (`pip install -r requirements-dev.txt`). This conftest
covers the in-between case: a suite whose PEP 723 dependencies are not
installed is SKIPPED with the install command in the reason, instead of
failing collection with a bare ImportError.
"""

import importlib
import re
import sys
from pathlib import Path

_PEP723_BLOCK = re.compile(r"^# /// script$(.*?)^# ///$", re.MULTILINE | re.DOTALL)
_DEPS_LINE = re.compile(r"^#\s*dependencies\s*=\s*\[(.*?)\]", re.MULTILINE | re.DOTALL)
# Each entry is a quoted requirement like "pytest>=8.0" or "ruamel.yaml";
# the import name is the part before the first version/extras marker.
# (Assumes import name == distribution name, true for this repo's deps.)
_DEP_NAME = re.compile(r"[\"\']([^\\\"\']+?)[\"\']")


def _unmet_deps(path: Path) -> list[str]:
    """Third-party imports a PEP 723 test file declares that cannot be imported."""
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return []
    block = _PEP723_BLOCK.search(head)
    if not block:
        return []
    deps_line = _DEPS_LINE.search(block.group(1))
    if not deps_line:
        return []
    unmet = []
    for match in _DEP_NAME.finditer(deps_line.group(1)):
        name = re.split(r"[<>=!~;\[]", match.group(1), maxsplit=1)[0].strip()
        try:
            importlib.import_module(name)
        except ImportError:
            unmet.append(name)
    return unmet


def pytest_ignore_collect(collection_path, config):
    """Skip (don't error) test modules whose declared PEP 723 deps are missing."""
    if collection_path.suffix != ".py" or not collection_path.name.startswith("test"):
        return None
    unmet = _unmet_deps(collection_path)
    if not unmet:
        return None
    rel = collection_path.relative_to(config.rootpath)
    print(f"SKIPPED {rel}: missing deps {unmet} — "
          f"run `uv run {rel}`, or `pip install -r requirements-dev.txt`")
    return True
