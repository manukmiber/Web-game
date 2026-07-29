import { useEffect } from 'react';
import { isTextEntry } from './dom';
import { useEditor } from './EditorContext';
import { useEditorStore } from './state/editorStore';
import {
  DeleteEntitiesCommand,
  DuplicateEntitiesCommand,
  GroupEntitiesCommand,
} from './commands/sceneCommands';
import { PANEL_SHORTCUTS } from './state/layout';
import { AUTOSAVE_KEY, saveScene } from './state/persistence';
import type { ViewportController } from './viewport/ViewportController';

/** Unity's editor shortcuts: Q/W/E/R tools, F focus, X space toggle, Ctrl+Z/Shift+Z history. */
export function useShortcuts(viewport: ViewportController | null): void {
  const { engine, history, storage, run } = useEditor();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;

      const store = useEditorStore.getState();
      const selection = store.selection;
      const ctrl = event.ctrlKey || event.metaKey;

      /**
       * Panel keys work in both modes, and there is one table of them rather than a branch per
       * panel in each. Which panel a key opens now comes from `PANELS`, the same description
       * the tab strips and the status bar are built from — so a new panel is one entry there
       * and is reachable from all three places at once.
       */
      const panel = PANEL_SHORTCUTS[event.key];
      if (panel) {
        event.preventDefault();
        store.togglePanel(panel);
        return;
      }

      /**
       * Play mode owns the rest of the keyboard. W is "walk forward" there, not "switch to the
       * move tool", and a stray Ctrl+D mid-session would duplicate the zombie chasing you.
       * Escape stops playing — and the panel keys above still work, because watching the frame
       * time or a hardware channel while the character moves is exactly when you need them.
       */
      if (store.playing) {
        if (event.key === 'Escape') {
          event.preventDefault();
          engine.setMode('edit');
          return;
        }
        // Ctrl+P for pause, on the same argument the panel keys are made an exception: freezing
        // the clock to look at the frame you are on is a thing you want to do *while* playing,
        // and reaching for the toolbar means several more frames go by before you get there.
        if (ctrl && event.key.toLowerCase() === 'p') {
          event.preventDefault();
          engine.setPaused(!engine.paused);
        }
        return;
      }

      if (ctrl) {
        switch (event.key.toLowerCase()) {
          case 'z':
            event.preventDefault();
            if (event.shiftKey) history.redo();
            else history.undo();
            return;
          case 'y':
            event.preventDefault();
            history.redo();
            return;
          case 'd': {
            if (selection.length === 0) return;
            event.preventDefault();
            const command = new DuplicateEntitiesCommand(engine.scene, selection);
            run(command);
            store.setSelection(command.createdRootIds);
            return;
          }
          case 'g': {
            if (selection.length === 0) return;
            event.preventDefault();
            const command = new GroupEntitiesCommand(engine.scene, selection);
            run(command);
            if (command.createdGroupId) store.setSelection([command.createdGroupId]);
            return;
          }
          case 's':
            event.preventDefault();
            void saveScene(storage, engine.scene, AUTOSAVE_KEY)
              .then(() => store.setStatusMessage('Scene saved to local storage.'))
              .catch((error: Error) => store.setStatusMessage(error.message));
            return;
          case 'a':
            event.preventDefault();
            store.setSelection(engine.scene.all().map((entity) => entity.id));
            return;
          default:
            return;
        }
      }

      switch (event.key) {
        case 'q':
        case 'Q':
          store.setTool('select');
          break;
        case 'w':
        case 'W':
          store.setTool('move');
          break;
        case 'e':
        case 'E':
          store.setTool('rotate');
          break;
        case 'r':
        case 'R':
          store.setTool('scale');
          break;
        case 'x':
        case 'X':
          store.setSpace(store.space === 'local' ? 'world' : 'local');
          break;
        case 'f':
        case 'F':
          viewport?.focusSelection();
          break;
        case 'Delete':
        case 'Backspace':
          if (selection.length === 0) return;
          event.preventDefault();
          run(new DeleteEntitiesCommand(engine.scene, selection));
          store.clearSelection();
          break;
        case 'Escape':
          store.clearSelection();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [engine, history, storage, run, viewport]);
}
