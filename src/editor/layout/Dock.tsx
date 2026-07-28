import type { ReactNode } from 'react';
import { useEditorStore } from '../state/editorStore';
import { DOCK_PANELS, PANELS, dockKeys, type DockId, type PanelId } from '../state/layout';

interface Props {
  dock: DockId;
  /** Rendered for the frontmost panel only — a hidden panel should cost nothing per frame. */
  children(panel: PanelId): ReactNode;
  /** Extra controls for the dock's own bar, right of the tabs. */
  actions?: ReactNode;
}

/**
 * A dock: a tab strip, and the frontmost panel's body underneath it.
 *
 * Only the frontmost panel is mounted. That matters more than it looks — the Hardware panel
 * re-renders at 15 Hz off the engine's `afterUpdate`, and the Performance panel polls the
 * render loop four times a second. Under the old floating-panel scheme those ran whenever the
 * panel was open, which was easy to leave true for a whole session. Unmounting them when their
 * tab is not frontmost is what makes it safe to keep the bottom dock open all the time.
 */
export function Dock({ dock, children, actions }: Props) {
  const layout = useEditorStore((s) => s.layout);
  const setLayout = useEditorStore((s) => s.setLayout);
  const showPanel = useEditorStore((s) => s.showPanel);

  const keys = dockKeys(dock);
  const panels = DOCK_PANELS[dock];
  const active: PanelId = keys.panel ? layout[keys.panel] : panels[0]!;

  return (
    <section className={`dock dock-${dock}`} aria-label={`${dock} dock`}>
      <div className="dock-bar">
        <div className="dock-tabs" role="tablist">
          {panels.map((id) => {
            const panel = PANELS[id];
            const selected = id === active;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={selected}
                className={`dock-tab ${selected ? 'active' : ''}`}
                title={panel.title}
                onClick={() => showPanel(id)}
              >
                <span className="dock-tab-icon">{panel.icon}</span>
                <span className="dock-tab-label">{panel.label}</span>
                <PanelBadge panel={id} />
              </button>
            );
          })}
        </div>
        <div className="dock-actions">
          {actions}
          <button
            className="icon-button"
            title={`Collapse the ${dock} dock (${PANELS[active].shortcut})`}
            aria-label={`Collapse the ${dock} dock`}
            onClick={() => setLayout({ [keys.open]: false })}
          >
            {dock === 'bottom' ? '▾' : dock === 'left' ? '◂' : '▸'}
          </button>
        </div>
      </div>
      <div className="dock-body" role="tabpanel">
        {children(active)}
      </div>
    </section>
  );
}

/**
 * The count on a tab.
 *
 * Only two panels have anything worth counting from outside themselves, and both are things
 * you want to know without switching to the tab: how many errors the console is holding, and
 * whether the assistant is still working.
 */
function PanelBadge({ panel }: { panel: PanelId }) {
  const errors = useEditorStore((s) =>
    panel === 'console' ? s.consoleMessages.filter((m) => m.level === 'error').length : 0,
  );
  const busy = useEditorStore((s) => panel === 'assistant' && s.assistantBusy);

  if (panel === 'console' && errors > 0) {
    return <span className="badge badge-error">{errors}</span>;
  }
  if (busy) return <span className="badge badge-busy" title="Working…" />;
  return null;
}
