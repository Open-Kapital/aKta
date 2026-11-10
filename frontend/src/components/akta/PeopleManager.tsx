'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface Person {
  id: number | null;
  name: string;
  initials: string;
  context: string;
}

export function suggestInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 2 || /^[A-ZÁ-Ú]/.test(p));
  if (parts.length === 0) return '';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : parts[0][1] ?? '';
  return `${first}${last}`.toUpperCase();
}

export function usePeople() {
  const [people, setPeople] = useState<Person[]>([]);
  const refresh = useCallback(async () => {
    try {
      setPeople(await invoke<Person[]>('akta_people_list'));
    } catch (err) {
      console.error('Failed to load people:', err);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { people, refresh };
}

export function AddPersonForm({ onAdded }: { onAdded: (person: Person) => void }) {
  const [name, setName] = useState('');
  const [initials, setInitials] = useState('');
  const [initialsTouched, setInitialsTouched] = useState(false);
  const canSubmit = name.trim() !== '' && initials.trim() !== '';

  const submit = async () => {
    if (!canSubmit) return;
    try {
      const person = await invoke<Person>('akta_people_save', {
        person: { id: null, name, initials, context: '' },
      });
      setName('');
      setInitials('');
      setInitialsTouched(false);
      onAdded(person);
    } catch (err) {
      toast.error(String(err));
    }
  };

  return (
    <div className="flex gap-2">
      <Input
        value={name}
        placeholder="Nome completo"
        onChange={(e) => {
          setName(e.target.value);
          if (!initialsTouched) setInitials(suggestInitials(e.target.value));
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <Input
        value={initials}
        placeholder="Iniciais"
        className="w-24 uppercase"
        maxLength={4}
        onChange={(e) => {
          setInitials(e.target.value.toUpperCase());
          setInitialsTouched(true);
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <Button variant="outline" onClick={submit} disabled={!canSubmit} aria-label="Adicionar pessoa">
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}

function PersonRow({ person, onChanged, onDelete }: { person: Person; onChanged: () => void; onDelete: (p: Person) => void }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState(person.context);
  const [saving, setSaving] = useState(false);
  const dirty = context !== person.context;

  const save = async () => {
    setSaving(true);
    try {
      await invoke('akta_people_save', { person: { ...person, context } });
      toast.success(`Ficha de ${person.name} salva`);
      onChanged();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="py-2">
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-3 text-left" onClick={() => setOpen((v) => !v)}>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
            {person.initials}
          </span>
          <span className="text-sm text-gray-900">{person.name}</span>
          {person.context.trim() !== '' && !open && (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">com notas</span>
          )}
        </button>
        <Button variant="ghost" size="sm" onClick={() => onDelete(person)} aria-label={`Remover ${person.name}`}>
          <Trash2 className="h-4 w-4 text-gray-500" />
        </Button>
      </div>
      {open && (
        <div className="mt-2 pl-11">
          <textarea
            className="min-h-[72px] w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Notas sobre a pessoa aprendidas das reuniões (papel, responsabilidades recorrentes...). Edite se a IA registrar algo errado."
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
          <div className="mt-1 flex justify-end">
            <Button size="sm" variant="outline" onClick={save} disabled={!dirty || saving}>
              {saving ? 'Salvando…' : 'Salvar ficha'}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function PeopleManager() {
  const { people, refresh } = usePeople();

  const remove = async (person: Person) => {
    if (person.id == null) return;
    try {
      await invoke('akta_people_delete', { id: person.id });
      refresh();
    } catch (err) {
      toast.error(String(err));
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-gray-900">Pessoas</h3>
      <p className="mb-4 text-sm text-gray-600">
        Participantes das reuniões. As iniciais são usadas nas atas para indicar quem é responsável por cada ação.
        A cada ata gerada a IA atualiza as notas de cada pessoa — clique em alguém para revisar ou corrigir.
      </p>
      <AddPersonForm onAdded={refresh} />
      <ul className="mt-4 divide-y divide-gray-100">
        {people.map((person) => (
          <PersonRow key={person.id} person={person} onChanged={refresh} onDelete={remove} />
        ))}
        {people.length === 0 && <li className="py-2 text-sm text-gray-500">Nenhuma pessoa cadastrada.</li>}
      </ul>
    </div>
  );
}
