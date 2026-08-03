import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import '@engine/assistant';
import { McpServer } from '@engine/assistant/mcp/McpServer';
import type { ToolContext } from '@engine/assistant/ToolRegistry';
import { installGameplaySystems, type GameplaySystems } from '@engine/gameplay/systems';
import { Engine } from '@engine/loop/Engine';
import type { Vec3 } from '@engine/scene/types';
import { disableWorkerSimulation, enableWorkerSimulation } from '@engine/worker/WorkerSimBridge';
import { CommandSceneEditor } from './assistant/CommandSceneEditor';
import { connectMcpBridge, type McpBridgeState } from './assistant/mcpBridge';
import type { Command } from './commands/Command';
import { CommandHistory } from './commands/Command';
import { DEFAULT_BOARD_PROFILE, SimulatedRig, type BoardProfile } from './hardware/simulated';
import { LocalStorageAdapter, type ScenePersistence } from './state/persistence';
import { SaveGameStorage } from './state/saveGamePersistence';
import { useEditorStore } from './state/editorStore';

export interface EditorContextValue {
  engine: Engine;
  history: CommandHistory;
  storage: ScenePersistence;
  /** A save-game slot store — a different keyspace from `storage`, see `saveGamePersistence.ts`. */
  saveStorage: ScenePersistence;
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
  /**
   * The simulated board, if one has been added.
   *
   * Owned here rather than by the Hardware panel because the panel is now a dock tab, and a
   * tab that is not frontmost is unmounted. A rig held in panel state would be forgotten the
   * moment you looked at the Console — leaving its device in the bus with nothing draining its
   * outbound queue, and the *next* "+ Simulated" adding a second one beside it.
   */
  simulatedRig(): SimulatedRig | null;
  addSimulatedRig(id: string, profile?: BoardProfile): Promise<SimulatedRig>;
  removeSimulatedRig(): void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

/** Reported to MCP clients in `initialize`, so a client can tell which build it is driving. */
const EDITOR_VERSION = '0.7.9.6';

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
  const rigRef = useRef<SimulatedRig | null>(null);

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
      saveStorage: new SaveGameStorage(),
      run: (command) => history.execute(command),
      toolContext,
      setSpawnPoint: (resolve) => {
        spawnPointRef.current = resolve;
      },
      mcp: new McpServer({ name: 'web-3d-scene-editor', version: EDITOR_VERSION, context: toolContext }),
      mcpState: () => mcpStateRef.current,
      simulatedRig: () => rigRef.current,
      addSimulatedRig: async (id, profile = DEFAULT_BOARD_PROFILE) => {
        if (rigRef.current) return rigRef.current;
        const rig = new SimulatedRig(id, profile);
        rigRef.current = rig;
        engine.hardware.add(rig.device);
        await rig.start();
        return rig;
      },
      removeSimulatedRig: () => {
        rigRef.current = null;
      },
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
      engine.game.events.on('restored', () =>
        useEditorStore.getState().pushConsole({
          level: 'log',
          source: 'Save',
          text: 'Game loaded.',
          entityId: null,
        }),
      ),
      // A clip that 404s or fails to decode should not fail silently — it is the audio
      // equivalent of the "textures work sometimes" bug v0.7.6 fixed for materials.
      engine.audio.events.on('loadError', ({ url, message }) =>
        useEditorStore.getState().pushConsole({
          level: 'error',
          source: 'Audio',
          text: `Could not load "${url}": ${message}`,
          entityId: null,
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
      // Pause and time scale can be moved from either end — the toolbar's buttons or a script's
      // `time.scale = 0.2` — so the store follows the engine rather than the other way round.
      engine.events.on('timeChanged', ({ paused, timeScale }) =>
        useEditorStore.getState().setClock(paused, timeScale),
      ),
      // A system ordering constraint the scheduler could not satisfy. It runs the frame anyway
      // in a defensible order, so without this the only symptom is a system that reads
      // last frame's world — which looks like input lag, not like a scheduling bug.
      engine.events.on('scheduleConflicts', ({ conflicts }) => {
        for (const text of conflicts) {
          useEditorStore.getState().pushConsole({
            level: 'warn',
            source: 'Schedule',
            text,
            entityId: null,
          });
        }
      }),
      // The simulated board's outbound queue has to be drained whether or not anyone is
      // looking, or a play session with the Hardware tab in the background accumulates every
      // line the engine ever wrote to it.
      engine.events.on('afterUpdate', () => rigRef.current?.poll()),
    ];

    engine.start();
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      engine.stop();
    };
  }, [value]);

  // Kept as its own effect, separate from the one above: this is the one place the "run
  // simulation in a Worker" setting (Performance panel) actually takes effect, and it has to
  // survive the Performance panel itself being unmounted — a hidden dock panel is unmounted
  // (§14.4), and a setting that reverted itself the moment you looked at another tab would not
  // be a setting.
  useEffect(() => {
    const { engine, systems } = value;
    let active = false;
    const applyState = (enabled: boolean) => {
      if (enabled === active) return;
      active = enabled;
      if (enabled) enableWorkerSimulation(engine, systems);
      else disableWorkerSimulation(engine);
    };

    applyState(useEditorStore.getState().simWorkerEnabled);
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      if (state.simWorkerEnabled !== previous.simWorkerEnabled) applyState(state.simWorkerEnabled);
    });
    return () => {
      unsubscribe();
      if (active) disableWorkerSimulation(engine);
    };
  }, [value]);

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside an EditorProvider');
  return value;
}
