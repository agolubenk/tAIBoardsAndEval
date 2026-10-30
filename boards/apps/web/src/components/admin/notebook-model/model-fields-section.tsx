import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsFormRow } from "@/components/settings/settings-form-row";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Form, FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { NotebookModelSettings } from "@/fetchers/admin/get-notebook-model";
import useUpdateNotebookModel from "@/hooks/mutations/admin/use-update-notebook-model";
import { createModelFormSchema } from "./create-model-form-schema";
import {
  type ModelFormValues,
  toModelFormValues,
  toModelPatch,
} from "./model-form-values";

const FIELDS = [
  { name: "baseUrl", inputMode: "url" },
  { name: "model", inputMode: "text" },
  { name: "embedModel", inputMode: "text" },
  { name: "dailyMax", inputMode: "numeric" },
] as const;

export function ModelFieldsSection({
  settings,
}: {
  settings: NotebookModelSettings;
}) {
  const { t } = useTranslation();
  const schema = useMemo(() => createModelFormSchema(t), [t]);
  const current = useMemo(() => toModelFormValues(settings), [settings]);
  const { mutate, isPending } = useUpdateNotebookModel();
  const form = useForm<ModelFormValues>({
    resolver: standardSchemaResolver(schema),
    defaultValues: current,
  });

  useEffect(() => form.reset(current), [form, current]);

  const onSubmit = (values: ModelFormValues) => {
    const patch = toModelPatch(values, current);
    if (Object.keys(patch).length > 0) mutate(patch);
  };

  return (
    <SettingsSection
      title={t("settings:adminNotebookModel.fields.title")}
      description={t("settings:adminNotebookModel.fields.description")}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
          <SettingsCard>
            {FIELDS.map(({ name, inputMode }) => (
              <FormField
                key={name}
                control={form.control}
                name={name}
                render={({ field }) => (
                  <SettingsFormRow
                    label={t(
                      `settings:adminNotebookModel.fields.${name}.label`,
                    )}
                    description={t(
                      `settings:adminNotebookModel.fields.${name}.hint`,
                    )}
                  >
                    <Input
                      size="sm"
                      className="sm:w-64"
                      inputMode={inputMode}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={isPending}
                      {...field}
                    />
                  </SettingsFormRow>
                )}
              />
            ))}
          </SettingsCard>
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              loading={isPending}
              disabled={!form.formState.isDirty}
            >
              {t("settings:adminNotebookModel.fields.save")}
            </Button>
          </div>
        </form>
      </Form>
    </SettingsSection>
  );
}
