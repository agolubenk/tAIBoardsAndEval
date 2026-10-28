import { useTranslation } from "react-i18next";
import type { NotebookMessage } from "./notebook-types";

type AnswerNoteProps = {
  status: NotebookMessage["status"];
  hasSources: boolean;
};

// Why an answer came without written text. The sources below it are still
// the answer the reader can use.
export function AnswerNote({ status, hasSources }: AnswerNoteProps) {
  const { t } = useTranslation();
  const key = hasSources ? (status ?? "failed") : "nothingFound";

  return (
    <p className="text-muted-foreground text-sm">
      {t(`workspace:notebook.chat.answerStatus.${key}`)}
    </p>
  );
}
