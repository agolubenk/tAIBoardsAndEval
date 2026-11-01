import type getCardContext from "@/fetchers/forest/get-card-context";

export type CardContext = Awaited<ReturnType<typeof getCardContext>>;
export type CardMeta = CardContext["meta"];
export type CardApproval = CardContext["approvals"][number];
export type CardLease = NonNullable<CardContext["lease"]>;
