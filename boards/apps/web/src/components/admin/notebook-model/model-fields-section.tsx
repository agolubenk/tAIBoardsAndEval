import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useIsMutating } from "@tanstack/react-query";
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
import useUpdateNotebookModel, {
  NOTEBOOK_MODEL_MUTATION_KEY,
} from "@/hooks/mutations/admin/use-update-notebook-model";
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
  const saving =
    useIsMutating({ mutationKey: NOTEBOOK_MODEL_MUTATION_KEY }) > 0;
  const form = useForm<ModelFormValues>({
    resolver: standardSchemaResolver(schema),
    defaultValues: current,
  });
  const { isDirty } = form.formState;

  // A save of the key section must not wipe fields being edited here.
  useEffect(() => {
    if (!isDirty) form.reset(current);
  }, [form, current, isDirty]);

  const onSubmit = (values: ModelFormValues) => {
    const patch = toModelPatch(values, current);
    if (Object.keys(patch).length === 0) return;
    mutate(patch, {
      onSuccess: (saved) => form.reset(toModelFormValues(saved)),
    });
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
                      disabled={saving}
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
              disabled={!isDirty || saving}
            >
              {t("settings:adminNotebookModel.fields.save")}
            </Button>
          </div>
        </form>
      </Form>
    </SettingsSection>
  );
}
