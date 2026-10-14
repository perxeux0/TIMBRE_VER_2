#!/usr/bin/env python3
"""
Genera firmware/Timbre_Alba_V2/web_assets.h a partir de la carpeta web/.

Por qué: el ESP32 sirve la interfaz desde su memoria flash. Comprimir con gzip
reduce ~70 % lo que viaja por el Wi-Fi (la antena de la SuperMini es débil) y
el ETag permite que el navegador reutilice su copia si nada cambió.

Uso (solo si modifica la interfaz):  python3 tools/build_web.py
"""
import gzip
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT = ROOT / "firmware" / "Timbre_Alba_V2" / "web_assets.h"

FILES = [("WEB_INDEX_GZ", "index.html"), ("WEB_CSS_GZ", "app.css"), ("WEB_JS_GZ", "app.js")]


def c_array(name: str, data: bytes) -> str:
    rows = []
    for i in range(0, len(data), 20):
        rows.append("  " + ",".join(f"0x{b:02x}" for b in data[i:i + 20]))
    return (f"static const uint8_t {name}[] PROGMEM = {{\n" + ",\n".join(rows) + "\n};\n"
            f"static const size_t {name}_LEN = {len(data)};\n")


def main() -> None:
    parts, digest, report = [], hashlib.sha256(), []
    for name, fname in FILES:
        raw = (WEB / fname).read_bytes()
        digest.update(raw)
        gz = gzip.compress(raw, compresslevel=9, mtime=0)  # mtime=0: salida reproducible
        parts.append(c_array(name, gz))
        report.append(f"{fname}: {len(raw):,} -> {len(gz):,} bytes")
    etag = digest.hexdigest()[:16]
    header = (
        "#pragma once\n"
        "// ARCHIVO GENERADO por tools/build_web.py - no editar a mano.\n"
        "// Fuente: carpeta web/ (index.html, app.css, app.js)\n"
        "#include <Arduino.h>\n"
        f'static const char WEB_ETAG[] = "\\"{etag}\\"";\n\n' + "\n".join(parts)
    )
    OUT.write_text(header, encoding="utf-8")
    print("\n".join(report))
    print(f"ETag {etag} -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
