import { useState, useEffect, useRef, useMemo } from 'react';
import { useLLMStore, clientProvider } from '../../../store/llm-store';
import { invokeClientLLM } from '../../../lib/client-llm';
import { loadPresets, savePreset } from '../../../lib/presets';
import type { LLMAssistResponse, UserPreset } from '../../../lib/types';
import { DiffViewer } from '../../../components/ui/DiffViewer';
import { useEditorSession } from '../../../unity/context';

interface LLMAssistSidebarProps {
  isOpen: boolean; onClose(): void; fieldName: string; currentValue: string; selection?: string;
  onApply(value: string, action: 'replace' | 'append' | 'insert'): void;
  cardSpec: 'v2' | 'v3' | 'collection' | 'lorebook';
}

export function LLMAssistSidebar({ isOpen, onClose, fieldName, currentValue, selection, onApply }: LLMAssistSidebarProps) {
  const session = useEditorSession();
  const generation = session.selection();
  const { settings, loadSettings } = useLLMStore();
  const [instruction, setInstruction] = useState('');
  const [presets, setPresets] = useState<UserPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [showCustomInstruction, setShowCustomInstruction] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [isProcessing, setIsProcessing] = useState(false);
  const [assistResponse, setAssistResponse] = useState<LLMAssistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fieldContext = useMemo(() => ({ session, isOpen, fieldName, currentValue, selection }),
    [session, isOpen, fieldName, currentValue, selection]);
  const fieldContextRef = useRef(fieldContext);
  fieldContextRef.current = fieldContext;
  const responseContextRef = useRef<{
    generation: number; signal: AbortSignal; field: typeof fieldContext;
  } | null>(null);
  const refreshPresets = () => {
    try { setPresets(loadPresets().filter((preset) => !preset.isHidden)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to load presets'); }
  };
  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => { if (isOpen) refreshPresets(); }, [isOpen]);
  useEffect(() => {
    const active = settings.providers.find((provider) => provider.id === settings.activeProviderId) || settings.providers[0];
    if (active) { setSelectedProvider(active.id); setModel(active.defaultModel); setTemperature(active.temperature ?? 0.7); }
  }, [settings]);
  useEffect(() => {
    responseContextRef.current = null;
    setAssistResponse(null);
    setError(null);
    setIsProcessing(false);
    return () => {
      const controller = abortControllerRef.current;
      abortControllerRef.current = null;
      responseContextRef.current = null;
      controller?.abort();
    };
  }, [session, generation, isOpen, fieldName, currentValue, selection]);
  const handleStop = () => {
    abortControllerRef.current?.abort(); abortControllerRef.current = null;
    setIsProcessing(false); setError('Request stopped by user');
  };
  const handleRun = async () => {
    if (!session.capabilities.browserLLM) return;
    const provider = settings.providers.find((item) => item.id === selectedProvider);
    const finalInstruction = instruction.trim() || presets.find((preset) => preset.id === selectedPresetId)?.instruction;
    if (!provider || !finalInstruction) { setError('Select a provider and an instruction first.'); return; }
    abortControllerRef.current?.abort();
    const controller = new AbortController(); abortControllerRef.current = controller;
    const signal = AbortSignal.any([controller.signal, session.liveSignal()]);
    const requestGeneration = session.selection();
    const requestContext = fieldContextRef.current;
    const isCurrentRequest = () => abortControllerRef.current === controller && !signal.aborted &&
      requestGeneration === session.selection() && fieldContextRef.current === requestContext;
    const onAbort = () => {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsProcessing(false);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    responseContextRef.current = null;
    setIsProcessing(true); setError(null); setAssistResponse(null);
    const original = selection || currentValue;
    try {
      const result = await invokeClientLLM({
        provider: clientProvider(provider), model, temperature, maxTokens: provider.maxTokens ?? 2048, signal,
        messages: [
          { role: 'system', content: 'You are helping edit a character card. Field: ' + fieldName +
            '. Task: ' + finalInstruction + '. Respond only with revised text, without explanations or markdown formatting.' },
          { role: 'user', content: original },
        ],
      });
      if (!isCurrentRequest()) return;
      if (!result.success) throw new Error(result.error || 'LLM request failed');
      const revised = result.content ?? '';
      setAssistResponse({
        content: revised, model, original, revised, diff: [], usage: { promptTokens: 0, completionTokens: 0 },
        metadata: { provider: provider.label || provider.name, model, temperature, promptTokens: 0, completionTokens: 0 },
      });
      responseContextRef.current = { generation: requestGeneration, signal, field: requestContext };
    } catch (error) {
      if (isCurrentRequest()) setError(error instanceof Error ? error.message : 'LLM request failed');
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (abortControllerRef.current === controller) { abortControllerRef.current = null; setIsProcessing(false); }
    }
  };
  const handleApply = (action: 'replace' | 'append' | 'insert') => {
    const context = responseContextRef.current;
    if (assistResponse && isOpen && context && !context.signal.aborted &&
      context.generation === session.selection() && context.field === fieldContextRef.current) {
      onApply(assistResponse.revised || assistResponse.content, action); onClose();
    }
  };
  const handleUserPresetSelect = (id: string) => { setSelectedPresetId(id); setInstruction(''); };
  const handleSaveAsPreset = () => {
    const name = prompt('Enter a name for this preset:');
    if (!name?.trim() || !instruction.trim()) return;
    try {
      const preset = savePreset({ name: name.trim(), instruction: instruction.trim(), category: 'custom' });
      refreshPresets(); setSelectedPresetId(preset.id); setInstruction(''); setShowCustomInstruction(false);
    } catch (error) { setError(error instanceof Error ? error.message : 'Failed to save preset'); }
  };
    if (!isOpen || !session.capabilities.browserLLM)
        return null;
    return (<div role="complementary" aria-label="AI assistant" className="ai-assistant absolute top-0 right-0 bottom-0 z-40 flex flex-col">
      {/* Header */}
      <div className="p-5 border-b border-dark-border flex justify-between items-center gap-3 shrink-0">
        <div className="min-w-0"><h3 className="text-base font-semibold tracking-tight">AI Assistant</h3>
          <p className="text-xs text-dark-muted mt-1 truncate">Editing {fieldName.replace(/_/g, ' ')}</p></div>
        <button onClick={onClose} aria-label="Close AI assistant" className="icon-button">
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto assistant-scroll">
      {/* Config */}
      <div className="p-4 border-b border-dark-border space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">Provider</label>
          <select value={selectedProvider} onChange={(e) => {
            const newProvider = settings.providers.find((p) => p.id === e.target.value);
            if (newProvider) {
                setSelectedProvider(e.target.value);
                setModel(newProvider.defaultModel);
                setTemperature(newProvider.temperature ?? 0.7);
            }
        }} className="w-full bg-dark-bg border border-dark-border rounded px-3 py-2 text-sm">
            {settings.providers.map((p) => (<option key={p.id} value={p.id}>
                {p.name || p.label}
              </option>))}
          </select>
        </div>

      </div>

      {/* Presets stay compact so instructions and results remain reachable. */}
      <div className="border-b border-dark-border flex flex-col">
        <div className="p-4 pb-2">
          <label className="block text-sm font-medium mb-2">Presets</label>
        </div>
        <div className="max-h-60 overflow-y-auto px-4 pb-4">
          {presets.length === 0 ? (<div className="text-xs text-dark-muted text-center py-4">
              No presets available. Add presets in Settings.
            </div>) : (<div className="space-y-3">
              {(['rewrite', 'format', 'generate', 'custom'] as const).map((category) => {
                const categoryPresets = presets.filter((p) => p.category === category);
                if (categoryPresets.length === 0)
                    return null;
                return (<div key={category}>
                    <div className="text-xs font-semibold text-dark-muted uppercase tracking-wide mb-1.5">
                      {category}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {categoryPresets.map((preset) => (<button key={preset.id} onClick={() => handleUserPresetSelect(preset.id)} aria-pressed={selectedPresetId === preset.id} className={`assistant-preset ${selectedPresetId === preset.id
                            ? 'is-selected'
                            : ''}`} title={preset.description || preset.instruction.slice(0, 100)}>
                          {preset.name}
                        </button>))}
                    </div>
                  </div>);
            })}
            </div>)}
        </div>
      </div>

      {/* Custom Instruction - Collapsible */}
      <div className="border-b border-dark-border">
        <button aria-expanded={showCustomInstruction} onClick={() => setShowCustomInstruction(!showCustomInstruction)} className="w-full p-4 flex items-center justify-between text-left hover:bg-slate-700/30 transition-colors">
          <span className="text-sm font-medium">
            Custom Instruction {selectedPresetId && '(overrides preset)'}
          </span>
          <svg className={`w-4 h-4 transition-transform ${showCustomInstruction ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
          </svg>
        </button>

        {showCustomInstruction && (<div className="p-4 pt-0 flex flex-col gap-2">
            <textarea value={instruction} onChange={(e) => {
                setInstruction(e.target.value);
                if (e.target.value) {
                    setSelectedPresetId(null);
                }
            }} placeholder="Describe what you want to do..." className="w-full bg-dark-bg border border-dark-border rounded px-3 py-2 text-sm resize-none h-32"/>
            {instruction.trim() && (<button onClick={handleSaveAsPreset} className="self-end px-3 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition-colors">
                Save as Preset
              </button>)}
          </div>)}
      </div>

      {/* Run/Stop Button - Always visible */}
      <div className="p-4 border-b border-dark-border sticky top-0 bg-dark-surface z-10">
        {isProcessing ? (<button onClick={handleStop} className="w-full px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors">
            Stop
          </button>) : (<button onClick={handleRun} disabled={!instruction && !selectedPresetId} className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            Generate revision
          </button>)}
      </div>

      {/* Results - Takes remaining space */}
      <div className="p-4 min-h-32">
        {error && (<div className="p-3 bg-red-900/30 border border-red-500 rounded text-red-200 text-sm">
            {error}
          </div>)}

        {assistResponse && (<div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">Result</h4>
              {assistResponse.tokenDelta && (<div className="text-xs text-dark-muted">
                  {assistResponse.tokenDelta.delta > 0 ? '+' : ''}
                  {assistResponse.tokenDelta.delta} tokens ({assistResponse.tokenDelta.before} →{' '}
                  {assistResponse.tokenDelta.after})
                </div>)}
            </div>

            {assistResponse.diff && (<DiffViewer diff={assistResponse.diff} originalText={assistResponse.original} revisedText={assistResponse.revised}/>)}

            <div className="flex gap-2">
              <button onClick={() => handleApply('replace')} className="flex-1 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition-colors">
                Replace
              </button>
              {(fieldName === 'alternate_greetings' || fieldName === 'mes_example') && (<button onClick={() => handleApply('append')} className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">
                  Append
                </button>)}
            </div>

            {assistResponse.metadata && (<div className="text-xs text-dark-muted space-y-1">
                <div>Provider: {assistResponse.metadata.provider}</div>
                <div>Model: {assistResponse.metadata.model}</div>
                <div>
                  Tokens: {assistResponse.metadata.promptTokens} prompt +{' '}
                  {assistResponse.metadata.completionTokens} completion
                </div>
              </div>)}
         </div>)}

        {!isProcessing && !assistResponse && !error && (<div className="text-center text-dark-muted text-sm">
            Choose a preset or write an instruction. Review the result before applying it.
          </div>)}
      </div>
      </div>
    </div>);
}
