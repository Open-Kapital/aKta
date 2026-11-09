export type AtaBlockType = 'paragrafo' | 'lista' | 'decisao' | 'alerta' | 'info';

export interface AtaPerson {
  nome: string;
  iniciais: string;
}

export interface AtaMeta {
  titulo: string;
  serie: string;
  area_sigla: string;
  area_nome: string;
  emitido_por: string;
  modalidade: string;
  confidencialidade: string;
  confidencialidade_detalhe: string;
  /** ISO date (YYYY-MM-DD) */
  data: string;
  data_extenso: string;
  participantes: AtaPerson[];
  documento: string;
  referencia: string;
}

export interface AtaAction {
  descricao: string;
  responsaveis: string[];
  prazo: string;
}

export interface AtaReport {
  resumo: string[];
  secoes: {
    titulo: string;
    topicos: {
      titulo: string;
      blocos: { tipo: AtaBlockType; texto: string; itens: string[] }[];
      acoes: AtaAction[];
    }[];
  }[];
}

export const ORG_NAME = 'Open Kapital';
const GROUP_RESPONSIBLE = 'Time';

const MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function toIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateLong(iso: string): string {
  const d = parseIsoDate(iso);
  return d ? `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}` : iso;
}

function formatMonthYear(iso: string): string {
  const d = parseIsoDate(iso);
  if (!d) return '';
  const month = MONTHS[d.getMonth()];
  return `${month.charAt(0).toUpperCase()}${month.slice(1)}/${d.getFullYear()}`;
}

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** OK_ATA_DDMMAAAA_<AREA>_<TITULO>, following the existing Open Kapital convention. */
export function buildDocumentCode(meta: Pick<AtaMeta, 'data' | 'area_sigla' | 'titulo'>): string {
  const d = parseIsoDate(meta.data);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = d ? `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}` : '';
  return ['OK_ATA', date, slug(meta.area_sigla), slug(meta.titulo)].filter(Boolean).join('_');
}

const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cssString = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const code = (value: string) => esc(value).replace(/_/g, '_<wbr>');

const LOGO_SVG = `<svg class="logo" viewBox="36 58 130 84" xmlns="http://www.w3.org/2000/svg" aria-label="${ORG_NAME}"><circle cx="58" cy="100" r="19.5" fill="#01B8FC"/><polygon points="127,62 161,62 125,100 162,138 128,138 92,100" fill="#0043FC"/></svg>`;

const AVATAR_COLORS = ['#0043FC', '#01B8FC', '#3B5BDB', '#0B1B3F', '#2F80ED', '#00A3C4'];

const FONT_WEIGHTS = [400, 500, 600, 700, 800];

function fontFaceCss(srcFor: (weight: number) => string): string {
  return FONT_WEIGHTS.map(
    (w) => `@font-face{font-family:'Inter';font-style:normal;font-weight:${w};src:url(${srcFor(w)}) format('woff2');}`
  ).join('');
}

/** Font faces pointing at the bundled files (fine for in-app previews). */
export function linkedFontCss(baseUrl: string): string {
  return fontFaceCss((w) => `${baseUrl}/fonts/inter/inter-${w}.woff2`);
}

/** Font faces embedded as base64, so the exported HTML is self-contained. */
export async function embeddedFontCss(): Promise<string> {
  const sources = await Promise.all(
    FONT_WEIGHTS.map(async (w) => {
      const response = await fetch(`/fonts/inter/inter-${w}.woff2`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return [w, `data:font/woff2;base64,${btoa(binary)}`] as const;
    })
  );
  const byWeight = new Map(sources);
  return fontFaceCss((w) => byWeight.get(w) ?? '');
}

const ICONS: Record<'decisao' | 'alerta' | 'info', [string, string]> = {
  decisao: ['Decisão', '<path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'],
  alerta: ['Atenção', '<path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'],
  info: ['Nota', '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6M12 7.6v.3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'],
};

function buildCss(meta: AtaMeta, fontCss: string): string {
  const running = `ATA DE REUNIÃO · ${meta.area_sigla} · ${meta.titulo}`.toUpperCase();
  const footer = `${ORG_NAME} · ${meta.area_sigla} — ${meta.titulo} · ${formatMonthYear(meta.data)}`;
  const conf = (meta.confidencialidade || '').toUpperCase();
  return `${fontCss}
:root{--blue:#0043FC;--cyan:#01B8FC;--ink:#0B1B3F;--text:#26324D;--muted:#6B7A99;--line:#E4E9F3;--soft:#F3F6FE;--green:#0B8F63;--green-soft:#E8F7F1;--amber:#B45309;--amber-soft:#FFF6E5;}
@page{size:A4;margin:20mm 17mm 18mm 17mm;
@top-left{content:"${cssString(running)}";font:600 6.8pt Inter;letter-spacing:.08em;color:#8A97B3;}
@top-right{content:"${cssString(conf)}";font:700 6.8pt Inter;letter-spacing:.12em;color:#0043FC;}
@bottom-left{content:"${cssString(footer)}";font:500 6.8pt Inter;color:#8A97B3;}
@bottom-right{content:"Página " counter(page) " de " counter(pages);font:600 6.8pt Inter;color:#8A97B3;}}
@page :first{margin-top:14mm;@top-left{content:none;}@top-right{content:none;}}
*{box-sizing:border-box;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{margin:0;font-family:Inter,-apple-system,"Segoe UI",sans-serif;color:var(--text);font-size:9.4pt;line-height:1.58;}
@media screen{body{background:#E9EDF5;}.page{width:210mm;max-width:100%;margin:24px auto;background:#fff;padding:16mm 17mm;box-shadow:0 10px 40px rgba(11,27,63,.12);border-radius:6px;}}
.brand{display:flex;align-items:center;justify-content:space-between;padding-bottom:7mm;}
.brand-left{display:flex;align-items:center;gap:10px;}
.logo{height:26px;}
.wordmark{font-weight:700;font-size:13pt;color:var(--ink);letter-spacing:-.01em;}
.area-pill{display:flex;align-items:center;gap:8px;font-size:7.6pt;color:var(--muted);}
.area-pill b{background:var(--ink);color:#fff;font-weight:700;letter-spacing:.1em;padding:3px 8px;border-radius:4px;font-size:7.4pt;}
.hero{position:relative;overflow:hidden;border-radius:14px;padding:9mm 9mm 8mm;color:#fff;background:radial-gradient(120% 140% at 100% 0%,#01B8FC 0%,rgba(1,184,252,0) 55%),linear-gradient(135deg,#0B1B3F 0%,#0033C4 60%,#0043FC 100%);}
.hero::after{content:"";position:absolute;right:-18mm;bottom:-26mm;width:70mm;height:70mm;border-radius:50%;border:14mm solid rgba(255,255,255,.06);}
.eyebrow{font-size:7.6pt;font-weight:700;letter-spacing:.22em;color:#9FE3FF;}
.hero h1{margin:2mm 0 1.5mm;font-size:27pt;line-height:1.08;font-weight:800;letter-spacing:-.02em;}
.hero .sub{font-size:10pt;color:#D6E4FF;}
.hero .sub span{opacity:.55;padding:0 6px;}
.stats{display:flex;gap:7mm;margin-top:7mm;position:relative;z-index:1;}
.stat b{display:block;font-size:17pt;font-weight:800;line-height:1;}
.stat small{font-size:7pt;letter-spacing:.12em;text-transform:uppercase;color:#BFD3FF;}
.meta{display:grid;grid-template-columns:repeat(3,1fr);margin:6mm 0 0;border:1px solid var(--line);border-radius:10px;overflow:hidden;}
.meta div{padding:3.2mm 4mm;border-right:1px solid var(--line);border-bottom:1px solid var(--line);}
.meta div:nth-child(3n){border-right:none;}
.meta div:nth-last-child(-n+3){border-bottom:none;}
.meta label{display:block;font-size:6.6pt;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:1mm;}
.meta span{font-size:8.6pt;color:var(--ink);font-weight:500;}
.meta .code{font-size:7.8pt;letter-spacing:.01em;}
.badge{display:inline-flex;align-items:center;gap:5px;background:#EEF2FF;color:var(--blue)!important;font-weight:700!important;font-size:7.6pt!important;padding:1px 8px;border-radius:99px;}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--blue);}
.people{margin-top:5mm;}
.label{font-size:6.6pt;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:2mm;}
.chips{display:flex;flex-wrap:wrap;gap:2.5mm;}
.chip{display:inline-flex;align-items:center;gap:7px;padding:4px 12px 4px 4px;border:1px solid var(--line);border-radius:99px;}
.chip b{display:block;font-size:8.4pt;color:var(--ink);font-weight:600;line-height:1.15;}
.chip small{display:block;font-size:6.8pt;color:var(--muted);letter-spacing:.08em;line-height:1.2;}
.av{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;border-radius:50%;flex:none;border:1.5px solid #fff;}
.av-sm{width:18px;height:18px;font-size:6.2pt;}
.av-md{width:24px;height:24px;font-size:7.4pt;}
.grp{display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:99px;background:#E9EEF8;color:var(--ink);font-weight:700;font-size:7pt;}
.summary{margin-top:6mm;background:var(--soft);border-radius:12px;padding:5mm 6mm 4mm;break-inside:avoid;}
.summary h4{margin:0 0 2.5mm;font-size:7.4pt;letter-spacing:.18em;text-transform:uppercase;color:var(--blue);}
.summary ol{margin:0;padding:0;list-style:none;counter-reset:s;}
.summary li{counter-increment:s;position:relative;padding-left:9mm;margin-bottom:2.4mm;color:var(--ink);font-weight:500;}
.summary li::before{content:counter(s);position:absolute;left:0;top:.5mm;width:5.4mm;height:5.4mm;border-radius:50%;background:var(--blue);color:#fff;font-size:7pt;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1;}
.sec{margin-top:9mm;}
.sec-head{display:flex;align-items:baseline;gap:4mm;padding-bottom:2.5mm;border-bottom:2px solid var(--ink);margin-bottom:5mm;break-after:avoid;}
.sec-kicker{font-size:7.2pt;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--blue);white-space:nowrap;}
.sec-head h2{margin:0;font-size:15pt;font-weight:800;color:var(--ink);letter-spacing:-.01em;}
.topic{margin-bottom:6.5mm;}
.topic h3{display:flex;align-items:center;gap:3mm;margin:0 0 2.2mm;font-size:11pt;font-weight:700;color:var(--ink);break-after:avoid;}
.num{font-size:8pt;font-weight:800;color:var(--blue);background:#EEF2FF;border-radius:6px;padding:2px 6px;font-variant-numeric:tabular-nums;}
.topic p{margin:0 0 2.4mm;text-align:justify;hyphens:auto;}
.topic ul{margin:0 0 2.6mm;padding:0;list-style:none;}
.topic li{position:relative;padding-left:5.5mm;margin-bottom:1.4mm;}
.topic li::before{content:"";position:absolute;left:1mm;top:2.1mm;width:2.2mm;height:2.2mm;border-radius:50%;background:var(--cyan);}
.action{border:1px solid #D5DEFF;border-left:3px solid var(--blue);background:#FAFBFF;border-radius:8px;padding:2.6mm 3.6mm 1mm;margin:3mm 0 1mm;break-inside:avoid;}
.action-head{display:flex;align-items:center;gap:3mm;margin-bottom:1.2mm;}
.action-label{font-size:6.6pt;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#fff;background:var(--blue);padding:1.5px 7px;border-radius:4px;}
.action-who{display:flex;align-items:center;gap:2px;font-size:7.6pt;font-weight:700;color:var(--ink);}
.action-who>span:last-child{margin-left:5px;}
.action-due{margin-left:auto;font-size:7.2pt;color:var(--muted);font-weight:600;}
.action p{margin:0 0 1.6mm!important;color:var(--ink);font-weight:500;text-align:left!important;}
.callout{display:flex;gap:3mm;border-radius:8px;padding:3mm 4mm 1.2mm;margin:3mm 0;break-inside:avoid;}
.callout .ico{width:15px;height:15px;flex:none;margin-top:1px;}
.callout-label{font-size:6.6pt;font-weight:800;letter-spacing:.16em;text-transform:uppercase;margin-bottom:.6mm;}
.callout p{margin:0 0 1.6mm!important;text-align:left!important;}
.callout.decisao{background:var(--green-soft);color:var(--green);}.callout.decisao p{color:#0B3B2C;font-weight:500;}
.callout.alerta{background:var(--amber-soft);color:var(--amber);}.callout.alerta p{color:#4A2A06;}
.callout.info{background:var(--soft);color:var(--blue);}.callout.info p{color:var(--text);}
.todo{margin-top:9mm;}
table{width:100%;border-collapse:separate;border-spacing:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:8.6pt;}
thead th{background:var(--ink);color:#fff;text-align:left;font-size:6.8pt;letter-spacing:.14em;text-transform:uppercase;font-weight:700;padding:2.6mm 3mm;}
tbody td{padding:2.6mm 3mm;border-top:1px solid var(--line);vertical-align:middle;color:var(--ink);}
tbody tr:nth-child(even) td{background:#F8FAFE;}
tr{break-inside:avoid;}
.c-n{width:9mm;color:var(--blue)!important;font-weight:800;font-variant-numeric:tabular-nums;}
.c-who{width:30mm;}.who{display:flex;align-items:center;gap:2px;}.who-txt{margin-left:5px;font-weight:700;font-size:7.6pt;}
.c-due{width:22mm;color:var(--muted)!important;font-weight:600;white-space:nowrap;}
.c-chk{width:10mm;text-align:center;}
.chk{display:inline-block;width:3.6mm;height:3.6mm;border:1.5px solid #B7C3DB;border-radius:3px;}
.colophon{margin-top:8mm;padding-top:3mm;border-top:1px solid var(--line);display:flex;justify-content:space-between;font-size:7pt;color:var(--muted);}
.colophon b{color:var(--ink);}
`;
}

/** Renders the full, standalone HTML document of an ata. */
export function renderAtaHtml(meta: AtaMeta, report: AtaReport, fontCss: string): string {
  const people = new Map(meta.participantes.map((p) => [p.iniciais, p]));
  const colorOf = new Map(meta.participantes.map((p, i) => [p.iniciais, AVATAR_COLORS[i % AVATAR_COLORS.length]]));

  const avatar = (ini: string, size: 'sm' | 'md' = 'sm') => {
    const person = people.get(ini);
    if (!person) return `<span class="grp">${esc(ini || GROUP_RESPONSIBLE)}</span>`;
    return `<span class="av av-${size}" style="background:${colorOf.get(ini)}" title="${esc(person.nome)}">${esc(ini)}</span>`;
  };

  const callout = (kind: 'decisao' | 'alerta' | 'info', text: string) => {
    const [label, path] = ICONS[kind];
    return `<div class="callout ${kind}"><svg viewBox="0 0 24 24" class="ico">${path}</svg><div><div class="callout-label">${label}</div><p>${esc(text)}</p></div></div>`;
  };

  const block = (b: AtaReport['secoes'][number]['topicos'][number]['blocos'][number]) => {
    const items = (b.itens ?? []).filter((i) => i.trim());
    if (b.tipo === 'lista' || (b.tipo === 'paragrafo' && !b.texto?.trim() && items.length)) {
      return items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
    }
    if (!b.texto?.trim()) return '';
    if (b.tipo === 'paragrafo') return `<p>${esc(b.texto)}</p>`;
    return callout(b.tipo, b.texto);
  };

  const action = (a: AtaAction) => {
    const known = a.responsaveis.filter((r) => people.has(r));
    const avatars = a.responsaveis.map((r) => avatar(r)).join('');
    const who = known.length ? `<span>${esc(known.join(' / '))}</span>` : '';
    return `<div class="action"><div class="action-head"><span class="action-label">Ação</span><span class="action-who">${avatars}${who}</span><span class="action-due">${esc(a.prazo || 'A definir')}</span></div><p>${esc(a.descricao)}</p></div>`;
  };

  const todos: AtaAction[] = [];
  let topicNumber = 0;
  let decisions = 0;
  const sections = report.secoes
    .map((s, si) => {
      const topics = s.topicos
        .map((t) => {
          topicNumber += 1;
          decisions += t.blocos.filter((b) => b.tipo === 'decisao').length;
          todos.push(...t.acoes);
          const body = t.blocos.map(block).join('') + t.acoes.map(action).join('');
          return `<article class="topic"><h3><span class="num">${String(topicNumber).padStart(2, '0')}</span>${esc(t.titulo)}</h3>${body}</article>`;
        })
        .join('');
      return `<section class="sec"><div class="sec-head"><span class="sec-kicker">Seção ${si + 1}</span><h2>${esc(s.titulo)}</h2></div>${topics}</section>`;
    })
    .join('');

  const todoRows = todos
    .map(
      (a, i) =>
        `<tr><td class="c-n">${String(i + 1).padStart(2, '0')}</td><td>${esc(a.descricao)}</td><td class="c-who"><span class="who">${a.responsaveis
          .filter((r) => people.has(r))
          .map((r) => avatar(r))
          .join('')}<span class="who-txt">${esc(a.responsaveis.join(' / '))}</span></span></td><td class="c-due">${esc(a.prazo || 'A definir')}</td><td class="c-chk"><span class="chk"></span></td></tr>`
    )
    .join('');

  const participants = meta.participantes
    .map((p) => `<span class="chip">${avatar(p.iniciais, 'md')}<span><b>${esc(p.nome)}</b><small>${esc(p.iniciais)}</small></span></span>`)
    .join('');

  const stats: [number, string][] = [
    [report.secoes.length, 'Seções'],
    [topicNumber, 'Tópicos'],
    [decisions, 'Decisões'],
    [todos.length, 'Ações'],
  ];
  const conf = [meta.confidencialidade, meta.confidencialidade_detalhe].filter(Boolean).join(' · ');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(meta.documento)}</title><style>${buildCss(meta, fontCss)}</style></head><body><div class="page">
<header class="brand"><div class="brand-left">${LOGO_SVG}<span class="wordmark">${ORG_NAME}</span></div>${meta.area_sigla ? `<div class="area-pill"><b>${esc(meta.area_sigla)}</b>${esc(meta.area_nome)}</div>` : ''}</header>
<div class="hero"><div class="eyebrow">ATA DE REUNIÃO</div><h1>${esc(meta.titulo)}</h1>
<div class="sub">${esc(formatDateLong(meta.data))}<span>•</span>${esc(meta.modalidade)}<span>•</span>${meta.participantes.length} participantes</div>
<div class="stats">${stats.map(([v, l]) => `<div class="stat"><b>${v}</b><small>${l}</small></div>`).join('')}</div></div>
<div class="meta">
<div><label>Data</label><span>${esc(formatDateLong(meta.data))}</span></div>
<div><label>Modalidade</label><span>${esc(meta.modalidade)}</span></div>
<div><label>Emitido por</label><span>${esc(meta.emitido_por)}</span></div>
<div><label>Documento</label><span class="code">${code(meta.documento)}</span></div>
<div><label>Referência</label><span class="code">${meta.referencia ? code(meta.referencia) : '—'}</span></div>
<div><label>Confidencialidade</label><span class="badge">${esc(conf)}</span></div>
</div>
<div class="people"><div class="label">Participantes</div><div class="chips">${participants}</div></div>
${report.resumo.length ? `<div class="summary"><h4>Em resumo</h4><ol>${report.resumo.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
${sections}
${todos.length ? `<section class="todo"><div class="sec-head"><span class="sec-kicker">To-dos</span><h2>Ações e responsáveis</h2></div><table><thead><tr><th>#</th><th>Ação</th><th>Responsável</th><th>Prazo</th><th>Feito</th></tr></thead><tbody>${todoRows}</tbody></table></section>` : ''}
<div class="colophon"><span><b>${esc(meta.documento)}</b></span><span>Gerado pelo aKta a partir da gravação da reunião</span></div>
</div></body></html>`;
}
