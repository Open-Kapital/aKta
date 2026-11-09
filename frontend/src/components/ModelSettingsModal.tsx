import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChevronDown, ChevronUp, RefreshCw, Server } from 'lucide-react';
import { toast } from 'sonner';

export interface ModelConfig {
  provider: 'ollama' | 'groq' | 'claude' | 'openai' | 'openrouter' | 'builtin-ai' | 'custom-openai';
  model: string;
  whisperModel: string;
  apiKey?: string | null;
  ollamaEndpoint?: string | null;
  // Custom OpenAI fields
  customOpenAIEndpoint?: string | null;
  customOpenAIModel?: string | null;
  customOpenAIApiKey?: string | null;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
}

interface InternalAIConfig {
  endpoint: string;
  apiKey?: string | null;
  model: string;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
}

// Placeholder model id stored when the server's own model should be auto-detected.
const AUTO_MODEL = 'akta-internal';

interface ModelSettingsModalProps {
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;
  onSave: (config: ModelConfig) => void;
  skipInitialFetch?: boolean;
  layout?: 'inline' | 'dialog';
}

/**
 * aKta: summaries always use the internal llama.cpp server. Only optional
 * tuning (API key, model id, sampling) can be changed here.
 */
export function ModelSettingsModal({ modelConfig, setModelConfig, onSave }: ModelSettingsModalProps) {
  const [endpoint, setEndpoint] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [maxTokens, setMaxTokens] = useState<string>('');
  const [temperature, setTemperature] = useState<string>('');
  const [topP, setTopP] = useState<string>('');
  const [isAdvancedOpen, setIsAdvancedOpen] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    invoke<InternalAIConfig | null>('api_get_custom_openai_config')
      .then((config) => {
        if (!config) return;
        setEndpoint(config.endpoint);
        setModel(config.model && config.model !== AUTO_MODEL ? config.model : '');
        setApiKey(config.apiKey || '');
        setMaxTokens(config.maxTokens?.toString() || '');
        setTemperature(config.temperature?.toString() || '');
        setTopP(config.topP?.toString() || '');
      })
      .catch((err) => console.error('Failed to load internal AI config:', err));
  }, []);

  const testConnection = async () => {
    setIsTesting(true);
    try {
      const result = await invoke<{ status: string; message: string }>('api_test_custom_openai_connection', {
        endpoint,
        apiKey: apiKey.trim() || null,
        model: model.trim(),
      });
      toast.success(result.message || 'Internal AI is reachable');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const savedModel = model.trim() || AUTO_MODEL;
      await invoke('api_save_custom_openai_config', {
        endpoint,
        apiKey: apiKey.trim() || null,
        model: savedModel,
        maxTokens: maxTokens ? parseInt(maxTokens, 10) : null,
        temperature: temperature ? parseFloat(temperature) : null,
        topP: topP ? parseFloat(topP) : null,
      });
      const updatedConfig: ModelConfig = {
        ...modelConfig,
        provider: 'custom-openai',
        model: savedModel,
        apiKey: null,
        ollamaEndpoint: null,
        customOpenAIEndpoint: endpoint,
        customOpenAIModel: savedModel,
        customOpenAIApiKey: apiKey.trim() || null,
        maxTokens: maxTokens ? parseInt(maxTokens, 10) : null,
        temperature: temperature ? parseFloat(temperature) : null,
        topP: topP ? parseFloat(topP) : null,
      };
      setModelConfig(updatedConfig);
      onSave(updatedConfig);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <Server className="mt-0.5 h-5 w-5 text-gray-600" />
        <div>
          <p className="text-sm font-medium text-gray-900">Internal AI (llama.cpp)</p>
          <p className="text-xs text-gray-600 break-all">{endpoint || 'Loading...'}</p>
          <p className="mt-1 text-xs text-gray-500">
            Summaries are generated only by the company&apos;s internal AI server. It must be reachable from this network.
          </p>
        </div>
      </div>

      <div>
        <Label htmlFor="internal-ai-model">Model (optional)</Label>
        <Input
          id="internal-ai-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Auto-detect from server"
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="internal-ai-api-key">API Key (optional)</Label>
        <Input
          id="internal-ai-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Only if llama-server was started with --api-key"
          className="mt-1"
        />
      </div>

      <div>
        <div
          className="flex cursor-pointer items-center justify-between py-2"
          onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
        >
          <Label className="cursor-pointer">Advanced Options</Label>
          {isAdvancedOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        {isAdvancedOpen && (
          <div className="mt-2 space-y-3 border-l-2 border-muted pl-2">
            <div>
              <Label htmlFor="internal-ai-max-tokens">Max Tokens</Label>
              <Input
                id="internal-ai-max-tokens"
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder="Server default"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="internal-ai-temperature">Temperature (0.0-2.0)</Label>
              <Input
                id="internal-ai-temperature"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="Server default"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="internal-ai-top-p">Top P (0.0-1.0)</Label>
              <Input
                id="internal-ai-top-p"
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={topP}
                onChange={(e) => setTopP(e.target.value)}
                placeholder="Server default"
                className="mt-1"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={testConnection} disabled={isTesting || !endpoint}>
          {isTesting ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
          Test Connection
        </Button>
        <Button
          type="button"
          className="bg-blue-600 text-white hover:bg-blue-700"
          onClick={handleSave}
          disabled={isSaving || !endpoint}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
