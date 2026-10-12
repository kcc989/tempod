import { PlusIcon, XIcon } from "lucide-react";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Checkbox } from "~/ui/components/ui/checkbox";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Switch } from "~/ui/components/ui/switch";
import { Textarea } from "~/ui/components/ui/textarea";
import { cn } from "~/ui/lib/utils";
import { DEFAULT_SETTINGS, type SettingsSource } from "@tempo/protocol";
import {
  effectiveEntries,
  effectiveLeaf,
  getAt,
  INSTANCE_PRESETS,
  nextRowKey,
  sourceLabel,
  toEdit,
  type EditValue,
  type EffectiveContext,
  type EnvRow,
  type FieldDef,
  type FieldState,
  type InstanceEdit,
  type RunRow,
} from "../settings-model";

const fieldId = (def: FieldDef) => `ps-${def.path.replace(/[^a-z0-9]/gi, "-")}`;

function SourceBadge({ source }: { source: SettingsSource }) {
  return (
    <Badge variant={source === "tempo" ? "secondary" : "muted"} className="font-mono">
      {sourceLabel(source)}
    </Badge>
  );
}

/** Editing a key creates an override; resetting it restores inheritance on save. */
export function FieldRow({
  def,
  state,
  onChange,
  ctx,
  error,
}: {
  def: FieldDef;
  state: FieldState;
  onChange: (next: FieldState) => void;
  ctx: EffectiveContext;
  error?: string | undefined;
}) {
  const id = fieldId(def);
  const isRecord = def.kind === "run" || def.kind === "env";
  const setValue = (value: EditValue) => onChange({ set: true, value });
  const savedOverride = getAt(ctx.layer, def.path) !== undefined;
  const resetPending = !state.set && savedOverride;
  const inheritedValue = () => toEdit(def, isRecord ? {} : getAt(ctx.settings ?? DEFAULT_SETTINGS, def.path));
  const value = state.set || resetPending ? state.value : inheritedValue();
  const source = state.set ? "tempo" : effectiveLeaf(def, ctx).source;

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="grid gap-1.5 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <span id={`${id}-label`} className="text-sm font-medium">
            {def.label}
          </span>
          {def.hint && <p className="text-xs text-muted-foreground">{def.hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!resetPending && (!isRecord || state.set) && <SourceBadge source={source} />}
          {state.set && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Reset ${def.label} to repository or default value`}
              onClick={() => onChange({ set: false, value: savedOverride ? state.value : inheritedValue() })}
            >
              Reset to inherited
            </Button>
          )}
        </div>
      </div>
      {isRecord && <EffectiveEntries def={def} ctx={ctx} />}
      {resetPending ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <p role="status">Save to restore the repository or default value.</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setValue(state.value)}>
            Undo reset
          </Button>
        </div>
      ) : (
        <Editor id={id} def={def} value={value} onChange={setValue} invalid={error !== undefined} />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function EffectiveEntries({ def, ctx }: { def: FieldDef; ctx: EffectiveContext }) {
  const entries = effectiveEntries(def, ctx);
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No entries in effect. Tempo entries merge with repository entries; matching names override them.
      </p>
    );
  }
  return (
    <div className="grid gap-1">
      <p className="text-xs text-muted-foreground">
        Tempo entries merge with repository entries; matching names override them.
      </p>
      <ul aria-label={`${def.label} in effect`} className="grid gap-0.5 text-xs">
        {entries.map((e) => (
          <li key={e.key} className="flex items-start gap-2">
            {def.kind === "run" && <span className="shrink-0 font-medium">{e.key}</span>}
            <span className="min-w-0 flex-1 truncate font-mono" title={e.text}>
              {e.text}
            </span>
            <SourceBadge source={e.source} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Editor({
  id,
  def,
  value,
  onChange,
  invalid,
}: {
  id: string;
  def: FieldDef;
  value: EditValue;
  onChange: (v: EditValue) => void;
  invalid: boolean;
}) {
  const label = def.label;
  switch (value.kind) {
    case "text": {
      const set = (text: string) => onChange({ kind: "text", text });
      if (def.kind === "select") {
        return (
          <Select value={value.text} onValueChange={set}>
            <SelectTrigger id={id} aria-label={label} aria-invalid={invalid || undefined} className="w-56">
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
            <SelectContent>
              {def.options?.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }
      if (def.kind === "multiline" || def.kind === "hosts") {
        return (
          <Textarea
            id={id}
            aria-label={label}
            aria-invalid={invalid || undefined}
            value={value.text}
            onChange={(e) => set(e.target.value)}
            spellCheck={false}
            placeholder={def.kind === "hosts" ? "example.com\n*.example.com" : undefined}
            className="max-h-48 font-mono text-xs"
          />
        );
      }
      return (
        <Input
          id={id}
          aria-label={label}
          aria-invalid={invalid || undefined}
          value={value.text}
          onChange={(e) => set(e.target.value)}
          spellCheck={false}
          {...(def.kind === "number"
            ? { type: "number", min: 5, max: 240, inputMode: "numeric" as const }
            : {})}
          className={cn(def.kind === "number" ? "w-28" : "font-mono text-xs")}
        />
      );
    }
    case "bool":
      return (
        <div className="flex items-center gap-2">
          <Switch
            id={id}
            aria-label={label}
            checked={value.on}
            onCheckedChange={(on) => onChange({ kind: "bool", on })}
          />
          <Label htmlFor={id} className="text-xs font-normal">
            {value.on ? "On" : "Off"}
          </Label>
        </div>
      );
    case "instance":
      return (
        <InstanceEditor
          id={id}
          value={value.instance}
          invalid={invalid}
          onChange={(instance) => onChange({ kind: "instance", instance })}
        />
      );
    case "run":
      return <RunRowsEditor id={id} rows={value.rows} onChange={(rows) => onChange({ kind: "run", rows })} />;
    case "env":
      return <EnvRowsEditor id={id} rows={value.rows} onChange={(rows) => onChange({ kind: "env", rows })} />;
  }
}

function InstanceEditor({
  id,
  value,
  invalid,
  onChange,
}: {
  id: string;
  value: InstanceEdit;
  invalid: boolean;
  onChange: (v: InstanceEdit) => void;
}) {
  const num = (k: "vcpu" | "memoryMib" | "diskMb", label: string) => (
    <div className="grid gap-1">
      <Label htmlFor={`${id}-${k}`} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={`${id}-${k}`}
        type="number"
        inputMode="numeric"
        className="w-28"
        aria-invalid={invalid || undefined}
        value={value[k]}
        onChange={(e) => onChange({ ...value, [k]: e.target.value })}
      />
    </div>
  );
  return (
    <div className="grid gap-2">
      <Select
        value={value.preset}
        onValueChange={(v) => onChange({ ...value, preset: v as InstanceEdit["preset"] })}
      >
        <SelectTrigger id={id} aria-label="Instance size" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {INSTANCE_PRESETS.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom</SelectItem>
        </SelectContent>
      </Select>
      {value.preset === "custom" && (
        <div className="flex flex-wrap gap-2">
          {num("vcpu", "vCPU")}
          {num("memoryMib", "Memory (MiB)")}
          {num("diskMb", "Disk (MB)")}
        </div>
      )}
    </div>
  );
}

function RunRowsEditor({
  id,
  rows,
  onChange,
}: {
  id: string;
  rows: ReadonlyArray<RunRow>;
  onChange: (rows: ReadonlyArray<RunRow>) => void;
}) {
  const patch = (key: number, p: Partial<RunRow>) =>
    onChange(
      rows.map((r) => (r.key === key ? { ...r, ...p } : p.isDefault ? { ...r, isDefault: false } : r)),
    );
  return (
    <div className="grid gap-2">
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No run scripts set in Tempo.</p>}
      {rows.map((r, i) => (
        <div key={r.key} className="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-center gap-1.5">
          <Input
            aria-label={`Run script ${i + 1} name`}
            placeholder="dev"
            value={r.id}
            onChange={(e) => patch(r.key, { id: e.target.value })}
            className="font-mono text-xs"
          />
          <Input
            aria-label={`Run script ${i + 1} command`}
            placeholder="bun run dev"
            value={r.command}
            onChange={(e) => patch(r.key, { command: e.target.value })}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove run script ${r.id || i + 1}`}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          >
            <XIcon />
          </Button>
          <Input
            aria-label={`Run script ${i + 1} folder`}
            placeholder="Folder (empty = /workspace)"
            value={r.cwd}
            onChange={(e) => patch(r.key, { cwd: e.target.value })}
            className="col-start-2 font-mono text-xs"
          />
          <div className="col-start-2 flex items-center gap-1.5">
            <Checkbox
              id={`${id}-default-${r.key}`}
              checked={r.isDefault}
              onCheckedChange={(c) => patch(r.key, { isDefault: c === true })}
            />
            <Label htmlFor={`${id}-default-${r.key}`} className="text-xs font-normal">
              Default
            </Label>
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        onClick={() =>
          onChange([
            ...rows,
            { key: nextRowKey(), id: "", command: "", cwd: "", isDefault: rows.length === 0 },
          ])
        }
      >
        <PlusIcon aria-hidden />
        Add run script
      </Button>
    </div>
  );
}

function EnvRowsEditor({
  id,
  rows,
  onChange,
}: {
  id: string;
  rows: ReadonlyArray<EnvRow>;
  onChange: (rows: ReadonlyArray<EnvRow>) => void;
}) {
  const patch = (key: number, p: Partial<EnvRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  return (
    <div id={id} className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        Stored as plain text. Put keys and tokens in secrets below.
      </p>
      {rows.map((r, i) => (
        <div key={r.key} className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-center gap-1.5">
          <Input
            aria-label={`Variable ${i + 1} name`}
            placeholder="NODE_ENV"
            value={r.name}
            onChange={(e) => patch(r.key, { name: e.target.value })}
            className="font-mono text-xs"
          />
          <Input
            aria-label={`Variable ${i + 1} value`}
            placeholder="development"
            value={r.value}
            onChange={(e) => patch(r.key, { value: e.target.value })}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove variable ${r.name || i + 1}`}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        onClick={() => onChange([...rows, { key: nextRowKey(), name: "", value: "" }])}
      >
        <PlusIcon aria-hidden />
        Add variable
      </Button>
    </div>
  );
}
