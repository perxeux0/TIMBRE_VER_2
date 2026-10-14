#!/usr/bin/env python3
"""Compara la salida del firmware (QEMU o placa real, por Serial) con Python.

Uso: python3 tools/check_crypto_vectors.py salida_serial.txt
Cada línea "CT|clave|valor" del firmware se recalcula aquí de forma independiente.
"""
import base64
import hashlib
import hmac
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

salt = bytes(range(16))
key = bytes(0xA0 + i for i in range(32))
iv = bytes(i * 3 for i in range(12))
pt = '{"format":"timbre-alba-config","v":1,"nombre":"Fin de descanso ñ"}'.encode()
aad = b"timbre-alba-backup-v1|timbre-01|2026-10-13T21:00:00"
ct_tag = AESGCM(key).encrypt(iv, pt, aad)

expected = {
    "pbkdf2_prueba_10000": hashlib.pbkdf2_hmac("sha256", b"prueba-pbkdf2", salt, 10000).hex(),
    # Vectores publicados (RFC 7914 §11 / pruebas estándar PBKDF2-HMAC-SHA256)
    "pbkdf2_rfc_1": "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
    "pbkdf2_rfc_4096": "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a",
    "hmac": hmac.new(b"clave-secreta-de-prueba-0123456789abcdef", b'{"v":1,"events":[]}', hashlib.sha256).hexdigest(),
    "gcm_enc_ok": "1",
    "gcm_ct": ct_tag[:-16].hex(),
    "gcm_tag": ct_tag[-16:].hex(),
    "gcm_dec_ok": "1",
    "gcm_tamper_rejected": "1",
    "b64": base64.b64encode(b"Timbre Alba").decode(),
    "ct_equal": "10",
    "rand_len": "32",
}
# Coherencia interna de los vectores fijos con hashlib
assert hashlib.pbkdf2_hmac("sha256", b"password", b"salt", 1).hex() == expected["pbkdf2_rfc_1"]
assert hashlib.pbkdf2_hmac("sha256", b"password", b"salt", 4096).hex() == expected["pbkdf2_rfc_4096"]

got = {}
for raw in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if raw.startswith("CT|"):
        _, k, v = raw.strip().split("|", 2)
        got[k] = v

fails = 0
for k, v in expected.items():
    status = "OK " if got.get(k) == v else "FALLA"
    fails += status != "OK "
    print(f"[{status}] {k}")
    if status != "OK ":
        print(f"        esperado {v}\n        obtenido {got.get(k)}")
print(f"(info) pbkdf2 1000 iteraciones en QEMU: {got.get('pbkdf2_1000_us_qemu')} us (no representa la placa real)")
print("RESULTADO:", "TODO COINCIDE" if fails == 0 and got.get("done") == "1" else f"{fails} diferencias")
sys.exit(1 if fails else 0)
