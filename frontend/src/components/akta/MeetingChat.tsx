'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, SendHorizonal, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface MeetingChatProps {
  meetingId?: string;
}

export function MeetingChat({ meetingId }: MeetingChatProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, busy]);

  const ask = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput('');
    const nextTurns = [...turns, { role: 'user' as const, content: question }];
    setTurns(nextTurns);
    if (!meetingId) {
      setTurns([...nextTurns, { role: 'assistant', content: 'Esta reunião ainda não foi salva.' }]);
      return;
    }
    setBusy(true);
    try {
      const answer = await invoke<string>('akta_meeting_chat', {
        meetingId,
        question,
        history: turns.slice(-8),
      });
      setTurns([...nextTurns, { role: 'assistant', content: answer }]);
    } catch (err) {
      setTurns([...nextTurns, { role: 'assistant', content: `Erro: ${String(err)}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col border-t border-gray-200 bg-white">
      {turns.length > 0 && (
        <div ref={listRef} className="max-h-64 space-y-2 overflow-y-auto px-3 pt-3">
          {turns.map((t, i) => (
            <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  t.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'
                }`}
              >
                {t.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Pensando…
              </div>
            </div>
          )}
        </div>
      )}
      <div className="flex items-end gap-2 p-2">
        <div className="relative flex-1">
          <MessageSquare className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <textarea
            placeholder="Pergunte sobre a reunião: quem disse o quê, decisões, pendências…"
            className="w-full resize-none rounded-md border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
          />
        </div>
        <Button size="sm" onClick={ask} disabled={busy || !input.trim()} aria-label="Enviar pergunta">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizonal className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
