#pragma once
// =====================================================================
//  Primitivas criptográficas de Timbre Alba (mbedtls del ESP32).
//  Separadas en su propio archivo para poder probarlas de forma aislada
//  (tools/qemu_crypto_test) contra Python y Apps Script.
// =====================================================================
#include <Arduino.h>
#include <mbedtls/md.h>
#include <mbedtls/gcm.h>
#include <esp_random.h>

// =====================================================================
//  Utilidades: hex, aleatorios, comparación en tiempo constante
// =====================================================================
String toHex(const uint8_t *b, size_t n) {
  static const char *H = "0123456789abcdef";
  String s; s.reserve(n * 2);
  for (size_t i = 0; i < n; i++) { s += H[b[i] >> 4]; s += H[b[i] & 15]; }
  return s;
}
bool fromHex(const String &s, uint8_t *out, size_t n) {
  if (s.length() != n * 2) return false;
  for (size_t i = 0; i < n; i++) {
    char hi = s[2 * i], lo = s[2 * i + 1];
    auto v = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    int a = v(hi), b = v(lo);
    if (a < 0 || b < 0) return false;
    out[i] = (uint8_t)(a << 4 | b);
  }
  return true;
}
// Por qué tiempo constante: una comparación normal se detiene en el primer
// byte distinto y el tiempo de respuesta revela cuántos bytes acertó el atacante.
bool ctEqual(const uint8_t *a, const uint8_t *b, size_t n) {
  uint8_t d = 0;
  for (size_t i = 0; i < n; i++) d |= a[i] ^ b[i];
  return d == 0;
}
String randomHex(size_t bytes) {
  uint8_t buf[32];
  if (bytes > sizeof(buf)) bytes = sizeof(buf);
  esp_fill_random(buf, bytes);  // RNG por hardware (verdadero con la radio Wi-Fi activa)
  return toHex(buf, bytes);
}

// =====================================================================
//  Criptografía: PBKDF2-HMAC-SHA256 y HMAC para firmar envíos
// =====================================================================
// Por qué PBKDF2 y no SHA-256 simple: SHA-256 es rapidísimo, así que un
// atacante con el archivo de usuarios probaría millones de claves por segundo.
// PBKDF2 repite el HMAC miles de veces (costo) y la sal aleatoria impide usar
// tablas precalculadas o detectar dos usuarios con la misma clave.
bool pbkdf2Sha256(const uint8_t *pw, size_t pwLen, const uint8_t *salt, size_t saltLen,
                  uint32_t iterations, uint8_t out[32]) {
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  if (mbedtls_md_setup(&ctx, info, 1) != 0) { mbedtls_md_free(&ctx); return false; }
  uint8_t U[32], T[32];
  const uint8_t blockIndex[4] = {0, 0, 0, 1};  // un solo bloque: salida de 32 bytes
  mbedtls_md_hmac_starts(&ctx, pw, pwLen);
  mbedtls_md_hmac_update(&ctx, salt, saltLen);
  mbedtls_md_hmac_update(&ctx, blockIndex, 4);
  mbedtls_md_hmac_finish(&ctx, U);
  memcpy(T, U, 32);
  for (uint32_t i = 1; i < iterations; i++) {
    mbedtls_md_hmac_reset(&ctx);
    mbedtls_md_hmac_update(&ctx, U, 32);
    mbedtls_md_hmac_finish(&ctx, U);
    for (int j = 0; j < 32; j++) T[j] ^= U[j];
  }
  memcpy(out, T, 32);
  mbedtls_md_free(&ctx);
  memset(U, 0, sizeof(U));
  memset(T, 0, sizeof(T));
  return true;
}

String hmacSha256Hex(const String &key, const String &msg) {
  uint8_t mac[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                  (const uint8_t *)key.c_str(), key.length(),
                  (const uint8_t *)msg.c_str(), msg.length(), mac);
  return toHex(mac, 32);
}

bool aesGcm(bool encrypt, const uint8_t key[32], const uint8_t iv[12], const String &aad,
            const uint8_t *in, size_t len, uint8_t *out, uint8_t tag[16]) {
  mbedtls_gcm_context g;
  mbedtls_gcm_init(&g);
  int r = mbedtls_gcm_setkey(&g, MBEDTLS_CIPHER_ID_AES, key, 256);
  if (r == 0) {
    if (encrypt)
      r = mbedtls_gcm_crypt_and_tag(&g, MBEDTLS_GCM_ENCRYPT, len, iv, 12, (const uint8_t *)aad.c_str(), aad.length(),
                                    in, out, 16, tag);
    else
      r = mbedtls_gcm_auth_decrypt(&g, len, iv, 12, (const uint8_t *)aad.c_str(), aad.length(), tag, 16, in, out);
  }
  mbedtls_gcm_free(&g);
  return r == 0;
}

