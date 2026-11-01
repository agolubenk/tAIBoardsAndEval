import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ChatTab } from "./chat-tab";
import { NotebookStatusBar } from "./notebook-status-bar";
import {
  isNotebookTab,
  NOTEBOOK_TABS,
  type NotebookTab,
} from "./notebook-types";
import { SearchTab } from "./search-tab";
import { SourcesTab } from "./sources-tab";
import { EvolutionTab } from "../ssr/evolution-tab";
import { RegistryTab } from "../ssr/registry-tab";

type NotebookPageProps = {
  workspaceId: string;
  tab: NotebookTab;
  threadId?: string;
  onTabChange: (tab: NotebookTab) => void;
  onThreadChange: (threadId: string | undefined) => void;
};

// The team notebook (R-050–R-053): questions with cited answers, plain search
// and the synced sources of a workspace.
export function NotebookPage({
  workspaceId,
  tab,
  threadId,
  onTabChange,
  onThreadChange,
}: NotebookPageProps) {
  const { t } = useTranslation();

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isNotebookTab(value)) onTabChange(value);
      }}
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6"
    >
      <NotebookStatusBar workspaceId={workspaceId} />
      <div className="overflow-x-auto">
        <TabsList variant="underline">
          {NOTEBOOK_TABS.map((item) => (
            <TabsTab key={item} value={item}>
              {t(`workspace:notebook.tabs.${item}`)}
            </TabsTab>
          ))}
        </TabsList>
      </div>
      <TabsPanel value="evolution">
        <EvolutionTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="registry">
        <RegistryTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="chat">
        <ChatTab
          workspaceId={workspaceId}
          threadId={threadId}
          onThreadChange={onThreadChange}
        />
      </TabsPanel>
      <TabsPanel value="search">
        <SearchTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="sources">
        <SourcesTab workspaceId={workspaceId} />
      </TabsPanel>
    </Tabs>
  );
}
