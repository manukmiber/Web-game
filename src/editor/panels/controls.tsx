import type { ReactNode } from 'react';

/**
 * The settings controls the Performance, Graphics and Hardware panels are built from.
 *
 * These three used to share one CSS class — `.perf-row` — with the Graphics panel overriding
 * its grid template and the comment above the override explaining that "two panels that do the
 * same kind of job should not look like two different products". That was right about the
 * problem and wrong about the fix: they were sharing a stylesheet while each keeping its own
 * copy of the `Row` and `Slider` components. Sharing the components instead is what actually
 * keeps them from drifting.
 */

/** A titled block of settings. Blocks flow into columns when the dock is wide. */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="group">
      <h3 className="group-title">{title}</h3>
      <div className="group-body">{children}</div>
    </section>
  );
}

/** Label on the left, control on the right. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="control-row">
      <label>{label}</label>
      {children}
    </div>
  );
}

/**
 * A range input with its value spelled out in the units the setting is actually in.
 *
 * The formatted readout is not decoration: `0.55` means nothing next to a slider, and `55%`
 * or `275 m` is the number you would write down when reporting what you measured.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
  onChange(value: number): void;
}) {
  return (
    <div className="control-row slider-row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <span className="control-value">{format(value)}</span>
    </div>
  );
}
