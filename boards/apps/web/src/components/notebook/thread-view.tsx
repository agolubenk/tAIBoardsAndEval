import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ForestListState } from "@/components/forest/forest-list-state";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { Button } from "@/components/ui/button";
import useDeleteNotebookThread from "@/hooks/mutations/notebook/use-delete-notebook-thread";
import useNotebookThread from "@/hooks/queries/notebook/use-notebook-thread";
import { MessageItem } from "./message-item";
import { PendingQuestion } from "./pending-question";

type ThreadViewProps = {
  workspaceId: string;
  threadId: string;
  pendingQuestion?: string;
  canDelete: boolean;
  onDeleted: () => void;
};

export function ThreadView({
  workspaceId,
  threadId,
  pendingQuestion,
  canDelete,
  onDeleted,
}: ThreadViewProps) {
  const { t } = useTranslation();
  const thread = useNotebookThread(workspaceId, threadId);
  const remove = useDeleteNotebookThread(workspaceId);
  const [confirming, setConfirming] = useState(false);
  const data = thread.data;

  return (
    <ForestListState
      isLoading={thread.isLoading}
      isError={thread.isError}
      isEmpty={false}
      empty=""
    >
      {data ? (
        <section className="flex flex-col gap-3">
          <header className="flex items-start justify-between gap-2">
            <h2 className="font-medium text-base">{data.thread.title}</h2>
            {canDelete ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("workspace:notebook.chat.delete")}
                onClick={() => setConfirming(true)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            ) : null}
          </header>
          {data.messages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
          {pendingQuestion ? (
            <PendingQuestion question={pendingQuestion} />
          ) : null}
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t("workspace:notebook.chat.deleteTitle")}
            description={t("workspace:notebook.chat.deleteDescription")}
            confirmLabel={t("workspace:notebook.chat.delete")}
            pending={remove.isPending}
            onConfirm={() =>
              remove.mutate(threadId, {
                onSuccess: () => {
                  setConfirming(false);
                  onDeleted();
                },
              })
            }
          />
        </section>
      ) : null}
    </ForestListState>
  );
}
