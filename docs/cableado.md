# Cableado y seguridad eléctrica

## Diagrama

```
            ESP32-C3 SuperMini                 Módulo relé 5 V (jumper en H)
          ┌──────────────────────┐            ┌───────────────────────────┐
 USB 5V ──┤ 5V              GPIO8├────────────┤ IN                        │
          │                  GND ├──────┬─────┤ GND       COM ●───────────┼── Fase 110 V (con fusible 1 A)
          │                  3V3 ├──┐   │  ┌──┤ VCC       NO  ●───────────┼── Timbre ── Neutro
          │ GPIO4 GPIO5 GPIO6    │  │   │  │  │           NC  ○ (sin usar)│
          └──┬─────┬─────┬───────┘  │   │  │  └───────────────────────────┘
             │     │     │          │   │  └── 5V
          ┌──┴─────┴─────┴──────────┴───┴─┐
          │ CLK   DAT   RST      VCC   GND│  DS1302 + pila CR2032
          └───────────────────────────────┘
```

## Cálculos

- **Bobina del relé:** unos 70 mA a 5 V (JQC-3FF-S-Z, según su hoja de datos). La placa más el Wi-Fi pico consumen cerca de 350 mA. Total ≈ **0,45 A**, así que un cargador de **1 A** deja margen. Uno de 0,5 A puede provocar reinicios por bajo voltaje, que el panel muestra en *Sistema → Último reinicio*.
- **Entrada del relé:** el GPIO entrega 3,3 V. En los módulos con optoacoplador, 3,3 V basta para activar el LED interno [CRITERIO EXPERTO]. Pruébelo antes de cerrar la caja.
- **Contactos:** 10 A a 250 VAC. Un timbre escolar típico consume menos de 1 A, así que el margen es amplio.

## Reglas de seguridad (110 V)

1. Desconecte la energía antes de tocar cualquier cable de 110 V.
2. Mantenga la **zona de 110 V separada** de la zona de 5 V dentro de la caja: un tabique o al menos 8 mm de distancia, sin cables cruzados.
3. Use borneras de tornillo y cable de calibre adecuado (AWG 18 o más grueso) con alivio de tensión. **No use pegante caliente como soporte del cable de 110 V.**
4. Ponga un **fusible de 1 A** en la fase. Si quiere alargar la vida de los contactos, agregue un **varistor de 275 VAC** en paralelo con el timbre.
5. Conecte el timbre en **COM y NO** (normalmente abierto). Así, si la placa falla o se apaga, el timbre queda en silencio.
6. La instalación final la debe hacer o revisar un electricista.

## GPIO 8 y el LED de la placa

En la SuperMini, GPIO 8 es pin de *strapping* y también maneja el LED azul integrado. En el arranque normal no impide encender, pero durante el reinicio su nivel no está controlado por el programa, y algunos módulos de relé podrían dar un clic corto. Para evitarlo:

1. Pase el cable IN del relé a **GPIO 10**.
2. En `config.h` cambie `PIN_RELAY = 10`.
3. Vuelva a cargar el firmware.

## Caja

`hardware/caja_timbre_v1.stl` mide **172 × 105 × 33 mm** (todo el archivo; puede contener base y tapa). Deje ranuras de ventilación y un agujero para alcanzar el botón **BOOT** con un clip, que se usa para restaurar de fábrica.
