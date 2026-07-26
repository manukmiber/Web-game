import { useEffect, useRef } from 'react';
import { useEditorStore } from '../state/editorStore';

const LEVEL_ICON: Record<string, string> = {
  log: '›',
  info: 'ℹ',
  warn: '▲',
  error: '✕',
};

/**
 * Script output and gameplay events.
 *
 * Play mode is otherwise opaque: a script that throws on frame one and a script that does
 * nothing look identical from the viewport. This is the difference between "it doesn't work"
 * and "line 4, entity.postion is undefined".
 *
 * Clicking a message selects the entity that produced it, which is the fastest path from a
 * complaint to the thing complaining.
 */
export function Console() {
  const messages = useEditorStore((s) => s.consoleMessages);
  const visible = useEditorStore((s) => s.consoleVisible);
  const clearConsole = useEditorStore((s) => s.clearConsole);
  const setConsoleVisible = useEditorStore((s) => s.setConsoleVisible);
  const setSelection = useEditorStore((s) => s.setSelection);
  const bottom = useRef<HTMLDivElement>(null);

  // Follow the tail, the way a terminal does.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  if (!visible) {
    const errors = messages.filter((message) => message.level === 'error').length;
    return (
      <button
        className={`console-toggle ${errors > 0 ? 'has-errors' : ''}`}
        onClick={() => setConsoleVisible(true)}
        title="Show the script console"
      >
        Console {errors > 0 ? `(${errors})` : messages.length > 0 ? `(${messages.length})` : ''}
      </button>
    );
  }

  return (
    <div className="console">
      <div className="console-header">
        <span>Console</span>
        <span>
          <button onClick={clearConsole} title="Clear messages">
            Clear
          </button>
          <button onClick={() => setConsoleVisible(false)} title="Hide the console">
            ✕
          </button>
        </span>
      </div>
      <div className="console-body">
        {messages.length === 0 && (
          <div className="console-empty">
            Nothing logged yet. `console.log(...)` from a script lands here, as do combat events.
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`console-row ${message.level}`}
            onClick={() => message.entityId && setSelection([message.entityId])}
            title={message.entityId ? 'Select the entity this came from' : undefined}
          >
            <span className="console-icon">{LEVEL_ICON[message.level] ?? '›'}</span>
            <span className="console-source">{message.source}</span>
            <span className="console-text">{message.text}</span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}
