import { GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PropertyRow } from "../properties/property-row";
import { CardLinkList } from "./card-link-list";
import { CardLongText } from "./card-long-text";
import type { CardMeta } from "./card-types";
import { CardValue } from "./card-value";
import { hasAgentReport } from "./has-agent-report";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

// What the agent reports about its work on the card (R-024).
export function CardAgentRows({ meta }: { meta: CardMeta }) {
  const { t, i18n } = useTranslation();

  if (!hasAgentReport(meta)) {
    return (
      <p className="px-2 py-1 text-muted-foreground text-xs">
        {t("tasks:card.agent.empty")}
      </p>
    );
  }

  return (
    <>
      <PropertyRow label={t("tasks:card.fields.executor")}>
        <CardValue>{meta.executor}</CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.branch")}>
        <CardValue>
          {meta.branch ? (
            <>
              <GitBranch aria-hidden="true" className="text-muted-foreground" />
              <span className="truncate font-mono text-xs" title={meta.branch}>
                {meta.branch}
              </span>
            </>
          ) : null}
        </CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.pullRequests")} align="start">
        {meta.pullRequests.length ? (
          <CardLinkList items={meta.pullRequests} />
        ) : (
          <CardValue />
        )}
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.files")} align="start">
        {meta.files.length ? (
          <CardLinkList items={meta.files} />
        ) : (
          <CardValue />
        )}
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.tokens")}>
        <CardValue className="tabular-nums">
          {meta.tokens === null
            ? null
            : new Intl.NumberFormat(i18n.language).format(meta.tokens)}
        </CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.cost")}>
        <CardValue className="tabular-nums">
          {meta.costUsd === null ? null : usd.format(meta.costUsd)}
        </CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.fields.contextPack")} align="start">
        {meta.contextPack ? (
          <CardLongText text={meta.contextPack} />
        ) : (
          <CardValue />
        )}
      </PropertyRow>
    </>
  );
}
