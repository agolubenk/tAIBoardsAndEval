import { SendHorizontal } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// Mirrors QUESTION_MAX on the API.
const QUESTION_MAX = 2000;

type AskFormProps = {
  placeholder: string;
  pending: boolean;
  onAsk: (question: string, done: () => void) => void;
};

export function AskForm({ placeholder, pending, onAsk }: AskFormProps) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState("");
  const trimmed = question.trim();

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!trimmed || pending) return;
    onAsk(trimmed, () => setQuestion(""));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Textarea
        aria-label={placeholder}
        value={question}
        maxLength={QUESTION_MAX}
        placeholder={placeholder}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {t("workspace:notebook.chat.shortcut")}
        </p>
        <Button type="submit" size="sm" disabled={!trimmed || pending}>
          <SendHorizontal aria-hidden="true" />
          {t("workspace:notebook.chat.ask")}
        </Button>
      </div>
    </form>
  );
}
