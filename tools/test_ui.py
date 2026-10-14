#!/usr/bin/env python3
"""Prueba de punta a punta del panel contra el simulador (tools/mock_server.py).

  MOCK_PASSWORD="Clave-de-Prueba-1" python3 tools/mock_server.py &
  python3 tools/test_ui.py        (requiere: pip install playwright)
Guarda capturas en tools/screenshots/.
"""
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8080")
INITIAL = os.environ.get("MOCK_PASSWORD", "Clave-de-Prueba-1")
SHOTS = Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)
fails, problems = [], []


def check(name, cond):
    print(("[OK]    " if cond else "[FALLA] ") + name)
    if not cond:
        fails.append(name)


def login(page, user, pw):
    page.fill("#lu", user)
    page.fill("#lp", pw)
    page.click("#login-btn")


def change_pw(page, old, new):
    page.wait_for_selector("#change:not(.hidden)")
    page.fill("#cp-old", old)
    page.fill("#cp-new", new)
    page.fill("#cp-new2", new)
    page.click("#change-form button[type=submit]")


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1366, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("console", lambda m: problems.append(m.text) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: problems.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector("#login:not(.hidden)")
    page.screenshot(path=SHOTS / "01-ingreso.png")

    # 1. Usuario en minúscula se normaliza; contraseña inicial obliga a cambiarla
    login(page, "wrong", "x")
    page.wait_for_timeout(300)
    check("Rechaza credenciales malas", "incorrectos" in page.inner_text("#login-msg"))
    login(page, "rector", INITIAL)
    page.wait_for_selector("#change:not(.hidden)")
    page.screenshot(path=SHOTS / "02-cambio-obligatorio.png")
    check("Primer ingreso exige cambio de contraseña", page.is_visible("#change-form"))
    page.fill("#cp-old", INITIAL); page.fill("#cp-new", "corta1"); page.fill("#cp-new2", "corta1")
    page.click("#change-form button[type=submit]")
    check("No acepta contraseña débil", "10 caracteres" in page.inner_text("#change-msg"))
    change_pw(page, INITIAL, "Campana-Alba-2026")
    page.wait_for_selector("#app:not(.hidden)")
    page.wait_for_selector("#clk")
    page.wait_for_timeout(1200)
    page.screenshot(path=SHOTS / "03-inicio-admin.png", full_page=True)
    nav = page.inner_text("#nav")
    check("Admin ve todo el menú", all(x in nav for x in ["Usuarios", "Historial", "Red y equipo", "Copias y respaldo", "Sistema"]))
    check("Aviso de clave Wi-Fi de fábrica", "fábrica" in page.inner_text("#banners"))
    check("Reloj corre", page.inner_text("#clk") != "--:--:--")

    # 2. Timbre manual
    page.click("#ring-seg button[data-sec='5']")
    page.click("#ring-btn")
    page.wait_for_timeout(1500)
    check("Timbre manual sonando", "Sonando" in page.inner_text("#ring-btn"))
    page.click("[data-action=stop]")

    # 3. Horarios: crear, editar solo un día, copiar día
    page.goto(BASE + "/#/horarios")
    page.wait_for_selector(".week")
    page.screenshot(path=SHOTS / "04-horarios.png", full_page=True)
    page.click("[data-action=new-sched]")
    page.fill("#f-name", "Cambio de clase")
    page.fill("#f-time", "07:55")
    page.click(".quick button[data-mask='31']")
    page.screenshot(path=SHOTS / "05-nuevo-timbre.png")
    page.click("[data-m=save]")
    page.wait_for_timeout(500)
    check("Timbre creado aparece", page.locator(".chip-s", has_text="07:55").count() == 5)
    page.click("[data-action=new-sched]")
    page.fill("#f-name", "Duplicado"); page.fill("#f-time", "07:00"); page.click("[data-m=save]")
    page.wait_for_timeout(300)
    check("Impide hora duplicada el mismo día", "Ya existe" in page.inner_text("#f-msg"))
    page.click("[data-m=cancel]")
    page.locator(".day[data-day='1'] .chip-s", has_text="07:55").click()
    page.check("input[name=scope][value=one]")
    page.fill("#f-time", "07:50")
    page.click("[data-m=save]")
    page.wait_for_timeout(500)
    check("Editar solo martes (split)", page.locator(".day[data-day='1'] .chip-s", has_text="07:50").count() == 1 and page.locator(".day[data-day='0'] .chip-s", has_text="07:55").count() == 1)
    page.click(".day[data-day='5'] [data-action=day-menu]")
    page.click(".quick[data-for=dc] button[data-mask='0']")
    page.check("#dc input[value='64']", force=True)
    page.click("[data-m=copy]")
    page.wait_for_timeout(500)
    check("Copiar sábado a domingo", page.locator(".day[data-day='6'] .chip-s", has_text="Entrada sábado").count() == 1)

    # 4. Usuarios: crear usuario normal
    page.goto(BASE + "/#/usuarios")
    page.wait_for_selector("[data-action=new-user]")
    page.click("[data-action=new-user]")
    page.fill("#u-name", "carolina")
    check("Previsualiza mayúscula inicial", "Carolina" in page.inner_text("#u-prev"))
    page.fill("#u-pass", "Temporal-2026x")
    page.click("[data-m=save]")
    page.wait_for_timeout(500)
    page.screenshot(path=SHOTS / "06-usuarios.png", full_page=True)
    check("Usuario Carolina creado", "Carolina" in page.inner_text("#view"))

    # 5. Copia de seguridad: crear y verificar
    page.goto(BASE + "/#/respaldo")
    page.wait_for_selector("#b-p1")
    page.fill("#b-p1", "Frase-Copia-Segura-77"); page.fill("#b-p2", "Frase-Copia-Segura-77")
    with page.expect_download() as dl:
        page.click("[data-action=make-backup]")
    path = SHOTS / "copia.json"
    dl.value.save_as(path)
    data = json.loads(path.read_text())
    check("Copia descargada y cifrada (sin claves legibles)", data["cipher"]["alg"] == "aes-256-gcm" and "Clave-Simulador-1" not in path.read_text())
    page.set_input_files("#r-file", str(path))
    page.fill("#r-pass", "frase-equivocada-1")
    page.click("[data-action=check-backup]")
    page.wait_for_timeout(500)
    check("Frase incorrecta rechazada", "incorrecta" in page.inner_text("#r-msg"))
    page.fill("#r-pass", "Frase-Copia-Segura-77")
    page.click("[data-action=check-backup]")
    page.wait_for_selector("[data-action=apply-backup]")
    page.screenshot(path=SHOTS / "07-copias.png", full_page=True)
    check("Vista previa muestra usuarios", "Carolina" in page.inner_text("#r-prev"))

    # 6. Historial
    page.goto(BASE + "/#/historial")
    page.wait_for_selector("#ab tr")
    page.screenshot(path=SHOTS / "08-historial.png", full_page=True)
    hist = page.inner_text("#ab")
    check("Historial registra acciones con usuario", all(x in hist for x in ["Timbre manual", "Timbre agregado", "Usuario creado", "Copia de seguridad", "Rector"]))
    with page.expect_download() as dl:
        page.click("[data-action=csv]")
    csv = Path(dl.value.path()).read_text(encoding="utf-8-sig")
    check("CSV descargado", csv.startswith("N.,Fecha y hora,Usuario"))

    # 7. Red y equipo
    page.goto(BASE + "/#/red")
    page.wait_for_selector("#n-ssid")
    page.screenshot(path=SHOTS / "09-red.png", full_page=True)
    page.goto(BASE + "/#/sistema"); page.wait_for_selector(".kv"); page.screenshot(path=SHOTS / "10-sistema.png", full_page=True)
    page.goto(BASE + "/#/reloj"); page.wait_for_selector("#t-date"); page.screenshot(path=SHOTS / "11-reloj.png")

    # 8. Usuario normal: menú limitado y API protegida
    page.click(".side-user [data-action=logout]")
    page.wait_for_selector("#login:not(.hidden)")
    login(page, "Carolina", "Temporal-2026x")
    change_pw(page, "Temporal-2026x", "Profe-Matematicas-9")
    page.wait_for_selector("#app:not(.hidden)")
    page.wait_for_timeout(800)
    nav = page.inner_text("#nav")
    check("Usuario normal solo ve Inicio/Horarios/Mi cuenta", "Usuarios" not in nav and "Red" not in nav and "Historial" not in nav and "Horarios" in nav)
    check("Usuario normal no ve avisos de administrador", "fábrica" not in page.inner_text("#banners"))
    page.screenshot(path=SHOTS / "12-inicio-usuario.png", full_page=True)
    codes = page.evaluate("""async () => { const t = sessionStorage.getItem('tk'); const r = [];
      for (const [u, m, b] of [['/api/users','GET'],['/api/network','POST','{}'],['/api/audit','GET'],['/api/backup','POST','{"passphrase":"x"}'],['/api/time','POST','{}']])
        r.push((await fetch(u, {method:m, body:b, headers:{'X-Session':t,'Content-Type':'application/json'}})).status); return r; }""")
    check(f"API de administrador bloqueada para usuario normal {codes}", all(c == 403 for c in codes))
    page.goto(BASE + "/#/red")
    page.wait_for_timeout(500)
    check("Ruta de admin redirige a Inicio", page.inner_text("#view-title") == "Inicio")
    page.goto(BASE + "/#/horarios"); page.wait_for_selector(".week")
    check("Usuario normal puede programar horarios", page.is_visible("[data-action=new-sched]"))
    nocookie = page.evaluate("async () => (await fetch('/api/status')).status")
    check("Sin token: 401", nocookie == 401)

    # 9. Móvil
    m = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True)
    mp = m.new_page()
    mp.on("pageerror", lambda e: problems.append(str(e)))
    mp.goto(BASE)
    login(mp, "Coordinador", INITIAL)
    change_pw(mp, INITIAL, "Campana-Escolar-88")
    mp.wait_for_selector("#clk")
    mp.wait_for_timeout(1200)
    mp.screenshot(path=SHOTS / "13-movil-inicio.png", full_page=True)
    w = mp.evaluate("document.documentElement.scrollWidth")
    check(f"Sin desplazamiento horizontal en móvil ({w}px)", w <= 390)
    mp.click("[data-action=open-menu]"); mp.wait_for_timeout(300)
    mp.screenshot(path=SHOTS / "14-movil-menu.png")
    mp.goto(BASE + "/#/horarios"); mp.wait_for_selector(".day-tabs"); mp.wait_for_timeout(300)
    mp.screenshot(path=SHOTS / "15-movil-horarios.png", full_page=True)

    # 10. Restaurar la copia (aplica y cierra sesiones)
    page2 = ctx.new_page()
    page2.goto(BASE)
    login(page2, "Rector", "Campana-Alba-2026")
    page2.wait_for_selector("#app:not(.hidden)")
    page2.goto(BASE + "/#/respaldo"); page2.wait_for_selector("#r-file")
    page2.set_input_files("#r-file", str(path)); page2.fill("#r-pass", "Frase-Copia-Segura-77")
    page2.click("[data-action=check-backup]"); page2.wait_for_selector("[data-action=apply-backup]")
    page2.click("[data-action=apply-backup]"); page2.fill("#cw", "restaurar"); page2.click("[data-m=ok]")
    page2.wait_for_timeout(800)
    check("Restauración aplicada y pide reconectar", "Reiniciando" in page2.inner_text("#modal-root"))

    csp = [x for x in problems if "Content Security Policy" in x or "Refused" in x]
    check(f"Sin violaciones de CSP ({len(csp)})", not csp)
    errs = [x for x in problems if x not in csp and "401" not in x and "403" not in x and "400" not in x and "429" not in x]
    check(f"Sin errores de JavaScript ({errs[:3]})", not errs)
    b.close()

print("\nRESULTADO:", "TODO OK" if not fails else f"{len(fails)} FALLAS")
sys.exit(1 if fails else 0)
