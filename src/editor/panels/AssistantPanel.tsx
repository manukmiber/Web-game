import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ASSISTANT_MODELS, AssistantSession, type AssistantModel } from '../assistant/agent';
import { loadAssistantSettings, saveAssistantSettings } from '../assistant/settings';
import { useEditor } from '../EditorContext';
import { useEditorStore } from '../state/editorStore';

const PLACEHOLDER = 'Build a walled courtyard with a gate, drop a player inside and put two zombies outside.';

/**
 * The assistant, as a panel over the viewport.
 *
 * Tool calls are shown rather than summarised away. An assistant that reports "I built the
 * courtyard" and an assistant that called `create_primitive` eleven times look identical from
 * the prose alone, and the difference matters the moment something is not where it should be —
 * the same argument the script Console settles for Play mode.
 */
export function AssistantPanel() {
  const { toolContext, mcpState } = useEditor();
  const visible = useEditorStore((state) => state.assistantVisible);
  const busy = useEditorStore((state) => state.assistantBusy);
  const entries = useEditorStore((state) => state.assistantEntries);
  const setVisible = useEditorStore((state) => state.setAssistantVisible);
  const clearAssistant = useEditorStore((state) => state.clearAssistant);

  const [settings, setSettings] = useState(loadAssistantSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState('');
  const sessionRef = useRef<AssistantSession | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // A new key or model is a new client, so the session is rebuilt — but the transcript in the
  // store survives, which is what the user reads.
  const session = useMemo(() => {
    if (!settings.apiKey) return null;
    return new AssistantSession({ apiKey: settings.apiKey, model: settings.model, context: toolContext });
  }, [settings.apiKey, settings.model, toolContext]);

  useEffect(() => {
    sessionRef.current?.stop();
    sessionRef.current = session;
    if (!session) return;

    const store = useEditorStore.getState();
    const unsubscribes = [
      session.events.on('text', ({ text }) => store.pushAssistantEntry({ kind: 'assistant', text })),
      session.events.on('toolCall', (record) =>
        store.pushAssistantEntry({
          kind: 'tool',
          tool: record.name,
          text: record.result.text,
          failed: record.result.isError === true,
        }),
      ),
      session.events.on('busy', ({ busy: running }) => store.setAssistantBusy(running)),
      session.events.on('done', ({ error }) => {
        if (error) store.pushAssistantEntry({ kind: 'error', text: error });
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      session.stop();
    };
  }, [session]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [entries]);

  const submit = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt || !session || busy) return;
    setDraft('');
    useEditorStore.getState().pushAssistantEntry({ kind: 'user', text: prompt });
    void session.send(prompt);
  }, [draft, session, busy]);

  if (!visible) {
    return (
      <button className="assistant-toggle" onClick={() => setVisible(true)} title="Open the assistant (F2)">
        ✦ Assistant
      </button>
    );
  }

  const mcp = mcpState();

  return (
    <div className="assistant">
      <div className="assistant-header">
        <span>✦ Assistant</span>
        <span>
          <select
            value={settings.model}
            onChange={(event) => {
              const model = event.currentTarget.value as AssistantModel;
              setSettings((current) => ({ ...current, model }));
              saveAssistantSettings({ model });
            }}
            title="Model used for scene authoring"
          >
            {ASSISTANT_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <button onClick={() => setShowSettings(!showSettings)} title="API key">
            ⚙
          </button>
          <button onClick={clearAssistant} disabled={entries.length === 0} title="Clear the transcript">
            Clear
          </button>
          <button onClick={() => setVisible(false)} title="Hide the assistant">
            ✕
          </button>
        </span>
      </div>

      {showSettings && (
        <div className="assistant-settings">
          <label>
            Anthropic API key
            <input
              type="password"
              value={settings.apiKey}
              placeholder="sk-ant-…"
              spellCheck={false}
              onChange={(event) => {
                const apiKey = event.currentTarget.value.trim();
                setSettings((current) => ({ ...current, apiKey }));
                saveAssistantSettings({ apiKey });
              }}
              onKeyDown={(event) => event.stopPropagation()}
            />
          </label>
          <p className="assistant-note">
            Stored in this browser and sent straight to the Anthropic API — there is no backend
            in between. Use a key you are willing to spend from a browser.
          </p>
        </div>
      )}

      <div className="assistant-body">
        {entries.length === 0 && (
          <div className="assistant-empty">
            <p>Ask for scene changes in plain language. Everything it does lands on the undo stack.</p>
            <p className="assistant-example">“{PLACEHOLDER}”</p>
            {mcp.channels.length > 0 && (
              <p className="assistant-note">
                MCP is live on {mcp.channels.join(', ')}
                {mcp.client ? ` — ${mcp.client} connected` : ''}. See docs/AI.md to attach an
                external client.
              </p>
            )}
          </div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className={`assistant-row ${entry.kind} ${entry.failed ? 'failed' : ''}`}>
            {entry.kind === 'tool' ? (
              <>
                <span className="assistant-tool">{entry.tool}</span>
                <span className="assistant-text">{entry.text}</span>
              </>
            ) : (
              <span className="assistant-text">{entry.text}</span>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="assistant-composer">
        <textarea
          value={draft}
          placeholder={session ? 'Describe the change…' : 'Add an API key to start.'}
          disabled={!session}
          spellCheck={false}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            // The textarea has to swallow keys, or W would switch tools mid-word.
            event.stopPropagation();
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button onClick={() => session?.stop()} title="Stop the current run">
            ■ Stop
          </button>
        ) : (
          <button onClick={submit} disabled={!session || draft.trim() === ''} title="Send (Enter)">
            Send
          </button>
        )}
      </div>
    </div>
  );
}
