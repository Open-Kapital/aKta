'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, FileDown, FileText, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type AtaMeta,
  type AtaReport,
  buildDocumentCode,
  embeddedFontCss,
  formatDateLong,
  linkedFontCss,
  renderAtaHtml,
  toIsoDate,
} from '@/lib/akta/ata';
import { AddPersonForm, usePeople } from './PeopleManager';

const LAST_META_KEY = 'akta.ata.lastMeta';

type SharedDefaults = Pick<
  AtaMeta,
  'area_sigla' | 'area_nome' | 'emitido_por' | 'modalidade' | 'confidencialidade' | 'confidencialidade_detalhe'
>;

const FALLBACK_DEFAULTS: SharedDefaults = {
  area_sigla: 'NTA',
  area_nome: 'Núcleo de Tecnologia Aplicada',
  emitido_por: 'Open Kapital — Gestora do TRIP11',
  modalidade: 'Presencial',
  confidencialidade: 'Restrito',
  confidencialidade_detalhe: 'Uso interno',
};

function readSharedDefaults(): SharedDefaults {
  try {
    const raw = localStorage.getItem(LAST_META_KEY);
    return raw ? { ...FALLBACK_DEFAULTS, ...JSON.parse(raw) } : FALLBACK_DEFAULTS;
  } catch {
    return FALLBACK_DEFAULTS;
  }
}

function writeSharedDefaults(meta: AtaMeta) {
  const shared: SharedDefaults = {
    area_sigla: meta.area_sigla,
    area_nome: meta.area_nome,
    emitido_por: meta.emitido_por,
    modalidade: meta.modalidade,
    confidencialidade: meta.confidencialidade,
    confidencialidade_detalhe: meta.confidencialidade_detalhe,
  };
  try {
    localStorage.setItem(LAST_META_KEY, JSON.stringify(shared));
  } catch {
    // Defaults are a convenience only.
  }
}

function initialMeta(meeting: { title?: string; created_at?: string }, title: string): AtaMeta {
  const created = meeting.created_at ? new Date(meeting.created_at) : new Date();
  const data = toIsoDate(Number.isNaN(created.getTime()) ? new Date() : created);
  return {
    ...readSharedDefaults(),
    titulo: title,
    serie: title,
    data,
    data_extenso: formatDateLong(data),
    participantes: [],
    documento: '',
    referencia: '',
  };
}

function withDerived(meta: AtaMeta): AtaMeta {
  return { ...meta, data_extenso: formatDateLong(meta.data), documento: buildDocumentCode(meta) };
}

interface ReportRecord {
  meta: AtaMeta | null;
  report: AtaReport | null;
  updatedAt: string | null;
}

interface AtaPanelProps {
  meeting: { id: string; title?: string; created_at?: string };
  meetingTitle: string;
}

export function AtaPanel({ meeting, meetingTitle }: AtaPanelProps) {
  const { people, refresh: refreshPeople } = usePeople();
  const [meta, setMeta] = useState<AtaMeta>(() => initialMeta(meeting, meetingTitle || meeting.title || ''));
  const [report, setReport] = useState<AtaReport | null>(null);
  const [formOpen, setFormOpen] = useState(true);
  const [busy, setBusy] = useState<'generate' | 'export' | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    invoke<ReportRecord>('akta_report_get', { meetingId: meeting.id })
      .then((record) => {
        if (cancelled) return;
        const base = initialMeta(meeting, meetingTitle || meeting.title || '');
        setMeta(record.meta ? { ...base, ...record.meta } : base);
        setReport(record.report);
        setFormOpen(!record.report);
      })
      .catch((err) => console.error('Failed to load ata:', err))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);

  useEffect(() => {
    if (!loaded || meta.referencia || !meta.serie.trim()) return;
    invoke<AtaMeta | null>('akta_report_previous', { meetingId: meeting.id, serie: meta.serie })
      .then((previous) => {
        if (previous?.documento) setMeta((m) => (m.referencia ? m : { ...m, referencia: previous.documento }));
      })
      .catch(() => undefined);
  }, [loaded, meeting.id, meta.serie, meta.referencia]);

  const derived = useMemo(() => withDerived(meta), [meta]);
  const update = (patch: Partial<AtaMeta>) => setMeta((m) => ({ ...m, ...patch }));

  const togglePerson = (nome: string, iniciais: string) => {
    setMeta((m) => {
      const selected = m.participantes.some((p) => p.iniciais === iniciais);
      const participantes = selected
        ? m.participantes.filter((p) => p.iniciais !== iniciais)
        : [...m.participantes, { nome, iniciais }].sort((a, b) => a.nome.localeCompare(b.nome));
      return { ...m, participantes };
    });
  };

  const previewHtml = useMemo(() => {
    if (!report || typeof window === 'undefined') return '';
    return renderAtaHtml(derived, report, linkedFontCss(window.location.origin));
  }, [derived, report]);

  const generate = useCallback(async () => {
    if (derived.participantes.length === 0) {
      toast.error('Selecione os participantes da reunião');
      return;
    }
    setBusy('generate');
    try {
      writeSharedDefaults(derived);
      const result = await invoke<AtaReport>('akta_report_generate', { meetingId: meeting.id, meta: derived });
      setReport(result);
      setFormOpen(false);
      toast.success('Ata gerada');
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  }, [derived, meeting.id]);

  const saveMeta = useCallback(async () => {
    try {
      await invoke('akta_report_save_meta', { meetingId: meeting.id, meta: derived });
      writeSharedDefaults(derived);
      toast.success('Dados da ata salvos');
    } catch (err) {
      toast.error(String(err));
    }
  }, [derived, meeting.id]);

  const exportPdf = useCallback(async () => {
    if (!report) return;
    setBusy('export');
    try {
      await invoke('akta_report_save_meta', { meetingId: meeting.id, meta: derived });
      const html = renderAtaHtml(derived, report, await embeddedFontCss());
      await invoke('akta_report_open_print', { html, fileName: derived.documento });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  }, [derived, meeting.id, report]);

  const field = (label: string, key: keyof SharedDefaults | 'titulo' | 'serie' | 'referencia', placeholder?: string) => (
    <div>
      <Label className="text-xs text-gray-600">{label}</Label>
      <Input
        className="mt-1"
        value={String(meta[key] ?? '')}
        placeholder={placeholder}
        onChange={(e) => update({ [key]: e.target.value } as Partial<AtaMeta>)}
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
        <button
          className="flex items-center gap-2 text-sm font-semibold text-gray-900"
          onClick={() => setFormOpen((v) => !v)}
        >
          Dados da ata
          {formOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <div className="flex gap-2">
          <Button size="sm" className="bg-blue-600 text-white hover:bg-blue-700" onClick={generate} disabled={busy !== null}>
            {busy === 'generate' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {report ? 'Gerar novamente' : 'Gerar ata'}
          </Button>
          <Button size="sm" variant="outline" onClick={exportPdf} disabled={!report || busy !== null}>
            {busy === 'export' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
            Exportar PDF
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {formOpen && (
          <div className="space-y-4 border-b border-gray-200 bg-gray-50 px-4 py-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {field('Título da ata', 'titulo')}
              {field('Série (reuniões recorrentes)', 'serie', 'Ex.: Comitê de Tecnologia')}
              <div>
                <Label className="text-xs text-gray-600">Data</Label>
                <Input className="mt-1" type="date" value={meta.data} onChange={(e) => update({ data: e.target.value })} />
              </div>
              {field('Modalidade', 'modalidade')}
              {field('Área (sigla)', 'area_sigla')}
              {field('Área (nome)', 'area_nome')}
              {field('Emitido por', 'emitido_por')}
              {field('Referência (ata anterior)', 'referencia')}
              {field('Confidencialidade', 'confidencialidade')}
              {field('Detalhe da confidencialidade', 'confidencialidade_detalhe')}
            </div>
            <p className="text-xs text-gray-500">
              Documento: <span className="font-mono">{derived.documento}</span>
            </p>
            <div>
              <Label className="text-xs text-gray-600">Participantes</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {people.map((p) => {
                  const selected = meta.participantes.some((s) => s.iniciais === p.initials);
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePerson(p.name, p.initials)}
                      className={`flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm transition ${
                        selected ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-gray-300 bg-white text-gray-700'
                      }`}
                    >
                      <span
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                          selected ? 'bg-blue-600' : 'bg-gray-400'
                        }`}
                      >
                        {p.initials}
                      </span>
                      {p.name}
                    </button>
                  );
                })}
                {people.length === 0 && <p className="text-sm text-gray-500">Cadastre as pessoas abaixo.</p>}
              </div>
              <div className="mt-3">
                <AddPersonForm
                  onAdded={(person) => {
                    refreshPeople();
                    togglePerson(person.name, person.initials);
                  }}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={saveMeta}>
                Salvar dados
              </Button>
            </div>
          </div>
        )}

        {busy === 'generate' && (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-gray-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Gerando a ata com a IA interna. Reuniões longas podem levar alguns minutos.
          </div>
        )}

        {report ? (
          <iframe title="Pré-visualização da ata" srcDoc={previewHtml} className="h-[1400px] w-full border-0 bg-[#E9EDF5]" />
        ) : (
          busy !== 'generate' && (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-gray-500">
              <FileText className="h-8 w-8 text-gray-300" />
              Selecione os participantes e clique em &quot;Gerar ata&quot;.
            </div>
          )
        )}
      </div>
    </div>
  );
}

export function SummaryAtaTabs({ summary, ata }: { summary: ReactNode; ata: ReactNode }) {
  const [tab, setTab] = useState<'summary' | 'ata'>('ata');
  const tabClass = (active: boolean) =>
    `px-4 py-2 text-sm font-medium border-b-2 ${active ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-900'}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 gap-1 border-b border-gray-200 bg-white px-2">
        <button className={tabClass(tab === 'ata')} onClick={() => setTab('ata')}>
          Ata
        </button>
        <button className={tabClass(tab === 'summary')} onClick={() => setTab('summary')}>
          Resumo
        </button>
      </div>
      <div className={tab === 'ata' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>{ata}</div>
      <div className={tab === 'summary' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>{summary}</div>
    </div>
  );
}
