// web_fetch for SOMA AI (loaded by soma.ts): reads a web page as text or downloads a file into the model folder.
// Without it the agent wrote its own Python scripts against search engines and shop pages, which skipped SOMA's question
// before going online (only curl and wget ask) and tried to get around blocked pages by posing as Googlebot (tested
// 2026-11-25). This tool asks once per website, says honestly who is asking, never goes to the user's own network and
// reports a refusal instead of working around it. Only Node's own modules, so test/unit.mjs can bundle it.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Characters of text per call. A shop page is often 50 000 and more: the agent reads on with `offset`. */
export const PAGE_CHARS = 20_000;
const MAX_TEXT_BYTES = 8 * 1024 ** 2;
/** A STEP file of a large assembly can be 100 MB and more, a download of half a gigabyte is a mistake. */
export const MAX_DOWNLOAD_BYTES = 500 * 1024 ** 2;
const MAX_REDIRECTS = 8;
const TEXT_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

// ---- Where a request may go -----------------------------------------------------------------------------------------

/**
 * Addresses of this computer and the local network (router, NAS, SOMA's own bridge on 127.0.0.1). A page from the
 * internet could otherwise point the agent at them. True also for what is not an IP address at all.
 */
export function isLocalAddress(ip: string): boolean {
  let a = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || p >= 224
      || (p === 100 && q >= 64 && q <= 127) // shared address space of providers (CGNAT)
      || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168)
      || (p === 198 && (q === 18 || q === 19));
  }
  if (net.isIPv6(a)) {
    if (a === '::' || a === '::1') return true;
    // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast, also IPv4 in other IPv6 forms (::7f00:1)
    return /^(f[cd]|fe[89ab]|ff)/.test(a) || /^::(ffff:)?[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a);
  }
  return true;
}

/** Tests can let SOMA AI read from a server on 127.0.0.1 (test/somaai.mjs). Never set in the app. */
const localAllowed = () => process.env.SOMA_TEST_WEB_LOCAL === '1';
const proxied = () => ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => !!process.env[k]);

/** Null when the address may be opened, otherwise why not, in words for the agent. */
export async function refuseUrl(u: URL): Promise<string | null> {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `Only web addresses (https://…) can be opened, not ${u.protocol}.`;
  if (u.username || u.password) return 'Addresses with a user name or password in them are not opened.';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = 'It points at this computer or the local network, which SOMA AI does not reach.';
  if (localAllowed()) return null;
  if (net.isIP(host)) return isLocalAddress(host) ? local : null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return local;
  let found: { address: string }[];
  try { found = await dns.lookup(host, { all: true }); }
  catch {
    // Behind a proxy the computer itself often cannot look up names: the proxy does
    return proxied() ? null : `The website ${host} was not found. Check the address.`;
  }
  return found.some((f) => isLocalAddress(f.address)) ? local : null;
}

// ---- From HTML to text ----------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
  trade: '™', deg: '°', plusmn: '±', times: '×', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾', euro: '€', pound: '£',
  laquo: '«', raquo: '»', bull: '•', middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', oslash: 'ø', Oslash: 'Ø',
  sup2: '²', sup3: '³', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
};

const absolute = (href: string, base: URL) => { try { return new URL(href, base).href; } catch { return ''; } };

/** Links to files a designer wants from a product page: CAD models, drawings, data sheets. */
export const FILE_LINK = /\.(step|stp|stpz|iges|igs|stl|3mf|obj|dxf|dwg|sldprt|sldasm|x_t|sat|zip|pdf)(?:$|[?#])/i;

/** Product facts from schema.org data (JSON-LD), which most shops put into their pages for search engines. */
export function productFacts(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 6 || out.length >= 12) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    const type = ([] as unknown[]).concat(o['@type'] ?? []).map(String);
    if (type.some((t) => /^(Product|ProductModel|IndividualProduct)$/.test(t))) {
      const offers = ([] as unknown[]).concat(o.offers ?? []).flatMap((x) => {
        const f = x as Record<string, unknown>;
        return ([] as unknown[]).concat(f?.offers ?? f ?? []);
      }) as Record<string, unknown>[];
      const brand = o.brand && typeof o.brand === 'object' ? (o.brand as Record<string, unknown>).name : o.brand;
      const prices = offers.map((f) => {
        const p = f?.price ?? f?.lowPrice ?? (f?.priceSpecification as Record<string, unknown> | undefined)?.price;
        const cur = f?.priceCurrency ?? (f?.priceSpecification as Record<string, unknown> | undefined)?.priceCurrency ?? '';
        const avail = typeof f?.availability === 'string' ? ` (${String(f.availability).replace(/^.*\//, '')})` : '';
        return p !== undefined && p !== '' ? `${p} ${cur}`.trim() + avail : '';
      }).filter(Boolean);
      const line = [
        o.name ? `name: ${String(o.name)}` : '', brand ? `brand: ${String(brand)}` : '',
        o.sku ? `sku: ${String(o.sku)}` : '', o.mpn ? `mpn: ${String(o.mpn)}` : '', o.gtin13 ?? o.gtin ? `gtin: ${String(o.gtin13 ?? o.gtin)}` : '',
        prices.length ? `price: ${[...new Set(prices)].slice(0, 4).join(', ')}` : '',
      ].filter(Boolean).join('; ');
      if (line && !seen.has(line)) { seen.add(line); out.push(decodeEntities(line)); }
    }
    for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant']) if (k in o) visit(o[k], depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim()), 0); } catch { /* broken data on the page: the text below still has it */ }
  }
  return out;
}

export interface PageText { title: string; text: string; files: string[]; facts: string[]; scripted: boolean }

/**
 * A web page as plain text with Markdown-like headings, lists and links. No browser: content that a page builds with
 * JavaScript is missing, `scripted` says when that is likely.
 */
export function htmlToText(html: string, base: URL): PageText {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const facts = productFacts(html);
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const files: string[] = [];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|object|canvas|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(img)\b[^>]*>/gi, (tag) => { const alt = attr(tag, 'alt'); return alt ? ` [image: ${alt}] ` : ' '; });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, at: string, inner: string) => {
    const href = absolute(attr(`<a ${at}>`, 'href'), base);
    const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href || /^(javascript|mailto|tel):/i.test(href)) return ` ${label} `;
    if (FILE_LINK.test(new URL(href).pathname) && !files.includes(href)) files.push(href);
    return label ? ` [${label}](${href}) ` : ' ';
  });
  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|nav|main|aside|ul|ol|table|tr|thead|tbody|dl|dt|dd|form|fieldset|figure|figcaption|blockquote|pre|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter((l, i, a) => l || (a[i - 1] ?? '') !== '')
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text, files, facts, scripted: text.length < 600 && scripts >= 3 };
}

// ---- The request ----------------------------------------------------------------------------------------------------

export interface Fetched { response: Response; url: URL; redirects: string[] }

/** GET with redirects followed by hand, so every hop is checked like the first address. */
export async function fetchChecked(start: URL, signal: AbortSignal, userAgent: string, accept: string): Promise<Fetched | string> {
  let url = start;
  const redirects: string[] = [];
  for (let hop = 0; ; hop++) {
    const refused = await refuseUrl(url);
    if (refused) return hop ? `The website sent SOMA AI on to ${url.href}. ${refused}` : refused;
    const response = await fetch(url, {
      redirect: 'manual', signal,
      headers: { 'user-agent': userAgent, accept, 'accept-language': 'en;q=0.9, *;q=0.5' },
    });
    const to = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && to) {
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) return `The website redirected more than ${MAX_REDIRECTS} times.`;
      try { url = new URL(to, url); } catch { return `The website redirected to an invalid address: ${to.slice(0, 200)}`; }
      redirects.push(url.href);
      continue;
    }
    return { response, url, redirects };
  }
}

/** What a refusal of the website means for the agent: no attempts to get around it. */
export function refusalText(status: number, url: URL): string {
  const site = url.hostname;
  if (status === 401 || status === 403) {
    return `${site} refused the request (HTTP ${status}). The page needs a sign-in or the site does not let programs read it. `
      + 'Do not try to get around this (other addresses, another user agent, proxies, scripts). Tell the person and ask them to '
      + 'open the page in their browser and download the file themselves, then drag it into SOMA.';
  }
  if (status === 429) return `${site} says there were too many requests (HTTP 429). Wait, or ask the person to open the page themselves.`;
  if (status === 404 || status === 410) return `${site} has no page at this address (HTTP ${status}).`;
  return `${site} answered with an error (HTTP ${status}).`;
}

/** Reads a body up to `max` bytes, then stops. */
export async function readLimited(response: Response, max: number): Promise<{ data: Buffer; cut: boolean }> {
  const parts: Buffer[] = [];
  let size = 0;
  let cut = false;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { parts.push(Buffer.from(value.subarray(0, value.byteLength - (size - max)))); cut = true; await reader.cancel().catch(() => {}); break; }
      parts.push(Buffer.from(value));
    }
  }
  return { data: Buffer.concat(parts), cut };
}

const charsetOf = (type: string) => /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1]?.toLowerCase() ?? '';

export function decodeBody(data: Buffer, type: string): string {
  let cs = charsetOf(type) || /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(data.subarray(0, 4096).toString('latin1'))?.[1]?.toLowerCase() || 'utf-8';
  if (cs === 'utf8') cs = 'utf-8';
  try { return new TextDecoder(cs).decode(data); } catch { return new TextDecoder('utf-8').decode(data); }
}

/** What a downloaded file is, from its first bytes: a web page where a file was expected is the usual mistake. */
export function sniff(head: Buffer): string {
  // A byte order mark and comments in front of the page do not make it a file
  const s = head.subarray(0, 512).toString('latin1').replace(/^\xEF\xBB\xBF/, '').replace(/^\s*(<!--[\s\S]*?-->\s*)+/, '');
  if (s.startsWith('version https://git-lfs')) return 'LFS';
  if (s.startsWith('ISO-10303-21')) return 'STEP';
  if (s.startsWith('PK\x03\x04')) return 'ZIP';
  if (s.startsWith('%PDF')) return 'PDF';
  if (/^\s*solid\b/i.test(s)) return 'STL (text)';
  if (/^\s*(<!doctype html|<html|<head|<body)/i.test(s)) return 'HTML';
  return '';
}

/**
 * Where a download goes: inside the model folder, never over an existing file (SOMA does not silently overwrite).
 * Returns the full path or why not.
 */
export function downloadTarget(cwd: string, want: string): { file: string } | { error: string } {
  // The path is shown in the question to the person: a line break could fake another line there ("site : …")
  if (/[\x00-\x1f\x7f]/.test(want)) return { error: `"${want.replace(/[\x00-\x1f\x7f]/g, ' ')}" contains control characters. Give a plain file name.` };
  const root = path.resolve(cwd);
  const file = path.resolve(root, want);
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { error: `"${want}" is not inside the model folder. Save downloads there, usually in inputs/.` };
  // Windows and macOS ignore case, Windows drops trailing dots and spaces: ".GIT" and ".git." are .git too
  const first = rel.split(path.sep)[0].toLowerCase().replace(/[. ]+$/, '');
  if (first === '.git' || first === '.soma') return { error: `"${want}" is a folder SOMA keeps for itself.` };
  if (fs.existsSync(file)) return { error: `${rel.split(path.sep).join('/')} already exists. Choose another name, SOMA does not overwrite files.` };
  return { file };
}

/** Saves the body into `file` (through a temporary file next to it), at most `max` bytes. */
export async function saveBody(response: Response, file: string, max: number): Promise<{ bytes: number; kind: string } | { error: string }> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A name of its own: an existing .part (a crash, a second download to the same place) is not ours to delete
  const part = `${file}.${process.pid}-${Date.now().toString(36)}.part`;
  let bytes = 0;
  let head = Buffer.alloc(0);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (head.length < 512) head = Buffer.concat([head, chunk.subarray(0, 512 - head.length)]);
      if (bytes > max) { done(new Error('too large')); return; }
      done(null, chunk);
    },
  });
  try {
    if (!response.body) throw new Error('The website sent no data.');
    await pipeline(Readable.fromWeb(response.body as never), counter, fs.createWriteStream(part, { flags: 'wx' }));
  } catch (e) {
    fs.rmSync(part, { force: true });
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg === 'too large' ? `The file is larger than ${Math.round(max / 1024 ** 2)} MB, it was not saved.` : `The download failed: ${msg}` };
  }
  const kind = sniff(head);
  if (kind === 'LFS') {
    fs.rmSync(part, { force: true });
    return { error: 'The address gave a Git LFS pointer, not the file itself. Nothing was saved. Look for a "raw" or "media" download link of the file.' };
  }
  if (kind === 'HTML' || (!kind && /^text\/html\b/i.test(response.headers.get('content-type') ?? ''))) {
    fs.rmSync(part, { force: true });
    return { error: 'The address gave a web page, not a file (often a sign-in page or a page that builds the download link with JavaScript). Nothing was saved. Read the page with web_fetch without `path` to find the real file link, or ask the person to download it.' };
  }
  if (fs.existsSync(file)) { fs.rmSync(part, { force: true }); return { error: 'A file with this name appeared meanwhile. Nothing was overwritten.' }; }
  fs.renameSync(part, file);
  return { bytes, kind };
}

export const sizeText = (n: number) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** One page of a long text, with how to read on. */
export function pageOf(text: string, offset: number): string {
  const start = Math.max(0, Math.min(offset, text.length));
  const end = Math.min(text.length, start + PAGE_CHARS);
  const part = text.slice(start, end);
  return end < text.length ? `${part}\n\n[… ${text.length - end} more characters. Call web_fetch again with offset ${end} to read on.]` : part;
}

export { TEXT_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, MAX_TEXT_BYTES };
