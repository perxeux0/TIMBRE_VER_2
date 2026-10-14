#!/usr/bin/env python3
"""
Herramienta de copias de seguridad de Timbre Alba (formato v1).

  Verificar una copia sin tocar el timbre:
      python3 tools/backup_tool.py verificar timbre-timbre-01-2026-10-13.json

Pide la frase sin mostrarla en pantalla y, si es correcta, muestra un resumen
(nunca imprime claves Wi-Fi ni la clave de Sheets). Sirve para comprobar que la
copia guardada en Drive de verdad se puede abrir ANTES de necesitarla.

Formato (igual al del firmware):
  clave = PBKDF2-HMAC-SHA256(frase, sal, iteraciones) -> 32 bytes
  datos = AES-256-GCM(clave, iv, texto JSON, AAD = "timbre-alba-backup-v1|equipo|fecha")
Requiere:  pip install cryptography
"""
import base64
import getpass
import hashlib
import json
import os
import sys

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD_PREFIX = "timbre-alba-backup-v1"


def aad_for(device: str, created: str) -> bytes:
    return f"{AAD_PREFIX}|{device}|{created}".encode()


def encrypt(config: dict, passphrase: str, device: str, created: str, by: str, fw: str, iterations: int = 20000) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, iterations)
    plain = json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode()
    ct_tag = AESGCM(key).encrypt(iv, plain, aad_for(device, created))
    return {
        "format": "timbre-alba-backup", "v": 1, "device": device, "createdAt": created, "createdBy": by, "fw": fw,
        "kdf": {"alg": "pbkdf2-sha256", "iter": iterations, "salt": salt.hex()},
        "cipher": {"alg": "aes-256-gcm", "iv": iv.hex(), "tag": ct_tag[-16:].hex()},
        "data": base64.b64encode(ct_tag[:-16]).decode(),
    }


def decrypt(backup: dict, passphrase: str) -> dict:
    if backup.get("format") != "timbre-alba-backup" or backup.get("v") != 1:
        raise ValueError("No es una copia de Timbre Alba (formato v1).")
    kdf, ci = backup["kdf"], backup["cipher"]
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), bytes.fromhex(kdf["salt"]), int(kdf["iter"]))
    ct = base64.b64decode(backup["data"]) + bytes.fromhex(ci["tag"])
    try:
        plain = AESGCM(key).decrypt(bytes.fromhex(ci["iv"]), ct, aad_for(backup.get("device", ""), backup.get("createdAt", "")))
    except InvalidTag:
        raise ValueError("Frase incorrecta o archivo alterado.") from None
    return json.loads(plain)


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "verificar":
        print(__doc__)
        return 2
    backup = json.load(open(sys.argv[2], encoding="utf-8"))
    try:
        cfg = decrypt(backup, getpass.getpass("Frase de la copia: "))
    except ValueError as e:
        print("ERROR:", e)
        return 1
    net = cfg.get("net", {})
    print("Copia VÁLIDA y sin alteraciones")
    print(f"  Creada:   {backup.get('createdAt') or 'sin fecha'} por {backup.get('createdBy')} (equipo {backup.get('device')}, v{backup.get('fw')})")
    print(f"  Red:      {net.get('apSsid')} · {net.get('apIp')} · red institucional: {net.get('staSsid') if net.get('staEn') else 'no'}")
    print(f"  Usuarios: " + ", ".join(f"{u['n']} ({'admin' if u['r'] == 0 else 'usuario'})" for u in cfg.get("users", [])))
    print(f"  Timbres:  {len(cfg.get('schedules', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
