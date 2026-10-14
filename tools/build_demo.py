#!/usr/bin/env python3
"""
Genera la carpeta demo/ (publicada en GitHub Pages) a partir de web/.

Por qué una copia generada y no la misma carpeta: el panel real usa rutas
absolutas (/app.js) y habla con el timbre; la demo necesita rutas relativas
(vive en /TIMBRE_VER_2/demo/) y un simulador de la API (demo-api.js) que
responde dentro del navegador. Así web/ sigue siendo la única fuente.

Uso:  python3 tools/build_demo.py
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB, SRC, OUT = ROOT / "web", ROOT / "tools" / "demo", ROOT / "demo"


def main() -> None:
    OUT.mkdir(exist_ok=True)
    html = (WEB / "index.html").read_text(encoding="utf-8")
    replacements = [
        ('<link rel="stylesheet" href="/app.css">',
         '<link rel="stylesheet" href="app.css">\n<link rel="stylesheet" href="demo.css">'),
        ('<script src="/app.js"></script>', '<script src="demo-api.js"></script>\n<script src="app.js"></script>'),
        ("<title>Timbre Alba</title>",
         '<title>Timbre Alba · Demostración</title>\n<meta name="robots" content="noindex">'),
    ]
    for old, new in replacements:
        if old not in html:
            raise SystemExit(f"No se encontró en web/index.html: {old}")
        html = html.replace(old, new)
    (OUT / "index.html").write_text(html, encoding="utf-8")
    for f in ("app.css", "app.js"):
        shutil.copy(WEB / f, OUT / f)
    for f in ("demo-api.js", "demo.css"):
        shutil.copy(SRC / f, OUT / f)
    print("demo/ generada:", ", ".join(sorted(p.name for p in OUT.iterdir())))


if __name__ == "__main__":
    main()
