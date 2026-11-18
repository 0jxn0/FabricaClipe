"""Emite eventos da esteira (VIDEO-MAKER) para a Fábrica de Clipe. Copie para o repo e importe.

    from fabrica_events import job
    with job("desk-4", "job-1024", "Render lote 0612") as j:   # started ... completed/failed
        j.progress(40)

Mapa sugerido (esteira.py): desk-1 scrap/add · desk-2 detect/cut · desk-3 transcrição+/viralizei ·
desk-4 render · desk-5 approve · desk-6 post. Falha de rede nunca derruba a esteira.
"""
import json, os, time, urllib.request
from datetime import datetime, timezone

URL = os.environ.get("FABRICA_URL", "http://127.0.0.1:8787/event")
TOKEN = os.environ.get("FABRICA_TOKEN", "")  # necessário só se o pipeline rodar em outra máquina (servidor com EVENT_TOKEN)


def emit(type_, desk_id, job_id, **kw):
    body = {"type": f"clip.job.{type_}", "deskId": desk_id, "jobId": job_id,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), **kw}
    try:
        req = urllib.request.Request(URL, json.dumps(body).encode(), {"Content-Type": "application/json", **({"x-event-token": TOKEN} if TOKEN else {})})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass


class job:
    def __init__(self, desk_id, job_id, title=None):
        self.d, self.j, self.t = desk_id, job_id, title

    def __enter__(self):
        self.t0 = time.time(); emit("started", self.d, self.j, title=self.t); return self

    def progress(self, pct):
        emit("progress", self.d, self.j, progress=pct)

    def __exit__(self, et, ev, tb):
        if et: emit("failed", self.d, self.j, error=str(ev)[:200])
        else: emit("completed", self.d, self.j, duration=round(time.time() - self.t0))
        return False
