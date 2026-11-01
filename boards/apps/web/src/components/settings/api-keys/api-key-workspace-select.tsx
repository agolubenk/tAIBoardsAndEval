import { useTranslation } from "react-i18next";
import { ALL_WORKSPACES } from "@/components/settings/api-keys/api-key-workspace";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import useGetWorkspaces from "@/hooks/queries/workspace/use-get-workspaces";

type ApiKeyWorkspaceSelectProps = {
  value: string;
  onChange: (value: string) => void;
  labelledBy: string;
  disabled?: boolean;
};

export function ApiKeyWorkspaceSelect({
  value,
  onChange,
  labelledBy,
  disabled,
}: ApiKeyWorkspaceSelectProps) {
  const { t } = useTranslation();
  const { data: workspaces } = useGetWorkspaces();
  const allLabel = t("settings:apiKey.createDialog.workspaceAll");
  const selectedName =
    value === ALL_WORKSPACES
      ? allLabel
      : (workspaces?.find((workspace) => workspace.id === value)?.name ?? null);

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-labelledby={labelledBy}>
        <SelectValue>{selectedName}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_WORKSPACES}>{allLabel}</SelectItem>
        {workspaces?.map((workspace) => (
          <SelectItem key={workspace.id} value={workspace.id}>
            {workspace.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
