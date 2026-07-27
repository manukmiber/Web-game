import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import '@engine/assistant';
import { McpServer } from '@engine/assistant/mcp/McpServer';
import type { ToolContext } from '@engine/assistant/ToolRegistry';
import { installGameplaySystems, type GameplaySystems } from '@engine/gameplay/systems';
import { Engine } from '@engine/loop/Engine';
import type { Vec3 } from '@engine/scene/types';
import { CommandSceneEditor } from './assistant/CommandSceneEditor';
import { connectMcpBridge, type McpBridgeState } from './assistant/mcpBridge';
import type { Command } from './commands/Command';
import { CommandHistory } from './commands/Command';
import { LocalStorageAdapter, type ScenePersistence } from './state/persistence';
import { useEditorStore } from './state/editorStore';

export interface EditorContextValue {
  engine: Engine;
  history: CommandHistory;
  storage: ScenePersistence;
  /** The Play-mode systems, kept for their diagnostics — script messages, agent states. */
  systems: GameplaySystems;
  /** Runs a command through the history so it lands on the undo stack. */
  run(command: Command): void;
  /**
   * What the assistant tools and the MCP server are handed. Resolved per call because the
   * scene and the viewport camera both move underneath a long-lived MCP connection.
   */
  toolContext(): ToolContext;
  /** Wired up by the viewport once it exists, so new objects land where the camera looks. */
  setSpawnPoint(resolve: () => Vec3): void;
  mcp: McpServer;
  mcpState(): McpBridgeState;
}

const EditorContext = createContext<EditorContextValue | null>(null);

/** Reported to MCP clients in `initialize`, so a client can tell which build it is driving. */
const EDITOR_VERSION = '0.7.1';

export function EditorProvider({ children }: { children: ReactNode }) {
  // Refs rather than state: these are created once and must survive every re-render, and
  // recreating an Engine would drop the WebGL context.
  const engineRef = useRef<Engine>(null);
  const historyRef = useRef<CommandHistory>(null);
  const systemsRef = useRef<GameplaySystems>(null);
  engineRef.current ??= new Engine();
  historyRef.current ??= new CommandHistory();
  // Guarded rather than called inline: StrictMode runs this body twice in development, and a
  // second install would tick every gameplay system twice per frame.
  systemsRef.current ??= installGameplaySystems(engineRef.current);

  // Replaced by the viewport once it has a camera; until then new objects land at the origin.
  const spawnPointRef = useRef<() => Vec3>(() => [0, 0, 0]);
  const mcpStateRef = useRef<McpBridgeState>({ channels: [], client: null, handled: 0 });

  const value = useMemo<EditorContextValue>(() => {
    const engine = engineRef.current!;
    const history = historyRef.current!;
    const sceneEditor = new CommandSceneEditor(engine.scene, history);
    const toolContext = (): ToolContext => ({
      editor: sceneEditor,
      spawnPoint: () => spawnPointRef.current(),
    });

    return {
      engine,
      history,
      systems: systemsRef.current!,
      storage: new LocalStorageAdapter(),
      run: (command) => history.execute(command),
      toolContext,
      setSpawnPoint: (resolve) => {
        spawnPointRef.current = resolve;
      },
      mcp: new McpServer({ name: 'web-3d-scene-editor', version: EDITOR_VERSION, context: toolContext }),
      mcpState: () => mcpStateRef.current,
    };
  }, []);

  // The MCP server is connected whether or not the assistant panel is open: an external client
  // attaching to the editor should not depend on which panels the user happens to have up.
  useEffect(
    () =>
      connectMcpBridge(value.mcp, (state) => {
        mcpStateRef.current = state;
      }),
    [value],
  );

  useEffect(() => {
    const { engine, history, systems } = value;
    const store = useEditorStore.getState();
    const nameOf = (id: string | null) =>
      (id && engine.scene.get(id)?.name) || (id ? 'something' : 'nothing');

    const unsubscribes = [
      // Script output and gameplay events both land in the editor console, which is the only
      // window into a play session — nothing else reports why a zombie stopped moving.
      systems.scripts.events.on('message', (message) =>
        useEditorStore.getState().pushConsole({
          level: message.level,
          source: message.source,
          text: message.text,
          entityId: message.entityId,
        }),
      ),
      // A board connecting, disconnecting or complaining belongs in the same place script
      // errors do: it is the only way to find out that a rig stopped reporting mid-session.
      engine.hardware.events.on('log', ({ deviceId, level, text }) =>
        useEditorStore.getState().pushConsole({
          level: level === 'warn' ? 'warn' : level,
          source: deviceId,
          text,
          entityId: null,
        }),
      ),
      systems.hardware.events.on('problem', ({ entityId, text }) =>
        useEditorStore.getState().pushConsole({
          level: 'error',
          source: 'Hardware',
          text,
          entityId,
        }),
      ),
      engine.game.events.on('damaged', ({ id, amount, health, sourceId }) => {
        // Every zombie swing would drown the console; the player being hit is the one thing
        // you always want to see.
        if (!engine.scene.get(id)?.components.some((c) => c.type === 'CharacterController')) return;
        useEditorStore.getState().pushConsole({
          level: 'warn',
          source: 'Combat',
          text: `${nameOf(sourceId)} hit ${nameOf(id)} for ${amount} — ${health} left`,
          entityId: id,
        });
      }),
      engine.game.events.on('died', ({ id, sourceId }) =>
        useEditorStore.getState().pushConsole({
          level: 'warn',
          source: 'Combat',
          text: sourceId ? `${nameOf(id)} was killed by ${nameOf(sourceId)}` : `${nameOf(id)} died`,
          entityId: id,
        }),
      ),
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
