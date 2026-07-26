import { useEffect, useRef, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect(): void;
}

export type MenuEntry = MenuItem | 'separator';

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose(): void;
}

/**
 * Right-click menu. Positioned in viewport coordinates and flipped back on-screen when it
 * would overflow, which happens constantly for rows near the bottom of the Hierarchy.
 */
export function ContextMenu({ x, y, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element) {
      const rect = element.getBoundingClientRect();
      const left = Math.min(x, innerWidth - rect.width - 4);
      const top = Math.min(y, innerHeight - rect.height - 4);
      element.style.left = `${Math.max(4, left)}px`;
      element.style.top = `${Math.max(4, top)}px`;
    }

    const dismiss = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Capture phase so a click anywhere closes the menu before other handlers run.
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [x, y, onClose]);

  return (
    <div className="context-menu" ref={ref} style={{ left: x, top: y }}>
      {entries.map((entry, index): ReactNode => {
        if (entry === 'separator') {
          return <div className="context-menu-separator" key={`sep-${index}`} />;
        }
        return (
          <button
            key={entry.label}
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect();
              onClose();
            }}
          >
            <span>{entry.label}</span>
            {entry.shortcut && <span className="shortcut">{entry.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}
