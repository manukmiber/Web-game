import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScriptComponent, ScriptPropValue } from '@engine/components/Script';
import { compileScript } from '@engine/scripting/sandbox';
import type { EntityId } from '@engine/scene/types';
import { useEditor } from '../EditorContext';
import { SetComponentPropertyCommand } from '../commands/sceneCommands';

interface Props {
  entityId: EntityId;
  /**
   * Where this Script sits in the entity's component array.
   *
   * Not optional, and not derived from the type: an entity may carry several scripts, and every
   * write below has to name which one. Addressing by type would edit the first script's source
   * whichever editor you typed into.
   */
  componentIndex: number;
  script: ScriptComponent;
}

const PROP_DEFAULTS: Record<string, ScriptPropValue> = {
  number: 0,
  string: '',
  boolean: false,
};

/**
 * Source editor for a Script component, shown under it in the Inspector — the same treatment
 * the modifier stack gets, and for the same reason: a schema-driven single-line text field is
 * not a code editor.
 *
 * The draft is local and applied deliberately (blur, Ctrl+Enter, or the button) rather than on
 * every keystroke. Applying live would push an undo entry per character and, in Play mode,
 * recompile and restart the behaviour on every keypress — including the half-typed states.
 *
 * A plain textarea rather than CodeMirror or Monaco: syntax highlighting is worth real money
 * in bundle size, and the compile check below already catches the error that matters.
 */
export function ScriptEditor({ entityId, componentIndex, script }: Props) {
  const { engine, run } = useEditor();
  const [draft, setDraft] = useState(script.source);
  const [newProp, setNewProp] = useState('');
  const [newPropType, setNewPropType] = useState<'number' | 'string' | 'boolean'>('number');
  const dirty = draft !== script.source;
  const textarea = useRef<HTMLTextAreaElement>(null);

  /**
   * Derived from the applied source rather than held in state.
   *
   * Held in state it was wrong in the one case that matters: applying sets the source, which
   * re-runs the sync effect below, which cleared the error a moment after it appeared. Nothing
   * is recompiled needlessly — the compiler caches by source text.
   */
  const error = useMemo(() => {
    const compiled = compileScript(script.source);
    return compiled.ok ? null : compiled.error;
  }, [script.source]);

  // Re-sync when the selection changes, or when an undo rewrites the source underneath us.
  useEffect(() => {
    setDraft(script.source);
  }, [entityId, componentIndex, script.source]);

  const apply = () => {
    if (!dirty) return;
    // A script that does not parse is still saved — losing what you typed because it has a
    // missing brace would be its own kind of broken. The error banner reports it instead.
    run(
      new SetComponentPropertyCommand(
        engine.scene,
        [entityId],
        'Script',
        'source',
        draft,
        componentIndex,
      ),
    );
  };

  const setProps = (props: Record<string, ScriptPropValue>) => {
    run(
      new SetComponentPropertyCommand(
        engine.scene,
        [entityId],
        'Script',
        'props',
        props,
        componentIndex,
      ),
    );
  };

  const addProp = () => {
    const key = newProp.trim();
    if (!key || key in (script.props ?? {})) return;
    setProps({ ...script.props, [key]: PROP_DEFAULTS[newPropType]! });
    setNewProp('');
  };

  return (
    <div className="script-editor">
      <div className="script-editor-bar">
        <span>Source</span>
        <span>
          {error && <span className="script-error-flag">error</span>}
          {dirty && <span className="script-dirty">modified</span>}
          <button onClick={apply} disabled={!dirty} title="Apply changes (Ctrl+Enter)">
            Apply
          </button>
          <button
            onClick={() => setDraft(script.source)}
            disabled={!dirty}
            title="Discard changes"
          >
            Revert
          </button>
        </span>
      </div>

      <textarea
        ref={textarea}
        className="script-source"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          // The textarea has to swallow keys, or W would switch tools mid-word.
          event.stopPropagation();
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            apply();
          }
          if (event.key === 'Tab') {
            event.preventDefault();
            const element = event.currentTarget;
            const { selectionStart, selectionEnd, value } = element;
            const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
            setDraft(next);
            requestAnimationFrame(() => element.setSelectionRange(selectionStart + 2, selectionStart + 2));
          }
        }}
      />

      {error && <div className="script-error">{error}</div>}

      <div className="script-props">
        <div className="script-editor-bar">
          <span>Properties</span>
        </div>
        {Object.keys(script.props ?? {}).length === 0 && (
          <div className="mixed-note">
            No properties. Add one to tune this script per entity without editing its source.
          </div>
        )}
        {Object.keys(script.props ?? {}).map((key) => (
          <div className="script-prop-row" key={key}>
            <code>{key}</code>
            <button
              onClick={() => {
                const next = { ...script.props };
                delete next[key];
                setProps(next);
              }}
              title={`Remove ${key}`}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="script-prop-add">
          <input
            value={newProp}
            placeholder="name"
            onChange={(event) => setNewProp(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') addProp();
            }}
          />
          <select
            value={newPropType}
            onChange={(event) => setNewPropType(event.currentTarget.value as typeof newPropType)}
          >
            <option value="number">number</option>
            <option value="string">string</option>
            <option value="boolean">boolean</option>
          </select>
          <button onClick={addProp} disabled={!newProp.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
