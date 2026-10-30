import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

export type UserRoleKind = "admin" | "agent" | "user";

type UserRoleBadgeProps = {
  kind: UserRoleKind;
};

export function UserRoleBadge({ kind }: UserRoleBadgeProps) {
  const { t } = useTranslation();

  return kind === "user" ? (
    <Badge variant="secondary" className="px-1.5 text-muted-foreground">
      {t("settings:adminUsers.roles.user")}
    </Badge>
  ) : (
    <Badge variant="outline" className="px-1.5">
      {t(`settings:adminUsers.roles.${kind}`)}
    </Badge>
  );
}
