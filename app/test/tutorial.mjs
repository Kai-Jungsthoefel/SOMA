// Test des Tutorials (E94): Karte „New to SOMA?“ auf der Startseite (erster Start, „Got it“ bleibt über einen Neustart,
// kaputte settings.json zeigt sie wieder), „Start tutorial“ legt das Modell „Tutorial“ an und zeigt Schritt 1, Next, Back,
// Skip und Escape, jedes Ziel der Schritte vorhanden (fängt Änderungen an der Oberfläche), Karte im Fenster, Haken beim
// Ausprobieren, fehlendes Ziel ohne Rahmen in der Mitte, Neustart aus der Hilfe mit Rückfrage, unverändertes Tutorial-Modell
// verschwindet (E69). Aufruf: node test/run-all.mjs tutorial (nach npm run build). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1
// legt Bilder in test/shots/ ab.
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;
let ud = null;

try {
  app = await startApp({ name: 'tutorial', env: { SOMA_TEST_START: 'home' } });
  ud = app.ud;
  const settingsFile = path.join(ud, 'settings.json');
  const fileSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return null; } };
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  /** Startseite offen und Einstellungen geladen (sonst gilt noch die Vorgabe der Karte). */
  const home = async (a) => {
    await a.waitFor('Startseite', () => !!window.__t && !document.getElementById('start').hidden, 30000);
    await sleep(1500);
  };
  const cardShown = (a) => a.ev(() => !document.getElementById('start-tour').hidden && document.getElementById('start-tour').getClientRects().length > 0);

  // ---- 1) Karte beim ersten Start, „Got it“ und Neustart ------------------------------------------------------------
  await home(app);
  check('Erster Start: Karte „New to SOMA?“ mit Start tutorial und Got it', await cardShown(app)
    && (await app.ev(() => document.getElementById('start-tour').textContent)).includes('New to SOMA?') && fileSettings() === null);
  await shot('tutorial-start');
  await app.domClick('btn-tour-dismiss');
  await app.waitFor('Einstellung geschrieben', () => window.__t.appSettings().settings.start.tutorialCard === false, 10000).catch(() => {});
  check('„Got it“ blendet die Karte aus und steht in settings.json', !(await cardShown(app)) && fileSettings()?.start?.tutorialCard === false, JSON.stringify(fileSettings()));
  check('„Got it“ lässt die übrigen Einstellungen bei den Vorgaben', fileSettings()?.viewer?.navigation === 'soma');

  await app.stop();
  app = await startApp({ name: 'tutorial', userData: ud, env: { SOMA_TEST_START: 'home' } });
  await home(app);
  check('Nach dem Neustart bleibt die Karte aus', !(await cardShown(app)) && (await app.ev(() => window.__t.appSettings().settings.start.tutorialCard)) === false);

  // Kaputte settings.json: Es gelten die Vorgaben, die Karte erscheint wieder, nichts stürzt ab
  await app.stop();
  fs.writeFileSync(settingsFile, '{ kaputt');
  app = await startApp({ name: 'tutorial', userData: ud, env: { SOMA_TEST_START: 'home' } });
  await home(app);
  check('Kaputte settings.json: Karte mit der Vorgabe wieder da, Problem gemeldet', await cardShown(app) && !!(await app.ev(() => window.__t.appSettings().problem)));

  // ---- 2) Tutorial starten ----------------------------------------------------------------------------------------------
  const { ev, waitFor, domClick, page } = app;
  const tour = () => ev(() => window.__t.tour());
  await domClick('btn-tour-start');
  await waitFor('Tutorial-Modell', () => !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000);
  await waitFor('Tour', () => window.__t.tour().active, 20000);
  const m1 = await ev(() => window.__t.project());
  let s = await tour();
  check('„Start tutorial“: neues Modell „Tutorial“ mit Kiste und Deckel, Startseite zu', m1.name === 'Tutorial' && fs.existsSync(m1.dir)
    && await ev(() => document.getElementById('start').hidden) && JSON.stringify(await ev(() => window.__t.treeNames())) === '["Body","Lid"]', m1.name);
  check('Step 1 of 12 with title, Back locked, Next', s.step === 1 && s.count === 12 && s.title === 'Welcome to SOMA' && s.backDisabled && s.next === 'Next'
    && (await ev(() => document.getElementById('tour-card').textContent)).includes('Step 1 of 12'), JSON.stringify(s).slice(0, 160));
  check('Schritt 1 hebt den Viewer hervor', s.target && s.spot);
  await shot('tutorial-step1');

  await domClick('btn-tour-next');
  await waitFor('Schritt 2', () => window.__t.tour().step === 2, 5000);
  s = await tour();
  check('Next: step 2 "SOMA AI, your agent", its tab in front and highlighted, without a sign-in it says one is needed', s.title === 'SOMA AI, your agent' && s.target
    && /SOMA AI is the AI agent built into SOMA/.test(s.text) && /needs a sign-in/.test(s.text) && await ev(() => !document.querySelector('.ai-pane').hidden), s.text.slice(0, 120));
  await shot('tutorial-step2');
  await domClick('btn-tour-next');
  await waitFor('step 3', () => window.__t.tour().step === 3, 5000);
  s = await tour();
  check('Step 3 "While SOMA AI works": steps, questions, Esc, model and earlier conversations explained', s.title === 'While SOMA AI works' && s.target
    && /asks with answers to click/.test(s.text) && /Esc stops it/.test(s.text) && /earlier conversations/.test(s.text), s.text.slice(0, 120));
  await domClick('btn-tour-next');
  await waitFor('step 4', () => window.__t.tour().step === 4, 5000);
  await waitFor('+ menu open', () => !document.getElementById('menu-agents').hidden, 5000).catch(() => {});
  s = await tour();
  check('Step 4 "Or your own agent": the + menu is open and highlighted, an own agent in a terminal or Empty terminal', s.title === 'Or your own agent' && s.target
    && await ev(() => !document.getElementById('menu-agents').hidden) && /instead of SOMA AI/.test(s.text) && /Empty terminal/.test(s.text), s.text.slice(0, 160));
  await shot('tutorial-step4-own-agent');
  await domClick('btn-tour-next');
  await waitFor('step 5', () => window.__t.tour().step === 5, 5000);
  check('Next closes the + menu again', await ev(() => document.getElementById('menu-agents').hidden));
  await ev(() => window.__t.tourGo(2));
  await waitFor('step 2', () => window.__t.tour().step === 2, 5000);
  await domClick('btn-tour-back');
  await waitFor('zurück', () => window.__t.tour().step === 1, 5000);
  check('Back: wieder Schritt 1', (await tour()).title === 'Welcome to SOMA');

  // ---- 3) Jeder Schritt: Ziel vorhanden und hervorgehoben, Karte im Fenster und nicht über dem Ziel ---------------------
  const bad = [];
  const titles = (await tour()).titles;
  for (let n = 1; n <= titles.length; n++) {
    await ev((k) => window.__t.tourGo(k), n);
    await sleep(500);
    s = await tour();
    const inView = s.card.x >= 0 && s.card.y >= 0 && s.card.x + s.card.w <= s.view.w && s.card.y + s.card.h <= s.view.h;
    if (!(s.step === n && s.target && s.spot && inView)) bad.push(`${n} ${s.title}: Ziel ${s.target}, Rahmen ${s.spot}, im Fenster ${inView}`);
  }
  check('Jeder Schritt findet sein Element, hebt es hervor, Karte ganz im Fenster', !bad.length, bad.join(' | '));
  check('Steps: SOMA AI, own agent, code, part, measure, mark up, parameters, history, save, help', titles.join('|')
    === 'Welcome to SOMA|SOMA AI, your agent|While SOMA AI works|Or your own agent|The model is code|Click a part|Measure|Mark up and send|Change a value|History|Save and export|Help is always here', titles.join('|'));

  // Step 5 opens Files and the code, step 9 the parameters
  await ev(() => window.__t.tourGo(5));
  await waitFor('Code offen', () => window.__t.layout().code && window.__t.layout().side === 'files' && window.__t.codeText().includes('add_part'), 10000).catch(() => {});
  check('Step 5 opens Files and model.py, and says the code is optional', (await ev(() => window.__t.layout())).side === 'files' && (await ev(() => window.__t.codeText())).includes('add_part')
    && /You don’t have to read or edit it/.test((await tour()).text));
  await shot('tutorial-step5');

  // Step 6: a click on a part gives the tick, Next works without
  await ev(() => window.__t.tourGo(6));
  await sleep(600);
  check('Step 6 closes code and sidebar, no tick yet', !(await ev(() => window.__t.layout().code)) && !(await tour()).done);
  const pos = await ev(() => {
    const v = window.__t.viewer; const id = window.__t.parts().find((p) => p.name === 'Lid').id;
    const f = v.facesOf(id).filter((x) => x.surface === 'PLANE').sort((a, b) => b.center[2] - a.center[2])[0];
    return v.screenOf(id, f.id);
  });
  await page.click(pos.x, pos.y);
  await waitFor('Auswahl', () => window.__t.info().includes('Lid'), 10000).catch(() => {});
  await waitFor('Haken', () => window.__t.tour().done, 5000).catch(() => {});
  check('Klick auf den Deckel durch die Abdunklung: Auswahl, Haken im Schritt', (await ev(() => window.__t.info())).includes('Lid') && (await tour()).done);
  await shot('tutorial-step6');
  await ev(() => document.getElementById('btn-sel-close').click());

  // Step 7: measuring on, tick, Next switches it off again
  await ev(() => window.__t.tourGo(7));
  await domClick('btn-measure');
  await waitFor('Haken Messen', () => window.__t.tour().done, 5000).catch(() => {});
  check('Step 7: measuring on gives the tick, the target is then the measuring card', (await tour()).done && (await tour()).target);
  await domClick('btn-tour-next');
  await waitFor('Schritt 8', () => window.__t.tour().step === 8, 5000);
  check('Next beendet das Messen', !(await ev(() => window.__t.measure().active)));

  // Step 9: change the height, the tick comes after the build
  await ev(() => window.__t.tourGo(9));
  await waitFor('Parameter', () => window.__t.layout().side === 'params' && !!document.getElementById('pm-HEIGHT'), 20000).catch(() => {});
  await ev(() => { const f = document.getElementById('pm-HEIGHT'); f.focus(); f.value = '35'; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await waitFor('Haken Parameter', () => window.__t.tour().done, 30000).catch(() => {});
  check('Step 9: parameters open, Height 35 gives the tick', (await tour()).done && (await ev(() => window.__t.params().changed)).includes('HEIGHT'));
  await waitFor('gebaut', () => window.__t.status().state === 'ok', 30000).catch(() => {});
  await shot('tutorial-step9');

  // Fehlendes Ziel (Oberfläche geändert): Karte ohne Rahmen in der Mitte
  await ev(() => window.__t.tourGo(12));
  await sleep(300);
  await ev(() => { document.getElementById('btn-help').style.display = 'none'; });
  await sleep(400);
  s = await tour();
  const mid = Math.abs(s.card.x + s.card.w / 2 - s.view.w / 2) < 3 && Math.abs(s.card.y + s.card.h / 2 - s.view.h / 2) < 3;
  check('Ziel fehlt: Karte ohne Rahmen in der Mitte, Tour läuft weiter', s.active && !s.target && !s.spot && mid, JSON.stringify(s.card));
  await ev(() => { document.getElementById('btn-help').style.display = ''; });
  await sleep(300);
  s = await tour();
  check('Letzter Schritt: „Done“ statt Next, Ziel wieder da', s.next === 'Done' && s.target && s.title === 'Help is always here');
  await shot('tutorial-step12');
  await domClick('btn-tour-next');
  await sleep(500);
  check('„Done“ beendet die Tour, Hinweis auf die Hilfe', !(await tour()).active && (await ev(() => window.__t.toast())).text.includes('Help'));
  await waitFor('Karte aus', () => window.__t.appSettings().settings.start.tutorialCard === false, 10000).catch(() => {});
  check('Durchlaufen blendet die Karte der Startseite aus (settings.json neu, alte gesichert)', fileSettings()?.start?.tutorialCard === false
    && fs.readdirSync(path.join(ud, 'workspace-backups')).some((n) => n.startsWith('settings-')));

  // ---- 4) Neu starten aus der Hilfe, Escape und Skip --------------------------------------------------------------------
  await ev(() => window.__t.openHelp());
  await waitFor('Hilfe', () => window.__t.help().open, 10000);
  check('Hilfe hat oben „Start tutorial“', await ev(() => !!document.getElementById('btn-help-tour').getClientRects().length));
  await app.answers([1]);
  await domClick('btn-help-tour');
  await sleep(1500);
  check('Rückfrage bei offenem Modell, Cancel lässt alles, wie es ist', (await ev(() => window.__t.project().id)) === m1.id && !(await tour()).active && (await ev(() => window.__t.help().open)));
  await app.answers([0]);
  await domClick('btn-help-tour');
  await waitFor('zweites Tutorial-Modell', (id) => window.__t.project()?.id !== id && window.__t.status().state === 'ok' && window.__t.tour().active, 90000, m1.id);
  const m2 = await ev(() => window.__t.project());
  s = await tour();
  check('Aus der Hilfe: neues Modell „Tutorial“, Hilfe zu, Schritt 1', m2.name === 'Tutorial' && s.step === 1 && !(await ev(() => window.__t.help().open)));
  check('Geändertes erstes Tutorial-Modell (Height) bleibt', fs.existsSync(m1.dir));
  await ev(() => window.__t.tourGo(2));
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await sleep(300);
  check('Escape beendet die Tour', !(await tour()).active);


  // Hilfe über der Tour: Die Tour wartet unsichtbar
  await app.answers([0]);
  await ev(() => window.__t.openHelp());
  await waitFor('Hilfe', () => window.__t.help().open, 10000);
  await domClick('btn-help-tour');
  await waitFor('drittes Tutorial-Modell', (id) => window.__t.project()?.id !== id && window.__t.status().state === 'ok' && window.__t.tour().active, 90000, m2.id);
  const m3 = await ev(() => window.__t.project());
  const gone = async (dir) => { for (let i = 0; i < 50 && fs.existsSync(dir); i++) await sleep(300); return !fs.existsSync(dir); };
  check('Unverändertes Tutorial-Modell verschwindet beim Wechsel (E69)', await gone(m2.dir));
  await ev(() => window.__t.openHelp());
  await waitFor('Hilfe', () => window.__t.help().open, 10000);
  await sleep(300);
  check('Hilfe offen: Tour verdeckt, läuft weiter', await ev(() => document.getElementById('tour').classList.contains('covered')) && (await tour()).active);
  await ev(() => window.__t.closeHelp());
  await sleep(300);
  await domClick('btn-tour-skip');
  await sleep(300);
  check('Skip beendet die Tour', !(await tour()).active && (await ev(() => window.__t.project().id)) === m3.id);

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 120));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
