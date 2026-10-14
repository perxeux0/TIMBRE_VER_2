# Seguridad de Timbre Alba V2

## Principio: el repositorio no contiene secretos

| Dato | Dónde vive | En GitHub |
|---|---|---|
| Clave Wi-Fi inicial, administradores y contraseña inicial | `secrets.h` (solo en el computador de quien programa la placa) | ❌ bloqueado por `.gitignore`, gitleaks y CI |
| Contraseñas de usuarios | En el equipo, como **PBKDF2-HMAC-SHA256** (10 000 iteraciones, sal aleatoria de 16 bytes) | ❌ |
| Clave Wi-Fi actual, red institucional y clave de Sheets | NVS del equipo | ❌ |
| Clave HMAC de Apps Script | Propiedades del script (Google) | ❌ |
| Copias de seguridad | Archivo cifrado **AES-256-GCM** con una frase que el equipo no guarda | ❌ (ignoradas por `.gitignore`) |
| Certificados raíz de Google (`google_roots.h`) | Código | ✅ son **públicos** |

Si alguien descarga el repositorio, obtiene el código y nada más: ni contraseñas ni acceso a los timbres ya instalados.

## Controles implementados

**Autenticación y sesiones**
- Cambio de contraseña **obligatorio** en el primer ingreso y después de cada restablecimiento.
- Política de contraseñas: 10 a 64 caracteres, letras y números, sin incluir el usuario y sin claves comunes. No se puede reutilizar la inicial.
- Token de sesión aleatorio de **128 bits** (generador por hardware), enviado en un encabezado (no cookie, así que no hay CSRF). Expira a los 30 minutos sin uso y a las 8 horas en total.
- **Bloqueo** tras 5 fallos: 5, 10, 20 y 40 minutos. Además hay un freno global de 15 fallos por minuto.
- Comparaciones en **tiempo constante**. Si el usuario no existe, se hace el mismo cálculo para no revelar qué usuarios son válidos.
- Al cambiar contraseña, rol o estado de una cuenta, se cierran sus otras sesiones.

**Autorización**
- Cada ruta `/api` verifica sesión y rol **en el equipo**. Ocultar botones en la interfaz no da seguridad; esta verificación sí.
- Siempre debe quedar un administrador activo. Nadie puede quitarse su propio rol ni eliminarse.
- Los intentos de usar funciones de administrador sin permiso quedan en el historial como `security.denied`.

**Aplicación web**
- Encabezados `Content-Security-Policy` (sin JavaScript en línea), `X-Frame-Options: DENY`, `nosniff` y `no-referrer`.
- Toda salida pasa por `esc()`. La interfaz no carga nada de internet.
- Los CSV y las filas de Sheets neutralizan la **inyección de fórmulas** (`= + - @`).
- Peticiones limitadas a 2 KB (24 KB solo para restaurar copias).

**Red**
- El panel solo responde a quien esté conectado a la red del timbre. El acceso desde la red institucional viene **apagado** y, si se activa, el panel lo advierte.
- El envío a Google va por **HTTPS verificando certificados** raíz de Google Trust Services. Cada lote va **firmado con HMAC-SHA256** y lleva marca de tiempo (rechaza reenvíos con más de 15 minutos de desfase) y número de secuencia (sin duplicados).

**Equipo**
- El relé queda apagado desde la primera instrucción del arranque y nunca suena más de 60 segundos seguidos.
- Un vigilante (watchdog) reinicia el equipo si el programa se cuelga más de 30 segundos.
- La restauración de fábrica exige acceso físico (botón BOOT durante 10 segundos).

## Límites conocidos

1. **El panel usa HTTP dentro de la red WPA2 del timbre.** El Wi-Fi cifra el tráfico frente a quien no tiene la clave, pero alguien que **sí** la conoce y captura la conexión podría leer lo que viaja. Por eso: clave Wi-Fi larga y conocida solo por el personal autorizado, y red del timbre separada de la red de estudiantes.
2. **Acceso físico.** Sin Flash Encryption, quien se lleve la placa puede leer su memoria: la clave Wi-Fi, la clave de Sheets y los hash de contraseña. La caja debe quedar en un lugar cerrado. Para producción, vea “Endurecimiento”.
3. **Archivo de usuarios dañado.** Si la memoria se corrompe, el equipo vuelve a crear los administradores iniciales con la contraseña de `secrets.h` (marcados para cambio obligatorio) y lo deja en el historial. Restaure una copia de seguridad cuanto antes.
4. **La contraseña inicial es débil a propósito**, porque es solo para el primer ingreso. Cada administrador inicial debe ingresar y cambiarla el mismo día. El panel muestra quiénes faltan.
5. **Apps Script público con firma.** La URL `/exec` es pública y solo acepta lotes firmados. Comparta la carpeta `TIMBRE_VER:2` únicamente con administradores.

## Endurecimiento opcional para producción

- **Flash Encryption + Secure Boot v2** (ESP-IDF / `espefuse`). Cifran la memoria y solo aceptan firmware firmado. ⚠️ **Es irreversible:** se queman eFuses. Pruebe primero en *modo desarrollo* con una placa de repuesto.
- Deshabilitar JTAG y la descarga por UART en modo *release*.
- Repositorio **privado** si el proyecto pertenece a una entidad. Active *Secret scanning* y *Push protection* en GitHub (*Settings → Code security*).

## Si se filtra un secreto

1. **Rote primero:** cambie la clave Wi-Fi o las contraseñas desde el panel, o ejecute `rotarClave()` en Apps Script y copie la nueva clave en el panel.
2. Borrar el commit **no basta**: limpie el historial con `git filter-repo` y fuerce el envío.
3. Revise el historial del timbre y la hoja *Historial* en busca de accesos extraños.

## Reportar una vulnerabilidad

Escriba de forma privada a los administradores del repositorio. No abra un *issue* público con detalles explotables.

Marcos de referencia: OWASP IoT Top 10, ETSI EN 303 645, NIST IR 8259 y la Ley 1581 de 2012 (el historial contiene nombres de usuario y direcciones IP del personal).
