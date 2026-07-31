"""
A stand-in for a Hermes Studio server, so the app can be run and screenshotted
without one.

    python3 tools/mock-studio.py

Then sign in from a debug build with any username and password:

    emulator   http://10.0.2.2:8099
    device     http://<your machine's LAN address>:8099

Debug builds allow plain HTTP to those two hosts (see
app/src/debug/res/xml/network_security_config.xml); release builds do not.

This mock speaks REST only. The app tries the /chat-run socket first and falls
back to POST /api/chat-run/runs when it cannot connect, so running against this
file exercises that fallback rather than streaming.
"""
import base64, json, re, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# A 1x1 grey PNG stands in for /logo.png; the app only has to fetch and cache it.
LOGO = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
)

PROFILES = [
    {"name": "manager", "model": "claude-opus-5", "active": True, "avatar": None},
    {"name": "barq", "model": "claude-sonnet-5", "active": False, "avatar": None},
    {"name": "deep-engineer", "model": "gpt-5", "active": False, "avatar": None},
]
SESSIONS = [
    {"id": "s1", "title": "تقرير الأسبوع", "model": "claude-opus-5", "updated_at": "2026-07-30T18:20:00", "profile": "manager"},
    {"id": "s2", "title": "Deploy the staging box", "model": "claude-sonnet-5", "updated_at": "2026-07-30T14:02:00", "profile": "barq"},
    {"id": "s3", "title": "مراجعة كود الاستديو", "model": "gpt-5", "updated_at": "2026-07-29T09:41:00", "profile": "deep-engineer"},
]
MESSAGES = [
    {"id": "m1", "role": "user", "content": "وش وضع التقرير؟", "timestamp": "2026-07-30T18:19:00"},
    {"id": "m2", "role": "assistant", "content": "خلصت الجزء الأول ورفعته على السيرفر. باقي المراجعة النهائية.", "timestamp": "2026-07-30T18:20:00"},
]
ROOMS = [{"id": "r1", "name": "غرفة التطوير", "agentCount": 3, "memberCount": 2, "updatedAt": "2026-07-30T12:00:00"}]
JOBS = [
    {
        "job_id": "morning-brief",
        "id": "morning-brief",
        "name": "ملخص الصباح",
        "prompt": "راجع آخر المستجدات وأرسل لي ملخصًا قصيرًا.",
        "prompt_preview": "راجع آخر المستجدات وأرسل لي ملخصًا قصيرًا.",
        "skills": ["web-research"],
        "model": "claude-opus-5",
        "provider": "anthropic",
        "schedule": {"kind": "cron", "expr": "0 9 * * *", "display": "يوميًا 09:00"},
        "schedule_display": "يوميًا 09:00",
        "repeat": {"times": None, "completed": 4},
        "enabled": True,
        "state": "scheduled",
        "created_at": "2026-07-20T10:00:00Z",
        "next_run_at": "2026-08-01T09:00:00Z",
        "last_run_at": "2026-07-31T09:00:00Z",
        "last_status": "ok",
        "last_error": None,
        "deliver": "telegram:12345",
        "last_delivery_error": None,
    },
    {
        "job_id": "weekly-review",
        "id": "weekly-review",
        "name": "مراجعة الأسبوع",
        "prompt": "اجمع إنجازات الأسبوع واقترح أولويات الأسبوع القادم.",
        "skills": [],
        "model": None,
        "provider": None,
        "schedule": {"kind": "cron", "expr": "0 18 * * 4", "display": "الخميس 18:00"},
        "schedule_display": "الخميس 18:00",
        "repeat": {"times": 12, "completed": 2},
        "enabled": False,
        "state": "paused",
        "created_at": "2026-07-15T12:00:00Z",
        "next_run_at": None,
        "last_run_at": "2026-07-24T18:00:00Z",
        "last_status": "ok",
        "last_error": None,
        "deliver": "local",
        "last_delivery_error": None,
    },
]
RUN_OUTPUT = "# ملخص التشغيل\n\nاكتملت المهمة بنجاح، وهذه نتيجة تجريبية من سيرفر الاختبار المحلي.\n"
CONFIG = {
    "model": {"default": "claude-opus-5"},
    "display": {"streaming": True, "compact": False, "show_reasoning": True, "show_cost": False,
                "inline_diffs": True, "bell_on_complete": False, "notify_on_complete": False,
                "chat_input_height": 96},
    "agent": {"max_turns": 24, "gateway_timeout": 0, "restart_drain_timeout": 45,
              "tool_use_enforcement": "auto"},
    "memory": {"memory_enabled": True, "user_profile_enabled": True, "memory_char_limit": 2000,
               "user_char_limit": 2000, "write_approval": False},
    "skills": {"write_approval": False},
    "compression": {"enabled": True, "threshold": 0.5, "target_ratio": 0.2,
                    "protect_last_n": 20, "protect_first_n": 3},
    "session_reset": {"mode": "both", "idle_minutes": 60, "at_hour": 4},
    "privacy": {"redact_pii": True},
    "approvals": {"mode": "manual"},
    "gatewayAutoStart": {"enabled": True, "include": None, "exclude": [], "management": "unified"},
    "proxy": {"HTTPS_PROXY": "", "HTTP_PROXY": "", "ALL_PROXY": "", "NO_PROXY": "localhost,127.0.0.1"},
    "platforms": {"telegram": {"enabled": True}},
    "platformCredentialStatus": {"telegram": True},
}
PROVIDERS = [
    {"provider": "anthropic", "label": "Anthropic", "builtin": True, "base_url": "https://api.anthropic.com",
     "api_key": "configured", "models": ["claude-opus-5", "claude-sonnet-5"]},
    {"provider": "openai", "label": "OpenAI", "builtin": True, "base_url": "https://api.openai.com/v1",
     "api_key": "", "models": ["gpt-5"]},
]
USERS = [
    {"id": 1, "username": "twuijri", "role": "super_admin", "status": "active", "profiles": [],
     "default_profile": None, "last_login_at": 1785492000000},
    {"id": 2, "username": "operator", "role": "admin", "status": "active", "profiles": ["manager"],
     "default_profile": "manager", "last_login_at": None},
]
LOCKS = [{"ip": "192.0.2.10", "type": "password", "failures": 5,
          "lockedUntil": int(time.time() * 1000) + 15 * 60 * 1000}]
ACCOUNT_AVATAR = {"type": "default", "seed": "twuijri"}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length)
        return json.loads(raw or b'{}')

    def find_job(self, job_id):
        return next((job for job in JOBS if job['job_id'] == job_id), None)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/logo.png':
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(LOGO)))
            self.end_headers()
            self.wfile.write(LOGO)
        elif path == '/api/auth/me': self.send({"user": USERS[0]})
        elif path == '/api/auth/avatar': self.send({"avatar": json.dumps(ACCOUNT_AVATAR)})
        elif path == '/api/auth/users': self.send({"users": USERS, "profiles": [p["name"] for p in PROFILES]})
        elif path == '/api/auth/locked-ips': self.send({"locks": LOCKS})
        elif path == '/api/hermes/profiles': self.send({"profiles": PROFILES})
        elif path == '/api/hermes/sessions': self.send({"sessions": SESSIONS})
        elif re.match(r'/api/hermes/sessions/conversations/.+/messages', path): self.send({"messages": MESSAGES})
        elif path == '/api/hermes/group-chat/rooms': self.send({"rooms": ROOMS})
        elif re.match(r'/api/hermes/group-chat/rooms/.+', path):
            self.send({"room": ROOMS[0], "agents": [{"name": "barq"}], "members": [], "messages": [
                {"id": "g1", "role": "assistant", "senderName": "barq", "content": "جاهز.", "timestamp": "2026-07-30T12:00:00"}]})
        elif path == '/api/hermes/config':
            section = parse_qs(parsed.query).get('section', [None])[0]
            self.send({section: CONFIG.get(section, {})} if section else CONFIG)
        elif path == '/api/hermes/available-models':
            self.send({"default": "claude-opus-5", "default_provider": "anthropic", "groups": PROVIDERS,
                       "allProviders": PROVIDERS})
        elif path == '/api/hermes/jobs': self.send({"jobs": JOBS})
        elif path == '/api/hermes/jobs/delivery-targets':
            self.send({"updated_at": "2026-07-31T09:00:00Z", "targets": [
                {"platform": "telegram", "id": "12345", "name": "التحديثات", "type": "group", "thread_id": None, "value": "telegram:12345"}
            ]})
        elif re.fullmatch(r'/api/hermes/jobs/[^/]+', path):
            job = self.find_job(unquote(path.rsplit('/', 1)[1]))
            self.send({"job": job}, 200 if job else 404)
        elif path == '/api/hermes/skills':
            self.send({"categories": [{"name": "local", "description": "", "skills": [
                {"name": "web-research", "description": "", "enabled": True},
                {"name": "summarize", "description": "", "enabled": True}
            ]}], "archived": []})
        elif path == '/api/cron-history':
            job_id = parse_qs(parsed.query).get('jobId', ['morning-brief'])[0]
            self.send({"runs": [{"jobId": job_id, "fileName": "2026-07-31T09-00-00.md", "runTime": "2026-07-31 09:00:00", "size": len(RUN_OUTPUT.encode()), "hasOutput": True, "status": "ok"}]})
        elif re.fullmatch(r'/api/cron-history/[^/]+/[^/]+', path):
            _, _, _, job_id, file_name = path.split('/')
            self.send({"jobId": unquote(job_id), "fileName": unquote(file_name), "runTime": "2026-07-31 09:00:00", "content": RUN_OUTPUT})
        else: self.send({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split('?')[0]
        body = self.json_body()
        if path == '/api/auth/login': self.send({"token": "mock-token"})
        elif path in ('/api/auth/change-password', '/api/auth/change-username'):
            if path.endswith('change-username') and body.get('newUsername'):
                USERS[0]['username'] = body['newUsername']
            self.send({"success": True})
        elif path == '/api/auth/users':
            next_id = max(user['id'] for user in USERS) + 1
            USERS.append({"id": next_id, "username": body.get('username', f'user{next_id}'),
                          "role": body.get('role', 'admin'), "status": body.get('status', 'active'),
                          "profiles": body.get('profiles', []), "default_profile": body.get('defaultProfile'),
                          "last_login_at": None})
            self.send({"users": USERS})
        elif path == '/api/chat-run/runs':
            time.sleep(1)
            self.send({"output": "تم، سجلت الملاحظة.", "session_id": "s1"})
        elif path.endswith('/gateway/restart'): self.send({"success": True})
        elif path == '/api/hermes/jobs':
            job_id = f"mock-job-{len(JOBS) + 1}"
            job = {
                "job_id": job_id, "id": job_id, "name": body.get('name', job_id),
                "prompt": body.get('prompt', ''), "skills": body.get('skills', []),
                "model": body.get('model'), "provider": body.get('provider'),
                "schedule": body.get('schedule', ''), "schedule_display": body.get('schedule', ''),
                "repeat": {"times": body.get('repeat'), "completed": 0}, "enabled": True,
                "state": "scheduled", "created_at": "2026-07-31T12:00:00Z",
                "next_run_at": "2026-08-01T09:00:00Z", "last_run_at": None,
                "last_status": None, "last_error": None, "deliver": body.get('deliver', 'local'),
                "last_delivery_error": None,
            }
            JOBS.append(job)
            self.send({"job": job})
        elif re.fullmatch(r'/api/hermes/jobs/[^/]+/(pause|resume|run)', path):
            job_id, action = path.rsplit('/', 2)[1:]
            job = self.find_job(unquote(job_id))
            if not job: self.send({"error": {"message": "Job not found"}}, 404); return
            if action == 'pause': job.update({"enabled": False, "state": "paused", "next_run_at": None})
            elif action == 'resume': job.update({"enabled": True, "state": "scheduled", "next_run_at": "2026-08-01T09:00:00Z"})
            else: job.update({"last_run_at": "2026-07-31T12:00:00Z", "last_status": "ok"})
            self.send({"job": job}, 202 if action == 'run' else 200)
        else: self.send({"success": True})

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.json_body()
        if path == '/api/hermes/config':
            section = body.get('section')
            if section:
                CONFIG.setdefault(section, {}).update(body.get('values', {}))
            self.send({"success": True})
        elif re.fullmatch(r'/api/hermes/config/providers/.+', path):
            provider_id = unquote(path.rsplit('/', 1)[1])
            provider = next((item for item in PROVIDERS if item['provider'] == provider_id), None)
            if provider: provider.update(body)
            self.send({"success": True})
        elif re.fullmatch(r'/api/auth/users/\d+', path):
            user = next((item for item in USERS if item['id'] == int(path.rsplit('/', 1)[1])), None)
            if user:
                for key in ('username', 'role', 'status', 'profiles'):
                    if key in body: user[key] = body[key]
                if 'defaultProfile' in body: user['default_profile'] = body['defaultProfile']
            self.send({"users": USERS})
        elif path == '/api/auth/avatar':
            avatar = body.get('avatar', {})
            if isinstance(avatar, str):
                try: avatar = json.loads(avatar)
                except json.JSONDecodeError: avatar = {}
            ACCOUNT_AVATAR.clear()
            ACCOUNT_AVATAR.update(avatar if isinstance(avatar, dict) else {"type": "default"})
            self.send({"success": True})
        else:
            self.send({"success": True})

    def do_PATCH(self):
        path = urlparse(self.path).path
        body = self.json_body()
        match = re.fullmatch(r'/api/hermes/jobs/([^/]+)', path)
        job = self.find_job(unquote(match.group(1))) if match else None
        if not job: self.send({"error": {"message": "Job not found"}}, 404); return
        for key in ('name', 'prompt', 'deliver', 'model', 'provider'):
            if key in body: job[key] = body[key]
        if 'schedule' in body:
            job['schedule'] = body['schedule']
            job['schedule_display'] = body['schedule']
        if 'skills' in body: job['skills'] = body['skills']
        if 'repeat' in body: job['repeat']['times'] = body['repeat']
        self.send({"job": job})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/api/auth/locked-ips':
            ip = parse_qs(parsed.query).get('ip', [None])[0]
            before = len(LOCKS)
            if ip: LOCKS[:] = [lock for lock in LOCKS if lock['ip'] != ip]
            else: LOCKS.clear()
            self.send({"count": before - len(LOCKS)})
            return
        user_match = re.fullmatch(r'/api/auth/users/(\d+)', path)
        if user_match:
            USERS[:] = [user for user in USERS if user['id'] != int(user_match.group(1))]
            self.send({"users": USERS})
            return
        match = re.fullmatch(r'/api/hermes/jobs/([^/]+)', path)
        job = self.find_job(unquote(match.group(1))) if match else None
        if not job: self.send({"error": {"message": "Job not found"}}, 404); return
        JOBS.remove(job)
        self.send({"ok": True})

if __name__ == '__main__':
    print('mock Hermes Studio on http://0.0.0.0:8099 — any credentials work')
    HTTPServer(('0.0.0.0', 8099), Handler).serve_forever()
