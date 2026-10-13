// Linien-Symbole der Oberfläche (24er Raster, Strichstärke per Parameter). Nur feste, eigene Zeichnungen:
// innerHTML ist hier unbedenklich, weil nie Text aus dem Projekt hineinkommt.
const PATHS: Record<string, string> = {
  cube: '<path d="M12 2.5 20.5 7.2v9.6L12 21.5l-8.5-4.7V7.2z"/><path d="M3.5 7.2 12 12l8.5-4.8M12 12v9.5"/>',
  // Marke von SOMA (E44): der Würfel als Sprechblase mit gefülltem Deckel
  logo: '<path d="M12 2.6 19.9 7.1 12 11.6 4.1 7.1z" fill="currentColor"/><path d="M12 2.6 19.9 7.1v9L12 20.6l-4.3-2.45-5.3 3.2 1.7-7.5V7.1z"/><path d="M4.1 7.1 12 11.6l7.9-4.5M12 11.6v9"/>',
  down: '<path d="m6 9 6 6 6-6"/>', up: '<path d="m6 15 6-6 6 6"/>', right: '<path d="m9 6 6 6-6 6"/>', left: '<path d="m15 6-6 6 6 6"/>',
  key: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>',
  // Strukturbaum (E82): Wurzel mit zwei Zweigen
  tree: '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="13" y="10.5" width="8" height="4.5" rx="1"/><rect x="13" y="17" width="8" height="4.5" rx="1"/><path d="M6.5 8v11.2H13M6.5 12.7H13"/>',
  // Bericht der Analyse (E82): hält, hält nicht, Kraft als Beschriftung im Bild, weitere Befehle
  okcirc: '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8L16.2 9.6"/>',
  xcirc: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  force: '<path d="M12 20.5V4.5M6.5 10 12 4.5l5.5 5.5"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5"/><path d="M20 3.5v5h-5"/>',
  export: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>',
  import: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  book: '<path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z"/><path d="M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z"/>',
  pkg: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  // Zahnrad für „Options“ (Entwurf 2, cogPath), seit „sliders“ für die Parameter steht
  cog: '<path d="M21.42 10.17L21.42 13.83L18.89 14.11L18.36 15.38L19.96 17.37L17.37 19.96L15.38 18.36L14.11 18.89L13.83 21.42L10.17 21.42L9.89 18.89L8.62 18.36L6.63 19.96L4.04 17.37L5.64 15.38L5.11 14.11L2.58 13.83L2.58 10.17L5.11 9.89L5.64 8.62L4.04 6.63L6.63 4.04L8.62 5.64L9.89 5.11L10.17 2.58L13.83 2.58L14.11 5.11L15.38 5.64L17.37 4.04L19.96 6.63L18.36 8.62L18.89 9.89Z"/><circle cx="12" cy="12" r="3"/>',
  // Zurück auf den Wert aus dem Code (Parameter, Entwurf 2)
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 3.5v5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  section: '<path d="M5 9 12 5l7 4v8l-7 4-7-4z"/><path d="M2 13h20"/>',
  explode: '<rect x="9" y="9" width="6" height="6" rx="1"/><path d="M4 4l3 3M20 4l-3 3M4 20l3-3M20 20l-3-3M4 8V4h4M16 4h4v4M4 16v4h4M20 16v4h-4"/>',
  flip: '<path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  term: '<path d="m5 8 4 4-4 4M12 16h7"/>', panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  // Seitenleiste links (Spalten-Schalter der Kopfzeile, Gegenstück zu panel für den Agenten)
  sidel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  // Kategorien der Skills: Arbeitsweise (Weg mit Start und Ziel), Fertigung (Schraubenschlüssel), Konstruktionswissen (Zirkel)
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/>',
  wrench: '<path d="M15 4.5a4.5 4.5 0 0 0-4.3 5.8L4 17a2.1 2.1 0 0 0 3 3l6.7-6.7A4.5 4.5 0 0 0 19.5 9l-2.8 2.8-3.2-.7-.7-3.2z"/>',
  compass: '<circle cx="12" cy="4.5" r="2"/><path d="m10.9 6.3-5.4 14.2M13.1 6.3l5.4 14.2M7.8 14.5h8.4"/>',
  target: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L5 20"/>',
  alert: '<path d="M12 4 2 20h20z"/><path d="M12 10v4M12 17v.01"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  // Dateitypen im Dateibaum: eine eigene, große Form je Typ, damit sie auch bei 15 px auseinanderzuhalten sind
  'f-py': '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/>',
  'f-text': '<path d="M5 6h14M5 10h14M5 14h14M5 18h9"/>',
  'f-table': '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M10 9.5v10"/>',
  'f-data': '<path d="M9 4C7 4 6.5 5 6.5 7s0 3.5-2.5 5c2.5 1.5 2.5 3 2.5 5s.5 3 2.5 3M15 4c2 0 2.5 1 2.5 3s0 3.5 2.5 5c-2.5 1.5-2.5 3-2.5 5s-.5 3-2.5 3"/>',
  'f-cad': '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  'f-mesh': '<path d="M12 3.5 21 19.5H3z"/><path d="M7.5 11.5h9M12 19.5l-4.5-8M12 19.5l4.5-8"/>',
  'f-draw': '<path d="M12 3 5.5 13.5 12 21l6.5-7.5z"/><circle cx="12" cy="13" r="2"/><path d="M12 3v8"/>',
  'f-image': '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L5 20"/>',
  'f-pdf': '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9.5 18v-7H12a2 2 0 0 1 0 4H9.5"/>',
  'f-zip': '<rect x="3.5" y="4" width="17" height="5" rx="1"/><path d="M5 9v10.5h14V9M10 13h4"/>',
  'f-lock': '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  fileplus: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>',
  folderplus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v6M9 13.5h6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  openext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  // Speicherplatz in den Einstellungen (E81): Festplatte
  disk: '<path d="M3 14 6 5h12l3 9"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 17h.01M11 17h6"/>', spin: '<path d="M12 3a9 9 0 1 1-9 9"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  // Animation, Analyse und Video (E58)
  pause: '<path d="M8 5v14M16 5v14"/>',
  anim: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  // Zeichnungen (E76): Blatt quer mit Schriftfeld unten rechts und einer Ansicht
  drawing: '<rect x="2.5" y="4.5" width="19" height="15" rx="1"/><path d="M13 19.5v-4.5h8.5"/><rect x="5.5" y="8" width="5" height="4.5"/><path d="M13.5 10.2h4.5"/>',
  gauge: '<path d="M4.2 17a8.5 8.5 0 1 1 15.6 0"/><path d="m12 14 4.5-5"/><circle cx="12" cy="14" r="1.2"/>',
  stepback: '<path d="M18 6v12l-8-6zM6 6v12"/>', stepfwd: '<path d="M6 6v12l8-6zM18 6v12"/>',
  loop: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>',
  'f-video': '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  // Werkzeuge der Markierung
  pointer: '<path d="M6 3v16l4.2-4.1 2.9 6.2 2.6-1.2-2.9-6.1H18.5z"/>',
  ghost: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" fill-opacity=".45"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', arrow: '<path d="M5 19 19 5M9 5h10v10"/>', line: '<path d="M5 19 19 5"/>',
  grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="1.5"/>', circle: '<circle cx="12" cy="12" r="8"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>', undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  // PDF-Ansicht: alle Seiten untereinander, eine Seite, Vorschauleiste, Seitenbreite und ganze Seite einpassen
  pages: '<rect x="6" y="2.5" width="12" height="8" rx="1"/><rect x="6" y="13.5" width="12" height="8" rx="1"/>',
  page1: '<rect x="5.5" y="3" width="13" height="18" rx="1.5"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  thumbs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M5.3 8h1.4M5.3 12h1.4M5.3 16h1.4"/>',
  fitw: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 12h10M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5"/>',
  fitp: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><rect x="7.5" y="6" width="9" height="12" rx="1"/>',
};

export function icon(name: string, size = 16, stroke = 1.8): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ic');
  svg.innerHTML = PATHS[name] ?? '';
  return svg;
}

/** Ersetzt `<i data-icon="name" data-size="16">` im statischen HTML durch das Symbol. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((i) => {
    i.replaceWith(icon(i.dataset.icon!, Number(i.dataset.size ?? 16), Number(i.dataset.stroke ?? 1.8)));
  });
}
