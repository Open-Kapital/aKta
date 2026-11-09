'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { CheckCircle2, CloudUpload, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

interface SupabaseConfigView {
  url: string;
  anonKey: string;
  email: string;
  hasPassword: boolean;
  enabled: boolean;
}

interface SyncStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastSyncedMeetings: number;
  lastDeletedMeetings: number;
  pendingMeetings: number;
}

interface SyncReport {
  syncedMeetings: number;
  deletedMeetings: number;
  unchangedMeetings: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function SupabaseSyncSettings() {
  const [url, setUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'sync' | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await invoke<SyncStatus>('akta_supabase_get_status'));
    } catch (err) {
      console.error('Failed to load sync status:', err);
    }
  }, []);

  useEffect(() => {
    invoke<SupabaseConfigView | null>('akta_supabase_get_config')
      .then((config) => {
        if (!config) return;
        setUrl(config.url);
        setAnonKey(config.anonKey);
        setEmail(config.email);
        setHasPassword(config.hasPassword);
        setEnabled(config.enabled);
      })
      .catch((err) => console.error('Failed to load Supabase config:', err));
    refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const formArgs = () => ({
    url: url.trim(),
    anonKey: anonKey.trim(),
    email: email.trim(),
    password: password || null,
  });

  const canSubmit = url.trim() && anonKey.trim() && email.trim() && (password || hasPassword);

  const handleTest = async () => {
    setBusy('test');
    try {
      await invoke('akta_supabase_test_connection', formArgs());
      toast.success('Connected to Supabase');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    setBusy('save');
    try {
      await invoke('akta_supabase_save_config', { ...formArgs(), enabled });
      if (password) setHasPassword(true);
      setPassword('');
      toast.success('Supabase settings saved');
      refreshStatus();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSyncNow = async () => {
    setBusy('sync');
    try {
      const report = await invoke<SyncReport>('akta_supabase_sync_now');
      toast.success(
        `Sync complete: ${report.syncedMeetings} updated, ${report.deletedMeetings} deleted, ${report.unchangedMeetings} unchanged`
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      refreshStatus();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Supabase Sync</h3>
            <p className="text-sm text-gray-600">
              Meeting titles, transcripts, summaries and notes are copied to Supabase. Audio stays on this computer.
              Meetings are kept locally and synced automatically whenever Supabase is reachable.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable Supabase sync" />
        </div>

        <div className="space-y-4">
          <div>
            <Label htmlFor="supabase-url">Project URL</Label>
            <Input
              id="supabase-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-project.supabase.co"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="supabase-anon-key">Anon (public) key</Label>
            <Input
              id="supabase-anon-key"
              type="password"
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              placeholder="eyJhbGciOi..."
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="supabase-email">Login email</Label>
              <Input
                id="supabase-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="akta@company.com"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="supabase-password">Password</Label>
              <Input
                id="supabase-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasPassword ? 'Saved (leave empty to keep)' : ''}
                className="mt-1"
              />
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={handleTest} disabled={!canSubmit || busy !== null}>
              {busy === 'test' && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />}
              Test Connection
            </Button>
            <Button
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={handleSave}
              disabled={!canSubmit || busy !== null}
            >
              {busy === 'save' && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="space-y-1 text-sm">
            <h3 className="text-lg font-semibold text-gray-900">Status</h3>
            {!status?.configured ? (
              <p className="text-gray-600">Not configured yet.</p>
            ) : (
              <>
                <p className="flex items-center gap-2 text-gray-700">
                  {status.lastError ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  )}
                  {status.running
                    ? 'Syncing...'
                    : status.lastSyncAt
                      ? `Last sync: ${new Date(status.lastSyncAt).toLocaleString()}`
                      : 'Waiting for first sync'}
                </p>
                <p className="text-gray-600">Pending changes: {status.pendingMeetings}</p>
                {status.lastError && <p className="break-all text-red-600">{status.lastError}</p>}
              </>
            )}
          </div>
          <Button variant="outline" onClick={handleSyncNow} disabled={!status?.configured || busy !== null}>
            {busy === 'sync' ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CloudUpload className="mr-2 h-4 w-4" />
            )}
            Sync Now
          </Button>
        </div>
      </div>
    </div>
  );
}
