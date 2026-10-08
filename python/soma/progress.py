"""Fortschritt fuer lange Befehle (anim check, analyze).

Ein Agent sieht sonst minutenlang nichts und kann nicht unterscheiden, ob der Befehl arbeitet oder haengt. Die Zeilen
gehen in den Fehlerkanal, damit die eigentliche Ausgabe auf stdout unveraendert bleibt. Kurze Laeufe bleiben still:
die erste Zeile kommt erst nach `after` Sekunden, danach hoechstens alle `every` Sekunden eine.
"""
import sys
import time


def _dur(s):
    if s < 90:
        return f"{max(1, round(s))} s"
    return f"{round(s / 60)} min"


class Progress:
    def __init__(self, what, total, unit="steps", after=5.0, every=15.0):
        self.what, self.total, self.unit = what, max(1, int(total)), unit
        self.after, self.every = after, every
        self.done = 0
        self.start = time.perf_counter()
        self.last = None

    def step(self, n=1):
        self.done = min(self.total, self.done + n)
        now = time.perf_counter()
        elapsed = now - self.start
        if elapsed < self.after or (self.last is not None and now - self.last < self.every) or self.done >= self.total:
            return
        self.last = now
        rest = elapsed / max(self.done, 1) * (self.total - self.done)
        self._say(f"{self.what}: {self.done} of {self.total} {self.unit}, about {_dur(rest)} left")

    def finish(self):
        if self.last is not None:
            self._say(f"{self.what}: done after {_dur(time.perf_counter() - self.start)}")

    @staticmethod
    def _say(text):
        try:
            print(text, file=sys.stderr, flush=True)
        except (OSError, ValueError):
            pass
