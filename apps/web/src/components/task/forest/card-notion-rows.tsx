import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { PropertyRow } from "../properties/property-row";
import { CardLongText } from "./card-long-text";
import type { CardMeta } from "./card-types";
import { CardValue } from "./card-value";

const notionUrl = (pageId: string) =>
  `https://www.notion.so/${pageId.replace(/-/g, "")}`;

// The fields the Notion boards keep (R-024).
export function CardNotionRows({ meta }: { meta: CardMeta }) {
  const { t } = useTranslation();

  return (
    <>
      <PropertyRow label={t("tasks:card.fields.kind")}>
        <CardValue>
          <Badge variant={meta.kind === "bug" ? "error" : "secondary"}>
            {meta.kind === "bug"
              ? t("tasks:card.kind.bug")
              : t("tasks:card.kind.task")}
          </Badge>
        </CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.halfBaked")}>
        <CardValue>
          {meta.halfBaked ? (
            <Badge variant="warning">{t("tasks:card.halfBaked.yes")}</Badge>
          ) : (
            <span className="text-muted-foreground">
              {t("tasks:card.halfBaked.no")}
            </span>
          )}
        </CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.severity")}>
        <CardValue>{meta.severity}</CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.backlogId")}>
        <CardValue className="font-mono text-xs">{meta.backlogId}</CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.notion")}>
        <CardValue>
          {meta.notionPageId ? (
            <a
              href={notionUrl(meta.notionPageId)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center gap-1.5 hover:underline"
            >
              <span className="truncate">
                {meta.notionStatus || t("tasks:card.notion.open")}
              </span>
              <ExternalLink
                aria-hidden="true"
                className="text-muted-foreground"
              />
            </a>
          ) : (
            meta.notionStatus
          )}
        </CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.report")} align="start">
        {meta.report ? <CardLongText text={meta.report} /> : <CardValue />}
      </PropertyRow>
    </>
  );
}
