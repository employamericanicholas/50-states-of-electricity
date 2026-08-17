#!/usr/bin/env python3
"""
Static checks on the front-end asset wiring. Runs in CI; needs no browser.

The bug this exists to prevent: index.html loaded app.js?v=N, but app.js imported
"./charts.js" with no version. Browsers cache that import separately, so a fresh
app.js could load against a stale charts.js, the import would fail, and the page
would hang on "Loading EIA data" with NO console error — nothing inside the module
runs, so no try/catch can see it. Every internal module import must therefore
carry the same version as the entry point that pulls it in.

    python scripts/check_assets.py
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails: list[str] = []
checks = 0


def check(cond: bool, msg: str) -> None:
    global checks
    checks += 1
    if not cond:
        fails.append(msg)


def main() -> int:
    pages = sorted(ROOT.glob("*.html"))
    check(bool(pages), "no HTML pages found")

    versions: dict[str, set[str]] = {}
    entry_versions: set[str] = set()

    for page in pages:
        html = page.read_text(encoding="utf-8")
        refs = re.findall(r'(?:src|href)="\./(assets/[^"?]+)(\?v=(\d+))?"', html)
        for path, _, ver in refs:
            target = ROOT / path
            check(target.exists(), f"{page.name} references missing file {path}")
            # every js/css asset must be versioned, or a redeploy is served stale
            if path.endswith((".js", ".css")):
                check(bool(ver), f"{page.name} loads {path} with no ?v= — a redeploy "
                                 f"will be served from cache")
                if ver:
                    entry_versions.add(ver)
                    versions.setdefault(path, set()).add(ver)

    # every internal import inside a module must carry a version too, and it must
    # match the entry point's — this is the exact failure described above
    for js in sorted((ROOT / "assets" / "js").glob("*.js")):
        src = js.read_text(encoding="utf-8")
        for spec in re.findall(r'from\s+"(\./[^"]+)"', src):
            m = re.match(r"\./([^?]+)(?:\?v=(\d+))?$", spec)
            check(m is not None, f"{js.name}: unparsable import specifier {spec!r}")
            if not m:
                continue
            rel, ver = m.group(1), m.group(2)
            check((js.parent / rel).exists(), f"{js.name} imports missing file {rel}")
            check(bool(ver),
                  f"{js.name} imports './{rel}' with no ?v= — the browser caches this "
                  f"import separately, so a fresh {js.name} can load against a stale "
                  f"{rel} and fail at import time with no console error")
            if ver:
                check(ver in entry_versions,
                      f"{js.name} imports './{rel}?v={ver}' but no HTML page uses v={ver} "
                      f"(pages use {sorted(entry_versions)}) — bump them together")

    # one version across the whole site keeps the graph coherent
    check(len(entry_versions) <= 1,
          f"HTML pages reference several asset versions {sorted(entry_versions)}; "
          f"use one so a redeploy invalidates everything at once")

    # the loading placeholder needs its safety net, or a module failure hangs silently
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    check('id="boot"' in index, "index.html has no #boot loading placeholder")
    check("getElementById(\"boot\")" in index,
          "index.html has no fallback that rewrites #boot if the module never loads")

    # anything the scripts write to must exist in the page that loads them
    for page_name, script in (("index.html", "app.js"), ("emission-factors.html", "factors.js")):
        html = (ROOT / page_name).read_text(encoding="utf-8")
        src = (ROOT / "assets" / "js" / script).read_text(encoding="utf-8")
        for ident in sorted(set(re.findall(r'\$\("#([A-Za-z0-9_-]+)"\)', src))):
            check(f'id="{ident}"' in html,
                  f"{script} targets #{ident}, which {page_name} does not contain")

    print(f"{checks} checks run")
    for f in fails:
        print(f"  FAIL  {f}")
    if fails:
        print(f"\n{len(fails)} FAILURES")
        return 1
    print("\nAsset wiring OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
