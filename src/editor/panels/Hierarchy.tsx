import { useCallback, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@engine/scene/types';
import { useEditor } from '../EditorContext';
import { useEditorStore } from '../state/editorStore';
import {
  DeleteEntitiesCommand,
  DuplicateEntitiesCommand,
  GroupEntitiesCommand,
  RenameEntityCommand,
  ReparentEntitiesCommand,
} from '../commands/sceneCommands';
import { ContextMenu, type MenuEntry } from './ContextMenu';

type DropZone = 'before' | 'into' | 'after';

interface Row {
  id: EntityId;
  depth: number;
  name: string;
  hasChildren: boolean;
  isEmpty: boolean;
}

/** Fraction of row height at each edge that reorders rather than reparents. */
const EDGE_RATIO = 0.28;

export function Hierarchy() {
  const { engine, run } = useEditor();
  const scene = engine.scene;
  const selection = useEditorStore((s) => s.selection);
  const sceneRevision = useEditorStore((s) => s.sceneRevision);
  const setSelection = useEditorStore((s) => s.setSelection);
  const toggleSelection = useEditorStore((s) => s.toggleSelection);
  const clearSelection = useEditorStore((s) => s.clearSelection);

  const [collapsed, setCollapsed] = useState<Set<EntityId>>(new Set());
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<EntityId | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: EntityId | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: EntityId | null; zone: DropZone } | null>(null);
  const draggedIds = useRef<EntityId[]>([]);

  /**
   * The visible rows.
   *
   * With a filter typed, a row survives if it matches *or* if a descendant does — an entity
   * shown without its parents would be a flat list of names with no way to tell which of the
   * three "Wall" objects it is. Collapsed state is ignored while filtering, for the same
   * reason: a match inside a collapsed subtree that stayed hidden would read as "no results".
   */
  const rows = useMemo<Row[]>(() => {
    void sceneRevision; // Recompute whenever scene structure changes.
    const needle = query.trim().toLowerCase();
    const out: Row[] = [];

    const walk = (id: EntityId, depth: number): boolean => {
      const entity = scene.get(id);
      if (!entity) return false;
      const children = scene.childrenOf(id);
      const self = needle === '' || entity.name.toLowerCase().includes(needle);
      const row: Row = {
        id,
        depth,
        name: entity.name,
        hasChildren: children.length > 0,
        isEmpty: entity.components.length === 0,
      };
      const at = out.length;
      out.push(row);

      let descendant = false;
      if (needle !== '' || !collapsed.has(id)) {
        for (const child of children) descendant = walk(child, depth + 1) || descendant;
      }
      if (self || descendant) return true;
      // No match here or below: drop this row and everything it pushed.
      out.length = at;
      return false;
    };

    for (const id of scene.rootIds()) walk(id, 0);
    return out;
  }, [scene, sceneRevision, collapsed, query]);

  const toggleCollapsed = useCallback((id: EntityId) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onRowClick = (event: React.MouseEvent, row: Row) => {
    if (event.shiftKey && selection.length > 0) {
      // Range select across the flattened, currently visible rows — the same thing the user
      // sees, so a collapsed subtree isn't silently included.
      const anchor = rows.findIndex((r) => r.id === selection[selection.length - 1]);
      const target = rows.findIndex((r) => r.id === row.id);
      if (anchor !== -1 && target !== -1) {
        const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
        setSelection(rows.slice(from, to + 1).map((r) => r.id));
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) toggleSelection(row.id);
    else setSelection([row.id]);
  };

  /** Entities to act on: the clicked row, extended to the whole selection if it's part of it. */
  const targetsFor = (id: EntityId | null): EntityId[] => {
    if (id === null) return selection;
    return selection.includes(id) ? selection : [id];
  };

  const commitRename = (id: EntityId, name: string) => {
    setRenamingId(null);
    const trimmed = name.trim();
    if (trimmed && trimmed !== scene.get(id)?.name) {
      run(new RenameEntityCommand(scene, id, trimmed));
    }
  };

  // ------------------------------------------------------------ drag & drop

  const onDragStart = (event: React.DragEvent, row: Row) => {
    draggedIds.current = targetsFor(row.id);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox needs data set for a drag to start at all.
    event.dataTransfer.setData('text/plain', row.id);
  };

  const onDragOver = (event: React.DragEvent, row: Row | null) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!row) {
      setDropTarget({ id: null, zone: 'into' });
      return;
    }
    // Top/bottom edges reorder among siblings; the middle reparents. Same convention as
    // Unity's Hierarchy, and it makes "move to root" reachable without an empty-space drop.
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    const zone: DropZone = ratio < EDGE_RATIO ? 'before' : ratio > 1 - EDGE_RATIO ? 'after' : 'into';
    setDropTarget({ id: row.id, zone });
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const target = dropTarget;
    const ids = draggedIds.current;
    setDropTarget(null);
    draggedIds.current = [];
    if (!target || ids.length === 0) return;

    if (target.id === null) {
      run(new ReparentEntitiesCommand(scene, ids, null));
      return;
    }
    if (ids.includes(target.id)) return;

    if (target.zone === 'into') {
      run(new ReparentEntitiesCommand(scene, ids, target.id));
      return;
    }
    const targetEntity = scene.get(target.id);
    if (!targetEntity) return;
    const index = scene.indexOf(target.id) + (target.zone === 'after' ? 1 : 0);
    run(new ReparentEntitiesCommand(scene, ids, targetEntity.parentId, index));
  };

  // ------------------------------------------------------------ context menu

  const menuEntries = (id: EntityId | null): MenuEntry[] => {
    const targets = targetsFor(id);
    const disabled = targets.length === 0;
    return [
      {
        label: 'Rename',
        shortcut: 'F2',
        disabled: targets.length !== 1,
        onSelect: () => setRenamingId(targets[0]!),
      },
      {
        label: 'Duplicate',
        shortcut: 'Ctrl+D',
        disabled,
        onSelect: () => {
          const command = new DuplicateEntitiesCommand(scene, targets);
          run(command);
          setSelection(command.createdRootIds);
        },
      },
      {
        label: 'Group Selected',
        shortcut: 'Ctrl+G',
        disabled,
        onSelect: () => {
          const command = new GroupEntitiesCommand(scene, targets);
          run(command);
          if (command.createdGroupId) setSelection([command.createdGroupId]);
        },
      },
      'separator',
      {
        label: 'Delete',
        shortcut: 'Del',
        disabled,
        onSelect: () => {
          run(new DeleteEntitiesCommand(scene, targets));
          clearSelection();
        },
      },
    ];
  };

  return (
    <div className="panel-content">
      <div className="panel-bar">
        <input
          className="panel-search"
          value={query}
          placeholder="Find by name…"
          spellCheck={false}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
            event.stopPropagation();
          }}
        />
        <span className="panel-bar-count" title="Objects shown">
          {rows.length}
        </span>
      </div>
      <div
        className="panel-scroll"
        onDragOver={(event) => onDragOver(event, null)}
        onDrop={onDrop}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, id: null });
          }
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearSelection();
        }}
      >
        {rows.length === 0 ? (
          <div className="empty-note">
            {query.trim() ? `Nothing matches “${query.trim()}”.` : 'Scene is empty. Use Add in the toolbar.'}
          </div>
        ) : (
          <div className="tree">
            {rows.map((row) => {
              const isDropTarget = dropTarget?.id === row.id;
              const className = [
                'tree-row',
                selection.includes(row.id) ? 'selected' : '',
                isDropTarget ? `drop-${dropTarget.zone}` : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <div
                  key={row.id}
                  className={className}
                  style={{ paddingLeft: 4 + row.depth * 14 }}
                  draggable={renamingId !== row.id}
                  onDragStart={(event) => onDragStart(event, row)}
                  onDragOver={(event) => onDragOver(event, row)}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={onDrop}
                  onClick={(event) => onRowClick(event, row)}
                  onDoubleClick={() => setRenamingId(row.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!selection.includes(row.id)) setSelection([row.id]);
                    setMenu({ x: event.clientX, y: event.clientY, id: row.id });
                  }}
                >
                  <span
                    className="tree-twisty"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (row.hasChildren) toggleCollapsed(row.id);
                    }}
                  >
                    {/* A filter expands everything, so the twisty has to agree with what is
                        actually on screen rather than with the stored collapsed set. */}
                    {row.hasChildren ? (collapsed.has(row.id) && !query.trim() ? '▶' : '▼') : ''}
                  </span>
                  <span className="tree-icon">{row.isEmpty ? '◻' : '◼'}</span>
                  {renamingId === row.id ? (
                    <input
                      className="tree-rename"
                      autoFocus
                      defaultValue={row.name}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) => commitRename(row.id, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename(row.id, event.currentTarget.value);
                        if (event.key === 'Escape') setRenamingId(null);
                        event.stopPropagation();
                      }}
                    />
                  ) : (
                    <span className="tree-label">{row.name}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
