import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type MetaTextFieldProps = {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  inputMode?: "numeric" | "decimal";
};

export function MetaTextField({
  id,
  label,
  hint,
  value,
  onChange,
  multiline = false,
  disabled = false,
  invalid = false,
  inputMode,
}: MetaTextFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium text-xs">
        {label}
      </label>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          inputMode={inputMode}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
