import type { TFunction } from "i18next";
import { z } from "zod";

const DAILY_MAX_LIMIT = 100_000;

export function createModelFormSchema(t: TFunction) {
  return z.object({
    baseUrl: z
      .string()
      .trim()
      .max(500)
      .refine((value) => value === "" || URL.canParse(value), {
        message: t("settings:adminNotebookModel.validation.baseUrl"),
      }),
    model: z.string().trim().max(200),
    embedModel: z.string().trim().max(200),
    dailyMax: z
      .string()
      .trim()
      .refine(
        (value) =>
          value === "" ||
          (/^\d+$/.test(value) && Number(value) <= DAILY_MAX_LIMIT),
        {
          message: t("settings:adminNotebookModel.validation.dailyMax", {
            max: DAILY_MAX_LIMIT,
          }),
        },
      ),
  });
}
