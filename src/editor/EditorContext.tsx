import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Engine } from '@engine/loop/Engine';
import type { Command } from './commands/Command';
import { CommandHistory } from './commands/Command';
import { LocalStorageAdapter, type ScenePersistence } from './state/persistence';
import { useEditorStore } from './state/editorStore';

export interface EditorContextValue {
  engine: Engine;
  history: CommandHistory;
  storage: ScenePersistence;
  /** Runs a command through the history so it lands on the undo stack. */
  run(command: Command): void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  // Refs rather than state: these are created once and must survive every re-render, and
  // recreating an Engine would drop the WebGL context.
  const engineRef = useRef<Engine>(null);
  const historyRef = useRef<CommandHistory>(null);
  engineRef.current ??= new Engine();
  historyRef.current ??= new CommandHistory();

  const value = useMemo<EditorContextValue>(() => {
    const engine = engineRef.current!;
    const history = historyRef.current!;
    return {
      engine,
      history,
      storage: new LocalStorageAdapter(),
      run: (command) => history.execute(command),
    };
  }, []);

  useEffect(() => {
    const { engine, history } = value;
    const store = useEditorStore.getState();

    const unsubscribes = [
      history.events.on('changed', ({ canUndo, canRedo }) =>
        useEditorStore.getState().setHistoryState(canUndo, canRedo),
      ),
      // Structural changes re-render the Hierarchy. Transform edits deliberately do not —
      // they fire every frame during a drag and the tree doesn't display transforms.
      engine.scene.events.on('entityAdded', () => store.bumpSceneRevision()),
      engine.scene.events.on('entityRemoved', () => store.bumpSceneRevision()),
      engine.scene.events.on('entityRenamed', () => store.bumpSceneRevision()),
      engine.scene.events.on('entityReparented', () => store.bumpSceneRevision()),
      engine.scene.events.on('componentsChanged', () => store.bumpSceneRevision()),
      engine.scene.events.on('sceneReplaced', () => {
        store.bumpSceneRevision();
        store.clearSelection();
      }),
      engine.events.on('modeChanged', ({ mode }) => store.setPlaying(mode === 'play')),
    ];

    engine.start();
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      engine.stop();
    };
  }, [value]);

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside an EditorProvider');
  return value;
}
