import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";

// The question being answered: search plus the model can take up to a minute.
export function PendingQuestion({ question }: { question: string }) {
  const { t } = useTranslation();

  return (
    <>
      <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-secondary px-3 py-2 text-sm opacity-70">
        {question}
      </p>
      <p
        role="status"
        className="flex items-center gap-2 text-muted-foreground text-sm"
      >
        <Spinner className="size-4" />
        {t("workspace:notebook.chat.asking")}
      </p>
    </>
  );
}
