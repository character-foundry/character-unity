/**
 * wwwyzzerdd Tab - AI-assisted character creation wizard
 * Two-column layout: Left = Character form fields, Right = AI chat
 */
import { useState, useRef, useEffect } from 'react';
import { useCardStore, extractCardData } from '../../store/card-store';
import { useSettingsStore } from '../../store/settings-store';
import { useLLMStore } from '../../store/llm-store';
import { invokeClientLLM, type ClientLLMProvider } from '../../lib/client-llm';
import { type WwwyzzerddPromptSet, defaultWwwyzzerddPrompts, initializeWwwyzzerddPrompts, } from '../../lib/default-wwwyzzerdd';
import type { CardFields } from '../../lib/card-type-guards';
import { useEditorSession } from '../../unity/context';
import { applyWizardProposal, parseWizardProposal, reviewWizardProposal, type WizardFields } from './proposal';
import { DynamicField } from '../editor/components/DynamicField';
import { getFieldById } from '../editor/config/field-definitions';
import { readFieldValue } from '../editor/components/field-value';
interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    parsedData?: WizardFields;
    selection?: number;
    sessionId?: string;
    proposalWarning?: string;
}
// Default prompt set fallback
const DEFAULT_PROMPT_SET = defaultWwwyzzerddPrompts[0];
export function WwwyzzerddTab() {
    const session = useEditorSession();
    const generation = session.selection();
    const sessionRef = useRef(session);
    sessionRef.current = session;
    const { currentCard, updateCardFields } = useCardStore();
    const llmSettings = useLLMStore((state) => state.settings);
    const loadSettings = useLLMStore((state) => state.loadSettings);
    const activePromptSetId = useSettingsStore((state) => state.wwwyzzerdd?.activePromptSetId);
    // Initialize messages from persisted state
    const [messages, setMessagesState] = useState<ChatMessage[]>(() => session.wizard.messages as ChatMessage[]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [promptSet, setPromptSet] = useState<WwwyzzerddPromptSet | null>(null);
    const [mode, setMode] = useState<'character' | 'lore'>('character');
    const [proposalError, setProposalError] = useState('');
    const chatEndRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    // Wrapper to persist messages
    const setMessages = (newMessages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
        const previous = session.wizard.messages as ChatMessage[];
        const result = typeof newMessages === 'function' ? newMessages(previous) : newMessages;
        session.wizard.messages = result;
        setMessagesState(result);
    };
    useEffect(() => {
        setMessagesState(session.wizard.messages as ChatMessage[]);
        setInput('');
        setIsLoading(false);
        setProposalError('');
        return () => {
            const controller = abortControllerRef.current;
            abortControllerRef.current = null;
            controller?.abort();
        };
    }, [session, generation]);
    // Get card data
    const cardData = currentCard ? extractCardData(currentCard) : null;
    // Helper to update card fields - uses type-safe updateCardFields
    const handleFieldChange = (field: string, value: unknown) => {
        if (!currentCard || !cardData)
            return;
        updateCardFields({ [field]: value } as Partial<CardFields>);
    };
    // Load LLM settings on mount
    useEffect(() => {
        loadSettings();
    }, [loadSettings]);
    // Load active prompt set
    useEffect(() => {
        {
            // In light mode, load from localStorage or initialize with all defaults
            try {
                const prompts = initializeWwwyzzerddPrompts();
                const active = prompts.find((p: WwwyzzerddPromptSet) => p.id === activePromptSetId) || prompts[0] || DEFAULT_PROMPT_SET;
                setPromptSet(active);
            }
            catch {
                setPromptSet(DEFAULT_PROMPT_SET);
            }
        }
    }, [activePromptSetId]);
    // Auto-scroll chat
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);
    // Preserve the greeting across tab remounts, only within this editor selection.
    useEffect(() => {
        if (promptSet && !session.wizard.hasShownGreeting && session.wizard.messages.length === 0) {
            session.wizard.hasShownGreeting = true;
            const greeting = `Hello! I'm wwwyzzerdd, your character creation assistant. ${promptSet.personality}

Before we begin, I need to know a few things:

1. **Card Type**: Are you creating a standard **Character Card (CC)** or a **Voxta** card?
   - CC: Personality field is deprecated, traits go in Description using JED format
   - Voxta: Personality field is used, plus Appearance field for image generation

2. **Image Generation**: What type of image generator will you use for the Appearance field?
   - **Tag-based** (Stable Diffusion, NovelAI): Use booru-style tags like "1girl, long hair, blue eyes, school uniform"
   - **Natural language** (DALL-E, Midjourney): Use descriptive sentences

Tell me your preferences and describe the character you'd like to create!`;
            const newMessages = [{
                    role: 'assistant' as const,
                    content: greeting,
                    timestamp: new Date(),
                }];
            session.wizard.messages = newMessages;
            setMessagesState(newMessages);
        }
    }, [promptSet, session, generation]);
    const handleSendMessage = async () => {
        if (!session.capabilities.browserLLM) return;
        if (!input.trim() || isLoading)
            return;
        if (!promptSet) {
            alert('Please select a prompt set in Settings > wwwyzzerdd first.');
            return;
        }
        // Find active provider - try activeProviderId first, fallback to first provider
        let activeProvider = llmSettings.providers.find((p) => p.id === llmSettings.activeProviderId);
        if (!activeProvider && llmSettings.providers.length > 0) {
            activeProvider = llmSettings.providers[0];
        }
        if (!activeProvider) {
            alert('Please configure an LLM provider in Settings > AI > Providers first.');
            return;
        }
        const userMessage: ChatMessage = {
            role: 'user',
            content: input.trim(),
            timestamp: new Date(),
        };
        setMessages((prev) => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const signal = AbortSignal.any([controller.signal, session.liveSignal()]);
        const requestGeneration = session.selection();
        const isCurrentRequest = () => abortControllerRef.current === controller && !signal.aborted &&
            sessionRef.current === session && session.selection() === requestGeneration;
        const onAbort = () => {
            if (abortControllerRef.current === controller) {
                abortControllerRef.current = null;
                setIsLoading(false);
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            // Build context from current card
            const cardContext = cardData ? 'Current character data:\n' + ['name', 'description', 'personality', 'scenario', 'first_mes', 'appearance'].map(id => {
                const definition = getFieldById(id)!;
                const state = readFieldValue(definition, cardData as unknown as Record<string, unknown>);
                return `- ${definition.label}: ${!state.editable ? '(unsupported value preserved; do not propose changes)' : typeof state.value === 'string' && state.value ? state.value : '(not set)'}`;
            }).join('\n') : 'No character card loaded yet.';
            const jsonInstruction = `

IMPORTANT FORMATTING RULES:
- Default to JED (JSON-Enhanced Description) format for the description field unless user specifies otherwise
- JED format uses structured sections like [Character], [Personality], [Background], [Traits], etc.
- The "personality" field is DEPRECATED for standard Character Cards - put personality traits in the description using JED format
- Only use the "personality" field if the user explicitly says they're making a Voxta card
- The "appearance" field is for image generation prompts - ask user if they prefer booru tags or natural language

When you have enough information to fill in character fields, output them in a JSON code block like this:
\`\`\`json
{
  "name": "Character Name",
  "nickname": "Optional nickname",
  "description": "[Character]\\nName, age, role...\\n\\n[Personality]\\nTraits and behavior...\\n\\n[Background]\\nHistory...",
  "scenario": "The scenario/setting...",
  "first_mes": "The opening message...",
  "appearance": "For image gen - either booru tags or natural language based on user preference",
  "personality": "ONLY for Voxta cards, otherwise leave empty",
  "tags": ["tag1", "tag2"]
}
\`\`\`
Only include fields you want to update. The user can then apply these to the character card.`;
            const systemPrompt = mode === 'character' ? promptSet.characterPrompt : promptSet.lorePrompt;
            const fullSystemPrompt = `${systemPrompt}${jsonInstruction}\n\n${cardContext}`;
            // Build messages array (excluding system - that goes separately)
            const chatMessages = [
                ...messages.map((m) => ({ role: m.role, content: m.content })),
                { role: 'user' as const, content: input.trim() },
            ];
            let content: string;
            {
                // Use client-side LLM invocation
                const clientProvider: ClientLLMProvider = {
                    id: activeProvider.id,
                    name: activeProvider.label || activeProvider.name,
                    kind: ((activeProvider as typeof activeProvider & {
                        clientKind?: string;
                    }).clientKind || (activeProvider.kind === 'anthropic' ? 'anthropic' : 'openai-compatible')) as 'anthropic' | 'openai-compatible' | 'openrouter',
                    baseURL: activeProvider.baseURL || '',
                    apiKey: activeProvider.apiKey || '',
                    defaultModel: activeProvider.defaultModel || '',
                    temperature: activeProvider.temperature,
                    maxTokens: activeProvider.maxTokens,
                };
                const result = await invokeClientLLM({
                    provider: clientProvider,
                    messages: [
                        { role: 'system', content: fullSystemPrompt },
                        ...chatMessages,
                    ],
                    temperature: 0.7,
                    maxTokens: 2048,
                    model: activeProvider.defaultModel,
                    signal,
                });
                if (!isCurrentRequest()) return;
                if (!result.success) {
                    throw new Error(result.error || 'LLM request failed');
                }
                content = result.content || 'No response received.';
            }
            const parsedData = parseWizardProposal(content);
            const review = parsedData && cardData ? reviewWizardProposal(parsedData, cardData as unknown as Record<string, unknown>) : null;
            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content,
                timestamp: new Date(),
                parsedData: review && Object.keys(review.fields).length ? review.fields : undefined,
                proposalWarning: review?.blocked.length ? `${review.blocked.join(', ')} cannot be edited by this form and were excluded from the proposal.` : undefined,
                selection: requestGeneration,
                sessionId: session.id,
            };
            setMessages((prev) => [...prev, assistantMessage]);
        }
        catch (err) {
            if (isCurrentRequest()) {
                console.error('Chat error:', err);
                setMessages((prev) => [
                    ...prev,
                    {
                        role: 'assistant',
                        content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}`,
                        timestamp: new Date(),
                    },
                ]);
            }
        }
        finally {
            signal.removeEventListener('abort', onAbort);
            if (abortControllerRef.current === controller) {
                abortControllerRef.current = null;
                setIsLoading(false);
            }
        }
    };
    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setMessages((prev) => [...prev, {
                role: 'assistant',
                content: '[Request stopped by user]',
                timestamp: new Date(),
            }]);
        }
    };
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    };
    const clearChat = () => {
        const controller = abortControllerRef.current;
        abortControllerRef.current = null;
        controller?.abort();
        setIsLoading(false);
        session.wizard.messages = [];
        session.wizard.hasShownGreeting = false;
        // Immediately show greeting
        if (promptSet) {
            session.wizard.hasShownGreeting = true;
            const greeting = `Hello! I'm wwwyzzerdd, your character creation assistant. ${promptSet.personality}

Before we begin, I need to know a few things:

1. **Card Type**: Are you creating a standard **Character Card (CC)** or a **Voxta** card?
   - CC: Personality field is deprecated, traits go in Description using JED format
   - Voxta: Personality field is used, plus Appearance field for image generation

2. **Image Generation**: What type of image generator will you use for the Appearance field?
   - **Tag-based** (Stable Diffusion, NovelAI): Use booru-style tags like "1girl, long hair, blue eyes, school uniform"
   - **Natural language** (DALL-E, Midjourney): Use descriptive sentences

Tell me your preferences and describe the character you'd like to create!`;
            const newMessages = [{
                    role: 'assistant' as const,
                    content: greeting,
                    timestamp: new Date(),
                }];
            session.wizard.messages = newMessages;
            setMessagesState(newMessages);
        }
        else {
            setMessagesState([]);
        }
    };
    const applyParsedData = (message: ChatMessage) => {
        const data = message.parsedData;
        if (!currentCard || !cardData || !data || message.sessionId !== session.id || message.selection !== session.selection())
            return;
        try {
            const changes = applyWizardProposal(data, cardData as unknown as Record<string, unknown>);
            updateCardFields(changes as Partial<CardFields>);
            setProposalError('');
        } catch (error) {
            setProposalError(error instanceof Error ? error.message : 'The proposal could not be applied.');
        }
    };
    if (!currentCard) {
        return (<div className="flex items-center justify-center h-full text-dark-muted">
        <div className="text-center">
          <div className="text-6xl mb-4">&#129497;</div>
          <h2 className="text-xl font-semibold mb-2">No Card Loaded</h2>
          <p>Create or load a character card to use wwwyzzerdd.</p>
        </div>
      </div>);
    }
    if (!session.capabilities.browserLLM) return <p className="p-6 text-sm text-dark-muted">The AI wizard is available only in a local installation.</p>;
    return (<div className="flex h-full min-h-0 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
      {/* Left Column - Character Form */}
      <div className="order-2 w-full min-w-0 shrink-0 border-t border-dark-border p-4 sm:p-6 lg:order-1 lg:w-1/2 lg:shrink lg:border-t-0 lg:border-r lg:overflow-auto">
        <div className="space-y-4">
          {proposalError && <p role="alert" className="text-sm text-red-300">{proposalError}</p>}
          {['name', 'nickname', 'description', 'scenario', 'first_mes', 'appearance', 'personality'].map(id => <DynamicField key={id}
            definition={getFieldById(id)!} cardData={cardData as unknown as Record<string, unknown>}
            onFieldChange={handleFieldChange} spec={currentCard.meta.spec === 'v2' ? 'v2' : 'v3'} showV3Fields={true} tokenCounts={{}} />)}
        </div>
      </div>

      {/* Right Column - AI Chat */}
      <div className="order-1 flex h-[36rem] w-full min-w-0 shrink-0 flex-col lg:order-2 lg:h-auto lg:w-1/2 lg:shrink">
        {/* Chat Header */}
        <div className="p-4 border-b border-dark-border flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-purple-400">wwwyzzerdd</h3>
            <div className="flex gap-2">
              <button onClick={() => setMode('character')} className={`px-3 py-1 rounded text-sm ${mode === 'character'
            ? 'bg-purple-600 text-white'
            : 'bg-dark-surface text-dark-muted hover:text-dark-text'}`}>
                Character
              </button>
              <button onClick={() => setMode('lore')} className={`px-3 py-1 rounded text-sm ${mode === 'lore'
            ? 'bg-purple-600 text-white'
            : 'bg-dark-surface text-dark-muted hover:text-dark-text'}`}>
                Lore
              </button>
            </div>
          </div>
          <button onClick={clearChat} className="px-3 py-1 text-sm text-dark-muted hover:text-dark-text">
            Clear Chat
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
          {!promptSet && (<div className="bg-yellow-900/20 border border-yellow-700 rounded p-4 text-yellow-200 text-sm">
              No prompt set selected. Go to Settings &gt; wwwyzzerdd to select or create a prompt set.
            </div>)}
          {messages.map((msg, i) => (<div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] min-w-0 rounded-lg px-4 py-2 ${msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-dark-surface border border-dark-border'}`}>
                <div className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{msg.content}</div>
                {msg.proposalWarning && <p role="status" className="mt-2 text-xs text-amber-200">{msg.proposalWarning}</p>}
                {msg.parsedData && (<div className="mt-3 pt-3 border-t border-dark-border">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-green-400">
                        JSON detected: {Object.keys(msg.parsedData).join(', ')}
                      </span>
                      <button onClick={() => applyParsedData(msg)} disabled={msg.sessionId !== session.id || msg.selection !== generation} className="px-3 py-1 text-xs bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors">
                        Apply to Card
                      </button>
                    </div>
                  </div>)}
                <div className="text-xs opacity-50 mt-1">
                  {msg.timestamp.toLocaleTimeString()}
                </div>
              </div>
            </div>))}
          {isLoading && (<div className="flex justify-start">
              <div className="bg-dark-surface border border-dark-border rounded-lg px-4 py-2">
                <div className="flex items-center gap-2">
                  <div className="animate-spin w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full"/>
                  <span className="text-dark-muted">wwwyzzerdd is thinking...</span>
                </div>
              </div>
            </div>)}
          <div ref={chatEndRef}/>
        </div>

        {/* Input */}
        <div className="p-4 border-t border-dark-border">
          <div className="flex gap-2">
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder="Describe your character or ask for suggestions..." rows={2} className="min-w-0 flex-1 bg-dark-surface border border-dark-border rounded px-3 py-2 resize-none" disabled={isLoading || !promptSet}/>
            {isLoading ? (<button onClick={handleStop} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors">
                Stop
              </button>) : (<button onClick={handleSendMessage} disabled={!input.trim() || !promptSet} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded transition-colors">
                Send
              </button>)}
          </div>
          <p className="text-xs text-dark-muted mt-2">
            Press Enter to send, Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>);
}
