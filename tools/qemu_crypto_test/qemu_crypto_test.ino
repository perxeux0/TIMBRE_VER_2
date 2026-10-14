// Prueba aislada de la criptografía del firmware (ver tools/run_crypto_test.sh).
// Imprime resultados con entradas fijas; Python los recalcula y compara.
#include <mbedtls/base64.h>
#include "crypto_util.h"

void line(const char *k, const String &v) { Serial.printf("CT|%s|%s\n", k, v.c_str()); }

void setup() {
  Serial.begin(115200);
  delay(200);
  uint8_t salt[16];
  for (int i = 0; i < 16; i++) salt[i] = i;
  uint8_t out[32];

  pbkdf2Sha256((const uint8_t *)"prueba-pbkdf2", 13, salt, 16, 10000, out);
  line("pbkdf2_prueba_10000", toHex(out, 32));
  pbkdf2Sha256((const uint8_t *)"password", 8, (const uint8_t *)"salt", 4, 1, out);
  line("pbkdf2_rfc_1", toHex(out, 32));
  pbkdf2Sha256((const uint8_t *)"password", 8, (const uint8_t *)"salt", 4, 4096, out);
  line("pbkdf2_rfc_4096", toHex(out, 32));

  line("hmac", hmacSha256Hex("clave-secreta-de-prueba-0123456789abcdef", "{\"v\":1,\"events\":[]}"));

  uint8_t key[32], iv[12], tag[16];
  for (int i = 0; i < 32; i++) key[i] = 0xA0 + i;
  for (int i = 0; i < 12; i++) iv[i] = i * 3;
  String pt = "{\"format\":\"timbre-alba-config\",\"v\":1,\"nombre\":\"Fin de descanso ñ\"}";
  String aad = "timbre-alba-backup-v1|timbre-01|2026-10-13T21:00:00";
  uint8_t ct[128], back[128];
  bool ok = aesGcm(true, key, iv, aad, (const uint8_t *)pt.c_str(), pt.length(), ct, tag);
  line("gcm_enc_ok", ok ? "1" : "0");
  line("gcm_ct", toHex(ct, pt.length()));
  line("gcm_tag", toHex(tag, 16));
  ok = aesGcm(false, key, iv, aad, ct, pt.length(), back, tag);
  back[pt.length()] = 0;
  line("gcm_dec_ok", ok && pt.equals((const char *)back) ? "1" : "0");
  ct[3] ^= 1;  // alteración de un bit
  ok = aesGcm(false, key, iv, aad, ct, pt.length(), back, tag);
  line("gcm_tamper_rejected", ok ? "0" : "1");

  uint8_t b64[64];
  size_t olen = 0;
  mbedtls_base64_encode(b64, sizeof(b64), &olen, (const uint8_t *)"Timbre Alba", 11);
  b64[olen] = 0;
  line("b64", String((const char *)b64));

  uint8_t a[4] = {1, 2, 3, 4}, b[4] = {1, 2, 3, 5};
  line("ct_equal", String(ctEqual(a, a, 4)) + String(ctEqual(a, b, 4)));
  line("rand_len", String(randomHex(16).length()));

  uint32_t t0 = micros();
  pbkdf2Sha256((const uint8_t *)"x", 1, salt, 16, 1000, out);
  line("pbkdf2_1000_us_qemu", String(micros() - t0));
  Serial.println("CT|done|1");
}

void loop() { delay(1000); }
