#!/usr/bin/env python3
"""
Simulador del timbre para probar la interfaz web SIN la placa.

  MOCK_PASSWORD="Clave-de-Prueba-1" python3 tools/mock_server.py   → http://localhost:8080

Imita las rutas /api del firmware (mismas reglas de roles, mismas respuestas).
Los administradores de prueba Rector, Coordinador y Secretaria usan la contraseña de la
variable MOCK_PASSWORD (si no la define, se genera una al azar y se muestra
en la consola). Es solo para desarrollo: el simulador no maneja hardware.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
import backup_tool  # noqa: E402

WEB = Path(__file__).resolve().parent.parent / "web"
TZ = timezone(timedelta(hours=-5))
INITIAL_PASSWORD = os.environ.get("MOCK_PASSWORD") or secrets.token_urlsafe(9)
DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
       "base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def h(pw, salt, it=1000):
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, it)


def norm(name):
    name = (name or "").strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{2,19}", name):
        return ""
    return name[0].upper() + name[1:].lower()


def pw_problem(pw, user):
    if len(pw) < 10:
        return "La contraseña debe tener al menos 10 caracteres."
    if not re.search(r"[A-Za-zÀ-ÿ]", pw) or not re.search(r"\d", pw):
        return "Use letras y números en la contraseña."
    if user and user.lower() in pw.lower():
        return "La contraseña no puede contener el nombre de usuario."
    if pw == INITIAL_PASSWORD:
        return "No puede reutilizar la contraseña inicial."
    return None


def new_user(name, role, pw, must=True):
    salt = os.urandom(16)
    return {"name": name, "role": role, "salt": salt, "hash": h(pw, salt), "iter": 1000, "mustChange": must, "active": True, "fails": 0, "lockUntil": 0}


ST = {
    "users": [new_user(n, "admin", INITIAL_PASSWORD) for n in ("Rector", "Coordinador", "Secretaria")],
    "schedules": [], "nextId": 1, "sessions": {}, "audit": [], "seq": 0, "auto": True,
    "clock_offset": 0.0, "relay_until": 0.0, "last_manual": 0.0,
    "net": {"apSsid": "Timbre Alba V1", "apPass": "Clave-Simulador-1", "apIp": "192.168.4.1", "apMask": "255.255.255.0",
            "staEn": False, "staSsid": "", "staPass": "", "lanAdmin": False, "ntpEn": True},
    "gs": {"en": False, "url": "", "key": "", "devId": "timbre-01"},
    "cfgRev": 1, "bkRev": 0, "bkAt": "", "boot": time.time(),
}
for t, n, d in [("07:00", "Inicio de clases", 31), ("08:45", "Descanso 1", 31), ("09:00", "Fin de descanso 1", 31), ("10:30", "Descanso 2", 31),
                ("10:45", "Fin de descanso 2", 31), ("12:15", "Salida", 31), ("14:00", "Inicio jornada tarde", 15), ("17:30", "Salida final", 15), ("08:00", "Entrada sábado", 32)]:
    hh, mm = map(int, t.split(":"))
    ST["schedules"].append({"id": ST["nextId"], "name": n, "hour": hh, "minute": mm, "days": d, "duration": 3, "enabled": True})
    ST["nextId"] += 1


def now():
    return datetime.now(TZ) + timedelta(seconds=ST["clock_offset"])


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def audit(actor, a, d, ip=""):
    ST["seq"] += 1
    ST["audit"].append({"q": ST["seq"], "t": iso(now()), "u": actor[0], "r": actor[1], "a": a, "d": d[:180], "ip": ip})


def changed():
    ST["cfgRev"] += 1


def sort_sched():
    ST["schedules"].sort(key=lambda s: s["hour"] * 60 + s["minute"])


def hhmm(s):
    return f"{s['hour']:02d}:{s['minute']:02d}"


def days_text(m):
    return {127: "Todos los días", 31: "Lun a Vie", 63: "Lun a Sáb", 96: "Sáb y Dom"}.get(m, ",".join(d for i, d in enumerate(DAYS) if m & (1 << i)))


def sched_text(s):
    return f"{hhmm(s)} {s['name']} [{days_text(s['days'])}, {s['duration']} s{'' if s['enabled'] else ', pausado'}]"


def find_next(dt):
    today, now_min, best = dt.weekday(), dt.hour * 60 + dt.minute, None
    for d in range(8):
        day = (today + d) % 7
        for s in ST["schedules"]:
            if not s["enabled"] or not s["days"] & (1 << day):
                continue
            t = s["hour"] * 60 + s["minute"]
            if (d == 0 and t <= now_min) or (d == 7 and t > now_min):
                continue
            sec = (d * 1440 + t - now_min) * 60 - dt.second
            if best is None or sec < best[0]:
                best = (sec, s, day)
    return best


class Handler(BaseHTTPRequestHandler):
    server_version = "TimbreMock"

    def log_message(self, *a):
        pass

    # -------- respuestas --------
    def send(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def ok(self, msg=None, **kw):
        o = {"ok": True, **kw}
        if msg:
            o["message"] = msg
        self.send(200, o)

    def err(self, code, msg, c=None):
        o = {"ok": False, "error": msg}
        if c:
            o["code"] = c
        self.send(code, o)

    def body(self, limit=2048):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            self.rfile.read(n)
            self.err(413, "Petición demasiado grande.")
            return None
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            self.err(400, "Datos inválidos.")
            return None

    def guard(self, admin=False, allow_must=False):
        tok = self.headers.get("X-Session", "")
        s = ST["sessions"].get(tok)
        if not s or time.time() - s["seen"] > 1800:
            self.err(401, "Sesión vencida. Ingrese de nuevo.", "auth")
            return None
        s["seen"] = time.time()
        self.actor = (s["user"], s["role"])
        if s["mustChange"] and not allow_must:
            self.err(403, "Debe cambiar su contraseña antes de continuar.", "must_change")
            return None
        if admin and s["role"] != "admin":
            audit(self.actor, "security.denied", "Intento de usar función de administrador: " + self.path, self.ip())
            self.err(403, "Esta función es solo para administradores.", "forbidden")
            return None
        self.sess, self.tok = s, tok
        return s

    def ip(self):
        return self.client_address[0]

    # -------- archivos --------
    def do_GET(self):
        u = urlparse(self.path)
        files = {"/": ("index.html", "text/html; charset=utf-8"), "/app.css": ("app.css", "text/css; charset=utf-8"), "/app.js": ("app.js", "application/javascript; charset=utf-8")}
        if u.path in files:
            f, t = files[u.path]
            data = (WEB / f).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", t)
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        route = {"/api/me": self.me, "/api/status": self.status, "/api/schedules": self.sched_get, "/api/users": self.users_get,
                 "/api/network": self.net_get, "/api/integration": self.gs_get, "/api/audit": self.audit_get, "/api/audit.csv": self.audit_csv,
                 "/api/system": self.system, "/api/backup": self.backup_info}.get(u.path)
        if route:
            self.q = parse_qs(u.query)
            return route()
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        route = {"/api/login": self.login, "/api/logout": self.logout, "/api/password": self.password, "/api/schedules": self.sched_post,
                 "/api/ring": self.ring, "/api/stop": self.stop, "/api/auto": self.auto, "/api/time": self.set_time, "/api/users": self.users_post,
                 "/api/network": self.net_post, "/api/integration": self.gs_post, "/api/reboot": self.reboot, "/api/backup": self.backup,
                 "/api/restore": self.restore}.get(urlparse(self.path).path)
        if not route:
            return self.err(404, "Ruta no encontrada.")
        route()

    # -------- autenticación --------
    def login(self):
        d = self.body()
        if d is None:
            return
        name, pw = norm(d.get("username")), d.get("password", "")
        u = next((x for x in ST["users"] if x["name"] == name), None)
        self.actor = (name or "(desconocido)", "-")
        if u and u["lockUntil"] > time.time():
            return self.err(429, f"Cuenta bloqueada por intentos fallidos. Intente en {int((u['lockUntil'] - time.time()) // 60) + 1} min.")
        if not u or not u["active"] or not hmac.compare_digest(h(pw, u["salt"], u["iter"]), u["hash"]):
            if u:
                u["fails"] += 1
                if u["fails"] >= 5:
                    u["fails"], u["lockUntil"] = 0, time.time() + 300
                    audit(self.actor, "auth.locked", "Cuenta bloqueada 5 min por intentos fallidos", self.ip())
                else:
                    audit(self.actor, "auth.fail", "Contraseña incorrecta", self.ip())
            else:
                audit(self.actor, "auth.fail", "Usuario inexistente o inactivo", self.ip())
            return self.err(401, "Usuario o contraseña incorrectos.")
        u["fails"] = 0
        tok = secrets.token_hex(16)
        ST["sessions"][tok] = {"user": u["name"], "role": u["role"], "mustChange": u["mustChange"], "seen": time.time()}
        audit((u["name"], u["role"]), "auth.login", "Ingreso (debe cambiar contraseña)" if u["mustChange"] else "Ingreso", self.ip())
        self.ok(token=tok, user=u["name"], role=u["role"], mustChange=u["mustChange"])

    def logout(self):
        if self.guard(allow_must=True):
            audit(self.actor, "auth.logout", "Cierre de sesión", self.ip())
            ST["sessions"].pop(self.tok, None)
            self.ok()

    def me(self):
        s = self.guard(allow_must=True)
        if s:
            self.ok(user=s["user"], role=s["role"], mustChange=s["mustChange"])

    def password(self):
        s = self.guard(allow_must=True)
        d = s and self.body()
        if not d:
            return
        u = next(x for x in ST["users"] if x["name"] == s["user"])
        if not hmac.compare_digest(h(d.get("current", ""), u["salt"], u["iter"]), u["hash"]):
            return self.err(403, "La contraseña actual no es correcta.")
        p = pw_problem(d.get("new", ""), u["name"])
        if p:
            return self.err(400, p)
        if d["new"] == d["current"]:
            return self.err(400, "La nueva contraseña debe ser distinta a la actual.")
        u["salt"] = os.urandom(16)
        u["hash"], u["mustChange"], s["mustChange"] = h(d["new"], u["salt"]), False, False
        for k in [k for k, v in ST["sessions"].items() if v["user"] == u["name"] and k != self.tok]:
            del ST["sessions"][k]
        changed()
        audit(self.actor, "auth.password", "Cambió su contraseña", self.ip())
        self.ok("Contraseña actualizada.")

    # -------- estado --------
    def status(self):
        s = self.guard()
        if not s:
            return
        dt = now()
        nx = find_next(dt) if ST["auto"] else None
        today = [{"id": x["id"], "name": x["name"], "time": hhmm(x), "duration": x["duration"], "enabled": x["enabled"],
                  "past": x["hour"] * 60 + x["minute"] < dt.hour * 60 + dt.minute} for x in ST["schedules"] if x["days"] & (1 << dt.weekday())]
        warnings = []
        if s["role"] == "admin":
            if ST["net"]["apPass"] == "Clave-Simulador-1":
                warnings.append("La clave Wi-Fi del timbre sigue siendo la de fábrica. Cámbiela en Red y equipo.")
            pend = [u["name"] for u in ST["users"] if u["active"] and u["mustChange"]]
            if pend:
                warnings.append("Usuarios que aún no cambian su contraseña inicial: " + ", ".join(pend) + ".")
            if not ST["bkAt"]:
                warnings.append("Aún no hay copia de seguridad de la configuración. Descárguela en Copias de seguridad.")
            elif ST["cfgRev"] != ST["bkRev"]:
                warnings.append(f"Hay cambios posteriores a la última copia de seguridad ({ST['bkAt'].replace('T', ' ')}). Descargue una nueva.")
        rem = max(0, ST["relay_until"] - time.time())
        o = {"now": iso(dt), "dow": dt.weekday(), "rtcOk": True, "ntp": False, "relay": {"on": rem > 0, "remainingMs": int(rem * 1000)},
             "auto": ST["auto"], "today": today, "device": {"name": ST["net"]["apSsid"], "ip": ST["net"]["apIp"], "version": "2.0.0", "uptime": int(time.time() - ST["boot"])},
             "me": {"user": s["user"], "role": s["role"]}, "warnings": warnings}
        if nx:
            o["next"] = {"name": nx[1]["name"], "time": hhmm(nx[1]), "dow": nx[2], "in": nx[0]}
        self.ok(**o)

    # -------- horarios --------
    def sched_get(self):
        if self.guard():
            self.ok(items=[{"id": s["id"], "name": s["name"], "time": hhmm(s), "days": s["days"], "duration": s["duration"], "enabled": s["enabled"]} for s in ST["schedules"]], max=80)

    def parse_sched(self, d, self_id):
        name = str(d.get("name", "")).strip()
        if not 1 <= len(name.encode()) <= 60:
            return None, "El nombre debe tener entre 1 y 30 caracteres."
        m = re.fullmatch(r"(\d\d):(\d\d)", str(d.get("time", "")))
        if not m or int(m[1]) > 23 or int(m[2]) > 59:
            return None, "Hora inválida (use HH:MM)."
        days, dur = int(d.get("days", 0)), int(d.get("duration", 3))
        if not 1 <= days <= 127:
            return None, "Seleccione al menos un día."
        if not 1 <= dur <= 60:
            return None, "La duración debe estar entre 1 y 60 segundos."
        hh, mm = int(m[1]), int(m[2])
        for o in ST["schedules"]:
            if o["id"] != self_id and o["hour"] == hh and o["minute"] == mm and o["days"] & days:
                k = next(i for i in range(7) if o["days"] & days & (1 << i))
                return None, f"Ya existe un timbre a las {hh:02d}:{mm:02d} el {DAYS[k]} ({o['name']})."
        return {"name": name, "hour": hh, "minute": mm, "days": days, "duration": dur, "enabled": bool(d.get("enabled", True))}, None

    def sched_post(self):
        if not self.guard():
            return
        d = self.body()
        if d is None:
            return
        a, ip = d.get("action"), self.ip()
        if a == "add":
            s, e = self.parse_sched(d, 0)
            if e:
                return self.err(400, e)
            s["id"] = ST["nextId"]
            ST["nextId"] += 1
            ST["schedules"].append(s)
            sort_sched(); changed()
            audit(self.actor, "sched.add", sched_text(s), ip)
            return self.ok("Timbre agregado.")
        if a == "copyDay":
            fr, to = int(d.get("from", -1)), int(d.get("to", 0)) & ~(1 << int(d.get("from", 0)))
            n = 0
            for s in ST["schedules"]:
                if s["days"] & (1 << fr):
                    add = to & ~s["days"]
                    for o in ST["schedules"]:
                        if o is not s and o["hour"] == s["hour"] and o["minute"] == s["minute"]:
                            add &= ~o["days"]
                    if add:
                        s["days"] |= add
                        n += 1
            changed()
            audit(self.actor, "sched.copy", f"Copiados {n} timbres del {DAYS[fr]} a: {days_text(to)}", ip)
            return self.ok(f"{n} timbres copiados.")
        if a == "clearDay":
            day, n = int(d.get("day", -1)), 0
            for s in list(ST["schedules"]):
                if s["days"] & (1 << day):
                    s["days"] &= ~(1 << day)
                    n += 1
                    if not s["days"]:
                        ST["schedules"].remove(s)
            changed()
            audit(self.actor, "sched.clear", f"Vaciado el {DAYS[day]} ({n} timbres)", ip)
            return self.ok(f"{n} timbres quitados del {DAYS[day]}.")
        s = next((x for x in ST["schedules"] if x["id"] == int(d.get("id", 0))), None)
        if not s:
            return self.err(404, "Ese timbre ya no existe. Actualice la página.")
        if a == "update":
            n, e = self.parse_sched(d, s["id"])
            if e:
                return self.err(400, e)
            before = sched_text(s)
            s.update(n)
            sort_sched(); changed()
            audit(self.actor, "sched.update", before + " → " + sched_text(s), ip)
            return self.ok("Timbre actualizado.")
        if a == "toggle":
            s["enabled"] = bool(d.get("enabled", not s["enabled"]))
            changed()
            audit(self.actor, "sched.toggle", sched_text(s), ip)
            return self.ok("Timbre activado." if s["enabled"] else "Timbre pausado.")
        if a == "delete":
            ST["schedules"].remove(s)
            changed()
            audit(self.actor, "sched.delete", sched_text(s), ip)
            return self.ok("Timbre eliminado.")
        if a == "split":
            day = int(d.get("day", -1))
            if s["days"] == 1 << day:
                return self.ok(id=s["id"])
            c = dict(s, id=ST["nextId"], days=1 << day)
            ST["nextId"] += 1
            s["days"] &= ~(1 << day)
            ST["schedules"].append(c)
            sort_sched(); changed()
            audit(self.actor, "sched.split", f"Separado el {DAYS[day]} de: {c['name']}", ip)
            return self.ok(id=c["id"])
        self.err(400, "Acción inválida.")

    def ring(self):
        if not self.guard():
            return
        d = self.body()
        if d is None:
            return
        sec = max(1, min(10, int(d.get("seconds", 3))))
        if time.time() - ST["last_manual"] < 3:
            return self.err(429, "Espere unos segundos antes de volver a timbrar.")
        ST["last_manual"], ST["relay_until"] = time.time(), time.time() + sec
        audit(self.actor, "ring.manual", f"Timbre manual {sec} s", self.ip())
        self.ok(f"Timbre sonando {sec} s.")

    def stop(self):
        if self.guard():
            if ST["relay_until"] > time.time():
                audit(self.actor, "ring.stop", "Timbre detenido manualmente", self.ip())
            ST["relay_until"] = 0
            self.ok("Timbre detenido.")

    # -------- administración --------
    def auto(self):
        if not self.guard(True):
            return
        d = self.body()
        ST["auto"] = bool(d.get("enabled", True))
        changed()
        audit(self.actor, "auto.set", "Timbre automático " + ("ACTIVADO" if ST["auto"] else "DESACTIVADO"), self.ip())
        self.ok("Modo automático activado." if ST["auto"] else "Modo automático desactivado.")

    def set_time(self):
        if not self.guard(True):
            return
        d = self.body()
        try:
            t = d.get("time", "")
            target = datetime.strptime(d.get("date", "") + " " + (t if t.count(":") == 2 else t + ":00"), "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)
        except ValueError:
            return self.err(400, "Fecha u hora inválida.")
        before = iso(now())
        ST["clock_offset"] = (target - datetime.now(TZ)).total_seconds()
        audit(self.actor, "time.set", f"De {before} a {iso(now())}", self.ip())
        self.ok("Fecha y hora guardadas.")

    def users_get(self):
        s = self.guard(True)
        if s:
            self.ok(items=[{"name": u["name"], "role": u["role"], "active": u["active"], "mustChange": u["mustChange"],
                            "locked": u["lockUntil"] > time.time(), "me": u["name"] == s["user"]} for u in ST["users"]], max=16)

    def users_post(self):
        s = self.guard(True)
        d = s and self.body()
        if not d:
            return
        a, name, ip = d.get("action"), norm(d.get("username")), self.ip()
        if not name:
            return self.err(400, "Usuario inválido: 3 a 20 letras o números, empezando por letra.")
        u = next((x for x in ST["users"] if x["name"] == name), None)
        admins = lambda: sum(1 for x in ST["users"] if x["active"] and x["role"] == "admin")  # noqa: E731
        kill = lambda n: [ST["sessions"].pop(k) for k in [k for k, v in ST["sessions"].items() if v["user"] == n]]  # noqa: E731
        if a == "add":
            if u:
                return self.err(400, "Ese usuario ya existe.")
            if d.get("role") not in ("admin", "usuario"):
                return self.err(400, "Rol inválido.")
            p = pw_problem(d.get("password", ""), name)
            if p:
                return self.err(400, p)
            ST["users"].append(new_user(name, d["role"], d["password"]))
            changed()
            audit(self.actor, "user.add", f"Creó a {name} ({d['role']})", ip)
            return self.ok("Usuario creado. Deberá cambiar la contraseña al ingresar.")
        if not u:
            return self.err(404, "Usuario no encontrado.")
        me = name == s["user"]
        if a == "update":
            role, active = d.get("role", u["role"]), bool(d.get("active", u["active"]))
            if me and (role != u["role"] or not active):
                return self.err(400, "No puede cambiar su propio rol ni desactivarse.")
            if u["role"] == "admin" and u["active"] and (role != "admin" or not active) and admins() <= 1:
                return self.err(400, "Debe quedar al menos un administrador activo.")
            u["role"], u["active"] = role, active
            kill(name); changed()
            audit(self.actor, "user.update", f"{name}: {role}, {'activo' if active else 'inactivo'}", ip)
            return self.ok("Usuario actualizado.")
        if a == "reset":
            if me:
                return self.err(400, "Para su propia cuenta use Mi cuenta → Cambiar contraseña.")
            p = pw_problem(d.get("password", ""), name)
            if p:
                return self.err(400, p)
            u.update(new_user(name, u["role"], d["password"]))
            kill(name); changed()
            audit(self.actor, "user.reset", f"Restableció la contraseña de {name}", ip)
            return self.ok("Contraseña temporal asignada. Deberá cambiarla al ingresar.")
        if a == "unlock":
            u["lockUntil"] = u["fails"] = 0
            audit(self.actor, "user.unlock", f"Desbloqueó a {name}", ip)
            return self.ok("Cuenta desbloqueada.")
        if a == "delete":
            if me:
                return self.err(400, "No puede eliminar su propia cuenta.")
            if u["role"] == "admin" and u["active"] and admins() <= 1:
                return self.err(400, "Debe quedar al menos un administrador activo.")
            ST["users"].remove(u)
            kill(name); changed()
            audit(self.actor, "user.delete", f"Eliminó a {name}", ip)
            return self.ok("Usuario eliminado.")
        self.err(400, "Acción inválida.")

    def net_get(self):
        if self.guard(True):
            n = ST["net"]
            self.ok(apSsid=n["apSsid"], apIp=n["apIp"], apMask=n["apMask"], apPassDefault=n["apPass"] == "Clave-Simulador-1", apClients=2,
                    staEnabled=n["staEn"], staSsid=n["staSsid"], staPassSet=bool(n["staPass"]), staConnected=False, staIp="", staRssi=0,
                    lanAdmin=n["lanAdmin"], ntpEnabled=n["ntpEn"], ntpSynced=False, hostname="timbre.local")

    def net_post(self):
        if not self.guard(True):
            return
        d, n = self.body(), dict(ST["net"])
        n["apSsid"] = str(d.get("apSsid", n["apSsid"])).strip()
        if d.get("apPassword"):
            if d["apPassword"] == "Clave-Simulador-1":
                return self.err(400, "No use la clave Wi-Fi de fábrica.")
            n["apPass"] = d["apPassword"]
        n.update(apIp=d.get("apIp", n["apIp"]), apMask=d.get("apMask", n["apMask"]), staEn=bool(d.get("staEnabled")), staSsid=d.get("staSsid", ""),
                 lanAdmin=bool(d.get("lanAdmin")), ntpEn=bool(d.get("ntpEnabled")))
        if d.get("staPassword"):
            n["staPass"] = d["staPassword"]
        if not re.fullmatch(r"[\x20-\x7e]{1,32}", n["apSsid"]):
            return self.err(400, "Nombre de red: 1 a 32 caracteres sin tildes ni ñ.")
        if not re.fullmatch(r"[\x20-\x7e]{8,63}", n["apPass"]):
            return self.err(400, "Clave Wi-Fi: 8 a 63 caracteres sin tildes ni ñ.")
        m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)\.(\d+)", n["apIp"])
        if not m or not (m[1] == "10" or (m[1] == "192" and m[2] == "168") or (m[1] == "172" and 16 <= int(m[2]) <= 31)) or m[4] in ("0", "255"):
            return self.err(400, "IP inválida. Use una IP privada, p. ej. 192.168.4.1")
        if n["staEn"] and not n["staSsid"]:
            return self.err(400, "Escriba el nombre de la red institucional.")
        if n == ST["net"]:
            return self.ok("No hubo cambios.")
        ST["net"] = n
        changed()
        audit(self.actor, "net.update", "Configuración de red cambiada. Reinicio programado", self.ip())
        self.ok("Configuración guardada. El timbre se reiniciará en 2 segundos.", restart=True, ssid=n["apSsid"], url=f"http://{n['apIp']}/")

    def gs_get(self):
        if self.guard(True):
            g = ST["gs"]
            self.ok(enabled=g["en"], url=g["url"], keySet=bool(g["key"]), deviceId=g["devId"], lastOk=False, lastMsg="Sin enviar todavía",
                    lastAt="", pending=max(0, ST["seq"]), staConnected=ST["net"]["staEn"])

    def gs_post(self):
        if not self.guard(True):
            return
        d = self.body()
        if d.get("action") == "test":
            return self.ok("Prueba en curso. Revise el estado en unos segundos.")
        g = dict(ST["gs"], en=bool(d.get("enabled")), url=d.get("url", ""), devId=d.get("deviceId", "timbre-01"))
        if d.get("key"):
            g["key"] = d["key"]
        if g["url"] and not re.fullmatch(r"https://script\.google\.com/macros/s/[\w-]+/exec", g["url"]):
            return self.err(400, "La URL debe ser la de la aplicación web de Apps Script (https://script.google.com/macros/s/.../exec).")
        if g["en"] and (not g["url"] or not g["key"]):
            return self.err(400, "Para activar el respaldo escriba la URL y la clave secreta.")
        ST["gs"] = g
        changed()
        audit(self.actor, "gs.update", "Respaldo en Google Sheets " + ("activado" if g["en"] else "desactivado"), self.ip())
        self.ok("Integración guardada.")

    def audit_get(self):
        if not self.guard(True):
            return
        q = {k: v[0] for k, v in self.q.items()}
        before, limit = int(q.get("before") or 10**9), max(1, min(100, int(q.get("limit") or 50)))
        items = [e for e in ST["audit"] if e["q"] < before and (not q.get("user") or e["u"] == q["user"]) and (not q.get("type") or e["a"].startswith(q["type"]))
                 and (not q.get("q") or q["q"].lower() in json.dumps(e, ensure_ascii=False).lower())]
        self.ok(more=len(items) > limit, items=list(reversed(items[-limit:])))

    def audit_csv(self):
        if not self.guard(True):
            return
        audit(self.actor, "audit.export", "Descargó el historial en CSV", self.ip())

        def cell(v):
            v = str(v)
            if v[:1] in "=+-@":
                v = "'" + v
            return '"' + v.replace('"', '""') + '"'
        rows = ["N.,Fecha y hora,Usuario,Rol,Acción,Detalle,IP"] + [",".join([str(e["q"])] + [cell(e[k]) for k in "turad"] + [cell(e["ip"])]) for e in ST["audit"]]
        data = ("﻿" + "\r\n".join(rows) + "\r\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def system(self):
        if self.guard(True):
            self.ok(version="2.0.0", uptime=int(time.time() - ST["boot"]), heapFree=176000, heapMin=150000, fsTotal=1966080, fsUsed=24576,
                    resetReason="Encendido", mac="AA:BB:CC:00:11:22", chip="ESP32-C3", cpuMhz=160, relayPin=8, schedules=len(ST["schedules"]),
                    users=len(ST["users"]), sessions=len(ST["sessions"]), auditSeq=ST["seq"], rtcOk=True, ntp=False)

    def reboot(self):
        if self.guard(True):
            audit(self.actor, "system.reboot", "Reinicio solicitado desde el panel", self.ip())
            self.ok("Reiniciando…")

    # -------- copias de seguridad (mismo formato que el firmware) --------
    def config_doc(self):
        return {"format": "timbre-alba-config", "v": 1, "net": ST["net"], "gs": ST["gs"], "auto": ST["auto"],
                "users": [{"n": u["name"], "r": 0 if u["role"] == "admin" else 1, "s": u["salt"].hex(), "h": u["hash"].hex(), "i": u["iter"],
                           "m": u["mustChange"], "a": u["active"]} for u in ST["users"]],
                "schedules": [{"id": s["id"], "n": s["name"], "h": s["hour"], "m": s["minute"], "d": s["days"], "s": s["duration"], "e": s["enabled"]} for s in ST["schedules"]]}

    def backup_info(self):
        if self.guard(True):
            self.ok(lastBackupAt=ST["bkAt"], pendingChanges=ST["cfgRev"] != ST["bkRev"], users=len(ST["users"]), schedules=len(ST["schedules"]))

    def backup(self):
        s = self.guard(True)
        d = s and self.body()
        if not d:
            return
        p = d.get("passphrase", "")
        if len(p) < 12 or not re.search(r"[A-Za-z]", p) or not re.search(r"\d", p):
            return self.err(400, "La frase de la copia debe tener al menos 12 caracteres.")
        created = iso(now())
        f = backup_tool.encrypt(self.config_doc(), p, ST["gs"]["devId"], created, s["user"], "2.0.0")
        ST["bkRev"], ST["bkAt"] = ST["cfgRev"], created
        audit(self.actor, "backup.create", f"Descargó una copia de seguridad cifrada ({len(ST['users'])} usuarios, {len(ST['schedules'])} timbres)", self.ip())
        self.send(200, f, {"Content-Disposition": f'attachment; filename="timbre-{ST["gs"]["devId"]}-{created[:10]}.json"'})

    def restore(self):
        if not self.guard(True):
            return
        d = self.body(24576)
        if d is None:
            return
        b = d.get("backup") or {}
        try:
            c = backup_tool.decrypt(b, d.get("passphrase", ""))
        except (ValueError, KeyError) as e:
            audit(self.actor, "backup.fail", "Restauración rechazada: frase incorrecta o archivo alterado", self.ip())
            return self.err(400, "Frase incorrecta o archivo alterado. No se cambió nada." if "Frase" in str(e) else "El archivo no es una copia de seguridad de Timbre Alba.")
        users = c.get("users", [])
        if not any(u["r"] == 0 and u["a"] for u in users):
            return self.err(400, "La copia no se puede aplicar: No hay ningún administrador activo.")
        if d.get("action") == "preview":
            return self.ok(createdAt=b.get("createdAt"), createdBy=b.get("createdBy"), device=b.get("device"), fw=b.get("fw"),
                           users=[{"name": u["n"], "role": "admin" if u["r"] == 0 else "usuario", "active": u["a"]} for u in users],
                           schedules=len(c.get("schedules", [])), apSsid=c["net"]["apSsid"], apIp=c["net"]["apIp"], staEnabled=c["net"]["staEn"],
                           staSsid=c["net"]["staSsid"], gsEnabled=c["gs"]["en"], auto=c["auto"])
        ST["users"] = [{"name": u["n"], "role": "admin" if u["r"] == 0 else "usuario", "salt": bytes.fromhex(u["s"]), "hash": bytes.fromhex(u["h"]),
                        "iter": u["i"], "mustChange": u["m"], "active": u["a"], "fails": 0, "lockUntil": 0} for u in users]
        ST["schedules"] = [{"id": s["id"], "name": s["n"], "hour": s["h"], "minute": s["m"], "days": s["d"], "duration": s["s"], "enabled": s["e"]} for s in c.get("schedules", [])]
        ST["nextId"] = max([s["id"] for s in ST["schedules"]] + [0]) + 1
        ST["net"], ST["gs"], ST["auto"] = c["net"], c["gs"], c["auto"]
        ST["bkRev"] = ST["cfgRev"]
        audit(self.actor, "backup.restore", f"Restauró la copia del {b.get('createdAt')} hecha por {b.get('createdBy')}", self.ip())
        ST["sessions"].clear()
        self.ok("Copia restaurada. El timbre se reinicia ahora; ingrese con los usuarios de la copia.", restart=True, ssid=ST["net"]["apSsid"], url=f"http://{ST['net']['apIp']}/")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"Simulador en http://localhost:{port}  ·  administradores Rector/Coordinador/Secretaria · contraseña inicial: {INITIAL_PASSWORD}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
