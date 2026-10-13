// Bilder der Anleitung (resources/help/*.png): Ausschnitt und nummerierte Markierungen je Bild. Die Anleitung
// (resources/skills/soma-app.md) erklärt unter jedem Bild die Nummern als Liste „1. **Bezeichnung**: …“. Die Bezeichnungen
// hier und dort müssen gleich sein, test/unit.mjs prüft das. Erzeugt werden die Bilder mit `npm run help:shots`.
//
// `clip`: Selektoren, deren gemeinsamer Rahmen das Bild ist (ohne: ganzes Fenster), `pad` Rand darum in CSS-Pixeln,
// `clipWidth` und `clipHeight` ersetzen Breite oder Höhe dieses Rahmens.
// Je Markierung `sel` (ein Selektor oder mehrere, dann der gemeinsame Rahmen), `at` die Stelle der Nummer am Rahmen
// (tl, t, tr, r, br, b, bl, l, c), `box` zeichnet den Rahmen gestrichelt mit (für Bereiche statt einzelner Knöpfe).

export const SHOTS = [
  {
    file: 'window.png',
    marks: [
      { label: 'Model menu', sel: '#btn-doc', at: 'tr', box: true },
      { label: 'Build status', sel: '#build-pill', at: 'b', box: true },
      { label: 'Columns', sel: '#layout', at: 'b', box: true },
      { label: 'Import', sel: '#btn-import', at: 'b' },
      { label: 'Export', sel: '#btn-export', at: 'b' },
      { label: 'Save', sel: '#btn-save', at: 'b' },
      { label: 'Sidebar', sel: '#rail', at: 'r', box: true },
      { label: 'Structure tree', sel: '#tree', at: 'r' },
      { label: 'Tools', sel: '#dock', at: 'b', box: true },
      { label: 'View cube', sel: '#cube', at: 'l', box: true },
      { label: 'History', sel: '#versions', at: 't', box: true },
      { label: 'Agent', sel: '#terminals', at: 'c', box: true },
    ],
  },
  {
    file: 'start.png',
    marks: [
      { label: 'Tutorial', sel: '#start-tour', at: 'tr', box: true },
      { label: 'New model', sel: '#start-new', at: 'tr', box: true },
      { label: 'Open', sel: '#start-open', at: 'tr', box: true },
      { label: 'Recent', sel: '#start-recent', at: 'tr', box: true },
      { label: 'Agents on this computer', sel: '.start-side .panel-card', at: 'tr', box: true },
      { label: 'Help', sel: '#btn-start-help', at: 'b' },
      { label: 'Settings', sel: '#btn-start-settings', at: 'b' },
      { label: 'Back to the model', sel: '#btn-start-close', at: 'b' },
    ],
  },
  {
    file: 'agent.png',
    clip: ['#terminals', '#menu-agents'],
    clipHeight: 420,
    marks: [
      { label: 'Tabs', sel: '#term-tabs .tab', at: 'b' },
      { label: 'New tab', sel: '#btn-term-add', at: 'r' },
      { label: 'Start agent', sel: '#agent-list', at: 'r', box: true },
      { label: 'Empty terminal', sel: '#btn-term-plain', at: 'r' },
    ],
  },
  {
    file: 'viewer.png',
    clip: ['#viewer'],
    marks: [
      { label: 'Structure tree', sel: '#tree', at: 'r', box: true },
      { label: 'Hide and transparent', sel: '#tree .tr-row .tg', at: 'l' },
      { label: 'Selection card', sel: '#selcard', at: 'tr', box: true },
      { label: 'Send to agent', sel: '#btn-sel-agent', at: 'r' },
      { label: 'View cube', sel: '#cube-view', at: 'l' },
      { label: 'Fit, default view, display', sel: '#cube .vbtns', at: 'l', box: true },
    ],
  },
  {
    file: 'tools.png',
    clip: ['#viewer'],
    marks: [
      { label: 'Measure', sel: '#btn-measure', at: 'b' },
      { label: 'Section', sel: '#btn-section', at: 'b' },
      { label: 'Explode', sel: '#btn-explode', at: 'b' },
      { label: 'Mark up', sel: '#btn-mark', at: 'b' },
      { label: 'Tool card', sel: '#section-card', at: 'tr', box: true },
    ],
  },
  {
    file: 'markup.png',
    clip: ['#viewer'],
    marks: [
      { label: 'Drawing tools', sel: '#mark-tools [data-tool]', at: 'b', box: true },
      { label: 'Color', sel: '#btn-mark-color', at: 'b' },
      { label: 'Undo and delete', sel: ['#btn-mark-undo', '#btn-mark-delete'], at: 'b' },
      { label: 'Grid and blank canvas', sel: ['#btn-mark-grid', '#btn-mark-blank'], at: 'b' },
      { label: 'Cancel', sel: '#btn-mark-cancel', at: 't' },
      { label: 'Send to agent', sel: '#btn-mark-send', at: 't' },
    ],
  },
  {
    file: 'sidebar.png',
    clip: ['#rail'],
    clipWidth: 104,
    marks: [
      { label: 'Parameters', sel: '#rail [data-panel=params]', at: 'r' },
      { label: 'Files', sel: '#rail [data-panel=files]', at: 'r' },
      { label: 'Analysis', sel: '#rail [data-panel=analysis]', at: 'r' },
      { label: 'Animation', sel: '#rail [data-panel=anim]', at: 'r' },
      { label: 'Skills', sel: '#rail [data-panel=skills]', at: 'r' },
      { label: 'Help', sel: '#btn-help', at: 'r' },
      { label: 'Settings', sel: '#btn-settings', at: 'r' },
    ],
  },
  {
    file: 'code.png',
    clip: ['#side', '#editor'],
    marks: [
      { label: 'File tree', sel: '#tab-files', at: 'c', box: true },
      { label: 'Drop zone', sel: '#dropzone', at: 't' },
      { label: 'Open files', sel: '#code-tabs', at: 'r' },
      { label: 'Linked to selection', sel: '#btn-codelink', at: 'l' },
      { label: 'Editor', sel: '#code-view', at: 'c', box: true },
    ],
  },
  {
    file: 'history.png',
    clip: ['#preview-banner', '#versions'],
    pad: 14,
    marks: [
      { label: 'Timeline', sel: '#vtrack', at: 't', box: true },
      { label: 'Back to now', sel: '#btn-live', at: 't' },
      { label: 'Restore', sel: '#btn-restore', at: 't' },
    ],
  },
  {
    file: 'export.png',
    clip: ['#btn-export', '#menu-export'],
    pad: 28,
    marks: [
      { label: 'Scope', sel: '#menu-export .seg', at: 'l' },
      { label: 'Formats', sel: '#menu-export .chips', at: 'l', box: true },
      { label: 'Everything as ZIP', sel: '#exp-zip', at: 'l' },
    ],
  },
  {
    file: 'settings.png',
    clip: ['.st-dlg'],
    clipHeight: 420,
    marks: [
      { label: 'Viewer', sel: '#st-nav [data-sec=viewer]', at: 'r' },
      { label: 'Shortcuts', sel: '#st-nav [data-sec=keys]', at: 'r' },
      { label: 'Skills', sel: '#st-nav [data-sec=skills]', at: 'r' },
      { label: 'Storage', sel: '#st-nav [data-sec=storage]', at: 'r' },
      { label: 'About', sel: '#st-nav [data-sec=about]', at: 'r' },
    ],
  },
];
