#pragma once
// =====================================================================
//  PLANTILLA DE SECRETOS - este archivo SÍ va a GitHub, con valores falsos.
//
//  1. Copie este archivo como  secrets.h  (en la misma carpeta).
//  2. Escriba en secrets.h los valores reales.
//  3. secrets.h está en .gitignore: NUNCA se sube al repositorio.
//
//  Estos valores solo se usan en el PRIMER arranque (o tras restaurar de
//  fábrica con el botón BOOT). Después todo se administra desde el panel
//  web y se guarda en el equipo; las contraseñas quedan como hash PBKDF2.
// =====================================================================

// Red Wi-Fi que crea el timbre (punto de acceso)
#define INITIAL_AP_SSID      "Timbre Escolar"
#define INITIAL_AP_PASSWORD  "CAMBIE-ESTA-CLAVE"   // 8 a 63 caracteres
#define INITIAL_AP_IP        "192.168.4.1"

// Administradores iniciales, separados por coma.
// Se normalizan: primera letra mayúscula y el resto minúscula.
#define INITIAL_ADMINS          "Admin1,Admin2"
// Contraseña inicial común. El sistema OBLIGA a cambiarla en el primer
// ingreso de cada administrador.
#define INITIAL_ADMIN_PASSWORD  "CAMBIAR"

// Identificador de este equipo (útil si la institución tiene varios timbres)
#define DEVICE_ID "timbre-01"
