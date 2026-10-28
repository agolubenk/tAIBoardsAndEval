import { Bot, Clock, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { PropertyRow } from "../properties/property-row";
import { CardValue } from "./card-value";
import type { CardLease } from "./card-types";

// Who holds the card right now (R-026): an agent at work, or nobody.
export function CardLeaseRows({ lease }: { lease: CardLease | null }) {
  const { t } = useTranslation();

  if (!lease) {
    return (
      <p className="px-2 py-1 text-muted-foreground text-xs">
        {t("tasks:card.lease.free")}
      </p>
    );
  }

  const isAgent = lease.holderKind === "agent";
  return (
    <>
      <PropertyRow label={t("tasks:card.lease.holder")}>
        <CardValue>
          {isAgent ? <Bot aria-hidden="true" /> : <User aria-hidden="true" />}
          <span className="truncate">{lease.holderName}</span>
          <span className="shrink-0 font-normal text-muted-foreground text-xs">
            {isAgent
              ? t("tasks:card.actor.agent")
              : t("tasks:card.actor.person")}
          </span>
        </CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.lease.until")}>
        <CardValue>
          <Clock aria-hidden="true" className="text-muted-foreground" />
          <span title={formatDateTime(lease.expiresAt)}>
            {formatRelativeTime(lease.expiresAt)}
          </span>
        </CardValue>
      </PropertyRow>
    </>
  );
}
