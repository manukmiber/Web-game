import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore, type ConsoleMessage } from '../state/editorStore';

const LEVEL_ICON: Record<ConsoleMessage['level'], string> = {
  log: '›',
  info: 'ℹ',
  warn: '▲',
  error: '✕',
};

type Filter = 'all' | 'warn' | 'error';

/**
 * Script output and gameplay events.
 *
 * Play mode is otherwise opaque: a script that throws on frame one and a script that does
 * nothing look identical from the viewport. This is the difference between "it doesn't work"
 * and "line 4, entity.postion is undefined".
 *
 * Clicking a message selects the entity that produced it, which is the fastest path from a
 * complaint to the thing complaining.
 *
 * The filter and the search box are new in v0.7.4, and they are the reason the 200-message cap
 * is livable: the one error you care about used to be somewhere in a wall of per-frame logs,
 * with nothing but a scrollbar to find it.
 */
export function Console() {
  const messages = useEditorStore((s) => s.consoleMessages);
  const clearConsole = useEditorStore((s) => s.clearConsole);
  const setSelection = useEditorStore((s) => s.setSelection);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    let warn = 0;
    let error = 0;
    for (const message of messages) {
      if (message.level === 'warn') warn += 1;
      else if (message.level === 'error') error += 1;
    }
    return { all: messages.length, warn, error };
  }, [messages]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return messages.filter((message) => {
      if (filter === 'error' && message.level !== 'error') return false;
      if (filter === 'warn' && message.level !== 'warn' && message.level !== 'error') return false;
      if (!needle) return true;
      return (
        message.text.toLowerCase().includes(needle) ||
        message.source.toLowerCase().includes(needle)
      );
    });
  }, [messages, filter, query]);

  // Follow the tail, the way a terminal does.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [shown]);

  return (
    <div className="panel-content">
      <div className="panel-bar">
        <div className="segmented">
          {(['all', 'warn', 'error'] as const).map((level) => (
            <button
              key={level}
              className={filter === level ? 'active' : ''}
              onClick={() => setFilter(level)}
              title={`Show ${level === 'all' ? 'everything' : `${level}s and above`}`}
            >
              {level === 'all' ? 'All' : level === 'warn' ? 'Warnings' : 'Errors'}
              <span className="segmented-count">{counts[level]}</span>
            </button>
          ))}
        </div>
        <input
          className="panel-search"
          value={query}
          placeholder="Filter…"
          spellCheck={false}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <button onClick={clearConsole} disabled={messages.length === 0} title="Clear messages">
          Clear
        </button>
      </div>

      <div className="panel-scroll console-body">
        {shown.length === 0 && (
          <div className="empty-note">
            {messages.length === 0
              ? 'Nothing logged yet. `console.log(...)` from a script lands here, as do combat events.'
              : `No message matches the current filter — ${messages.length} hidden.`}
          </div>
        )}
        {shown.map((message) => (
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
