import { useEffect, useRef, useState } from 'react';

interface NumberFieldProps {
  value: number;
  /** True when a multi-selection disagrees; shows a placeholder instead of a wrong number. */
  mixed?: boolean;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  onChange(value: number): void;
}

/**
 * Number input that stays editable while the value changes underneath it.
 *
 * The problem this solves: the Inspector and the gizmo are two views of the same data. A
 * controlled input would fight the user mid-typing — "1.5" reformats to "1" the moment the
 * "." is typed and the value round-trips. So the field keeps its own draft text while
 * focused, and only re-syncs from props when it isn't.
 */
export function NumberField({
  value,
  mixed,
  min,
  max,
  step = 0.1,
  integer,
  onChange,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(() => format(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(format(value));
  }, [value]);

  const commit = (text: string) => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setDraft(format(value));
      return;
    }
    let next = integer ? Math.round(parsed) : parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(format(next));
    if (next !== value) onChange(next);
  };

  return (
    <input
      type="number"
      value={mixed && !focused.current ? '' : draft}
      placeholder={mixed ? '—' : undefined}
      step={step}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={(event) => {
        focused.current = false;
        commit(event.currentTarget.value);
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        // Live-apply so dragging the spinner or holding an arrow key updates the viewport;
        // the command merge window folds the burst into one undo entry.
        const parsed = Number(event.currentTarget.value);
        if (event.currentTarget.value !== '' && Number.isFinite(parsed)) commit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        event.stopPropagation();
      }}
    />
  );
}

function format(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toFixed(5)));
}

interface Vec3FieldProps {
  value: [number, number, number];
  mixed?: [boolean, boolean, boolean];
  step?: number;
  onChange(axis: 0 | 1 | 2, value: number): void;
}

/** Position/Rotation/Scale row with Unity's X/Y/Z axis colouring. */
export function Vec3Field({ value, mixed, step, onChange }: Vec3FieldProps) {
  return (
    <div className="vec3">
      {(['x', 'y', 'z'] as const).map((axis, index) => (
        <div className={`vec3-axis ${axis}`} key={axis}>
          <span>{axis.toUpperCase()}</span>
          <NumberField
            value={value[index] ?? 0}
            mixed={mixed?.[index]}
            step={step}
            onChange={(next) => onChange(index as 0 | 1 | 2, next)}
          />
        </div>
      ))}
    </div>
  );
}

interface Vec2FieldProps {
  value: [number, number];
  step?: number;
  /** Axis captions. Default X/Y; a texture tiling row wants U/V and a rect wants W/H. */
  labels?: readonly [string, string];
  onChange(axis: 0 | 1, value: number): void;
}

/** Two-number row. Same shape as `Vec3Field`, minus the axis the value does not have. */
export function Vec2Field({ value, step, labels = ['X', 'Y'], onChange }: Vec2FieldProps) {
  return (
    <div className="vec2">
      {([0, 1] as const).map((index) => (
        <div className={`vec3-axis ${index === 0 ? 'x' : 'y'}`} key={index}>
          <span>{labels[index]}</span>
          <NumberField
            value={value[index] ?? 0}
            step={step}
            onChange={(next) => onChange(index, next)}
          />
        </div>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
}

export function Section({ title, children, actions, defaultOpen = true }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="inspector-section">
      <div className="inspector-section-header" onClick={() => setOpen(!open)}>
        <span>
          {open ? '▼' : '▶'} {title}
        </span>
        <span onClick={(event) => event.stopPropagation()}>{actions}</span>
      </div>
      {open && <div className="inspector-section-body">{children}</div>}
    </div>
  );
}
