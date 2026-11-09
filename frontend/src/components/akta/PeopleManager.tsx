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
        person: { id: null, name, initials },
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
      </p>
      <AddPersonForm onAdded={refresh} />
      <ul className="mt-4 divide-y divide-gray-100">
        {people.map((person) => (
          <li key={person.id} className="flex items-center justify-between py-2">
            <span className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
                {person.initials}
              </span>
              <span className="text-sm text-gray-900">{person.name}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => remove(person)} aria-label={`Remover ${person.name}`}>
              <Trash2 className="h-4 w-4 text-gray-500" />
            </Button>
          </li>
        ))}
        {people.length === 0 && <li className="py-2 text-sm text-gray-500">Nenhuma pessoa cadastrada.</li>}
      </ul>
    </div>
  );
}
