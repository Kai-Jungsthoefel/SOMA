// Minimaler Chrome-DevTools-Protocol-Client für die Tests (Node >= 22, globales WebSocket).
// Grund: puppeteer-core 24 scheitert an Electron 44 ("Requesting main frame too early!"). Für unsere Zwecke reicht das hier:
// Skript im Fenster auswerten, Mausklick, Screenshot, Fehler aus der Konsole einsammeln.
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sucht das Fenster über /json/list (Ziel-Typ page, URL enthält `match`) und verbindet sich. */
export async function connectPage(port, match = 'index.html', timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
      const target = list.find((t) => t.type === 'page' && t.url.includes(match));
      if (target) return await open(target.webSocketDebuggerUrl);
    } catch { /* Port noch zu */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(300);
  }
}

function open(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const errors = [];
    const send = (method, params = {}) => new Promise((res, rej) => {
      const myId = ++id;
      const timer = setTimeout(() => { pending.delete(myId); rej(new Error(`${method}: keine Antwort nach 20 s`)); }, 20000);
      pending.set(myId, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); }, method });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'Ausnahme');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ''}`.trim());
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP-Verbindung fehlgeschlagen')));
    ws.addEventListener('open', async () => {
      try { await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); } catch (e) { return reject(e); }
      resolve({
        errors,
        /** Führt fn(arg) im Fenster aus und liefert das (JSON-fähige) Ergebnis. */
        async evaluate(fn, arg) {
          const expression = typeof fn === 'string' ? fn : `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
          const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
        /** Klick als Zeigerereignisse im Fenster. Input.dispatchMouseEvent hängt bei unsichtbaren Fenstern. */
        async click(x, y) {
          await this.evaluate(({ x, y }) => {
            const target = document.elementFromPoint(x, y);
            if (!target) return false;
            const init = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true };
            target.dispatchEvent(new PointerEvent('pointerdown', init));
            target.dispatchEvent(new PointerEvent('pointerup', init));
            target.dispatchEvent(new MouseEvent('click', init));
            return true;
          }, { x, y });
        },
        async screenshot(file) {
          const r = await send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        },
        close() { try { ws.close(); } catch { /* schon zu */ } },
      });
    });
  });
}
