export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type ImportedPriority =
  | "no-priority"
  | "low"
  | "medium"
  | "high"
  | "urgent";

export type ImportedColumn = {
  key: string;
  name: string;
  isFinal: boolean;
};

export type ImportedLabel = {
  key: string;
  name: string;
  color: string;
};

export type ImportedPerson = {
  name?: string;
  email?: string;
};

export type ImportedComment = {
  author: ImportedPerson;
  body: string;
  createdAt?: string;
};

export type ImportedTask = {
  key: string;
  number?: number;
  columnKey: string | null;
  archived?: boolean;
  title: string;
  description: string;
  priority: ImportedPriority;
  startDate?: string;
  dueDate?: string;
  createdAt?: string;
  assignee?: ImportedPerson;
  labelKeys: string[];
  comments: ImportedComment[];
  // Where the task came from, for sources that are mirrored rather than
  // imported once (Notion, R-080): the writer upserts by `lastEditedTime`.
  sourceRef?: ImportedSourceRef;
  // Source fields with no kaneo column, kept verbatim (R-024).
  extraFields?: Record<string, string | number | boolean | null>;
  // Why an archived task left the board in the source, when it says so.
  terminalReason?: string;
};

export type ImportedSourceRef = {
  system: "notion";
  pageId: string;
  lastEditedTime: string;
};

export type ImportedRelationType = "subtask" | "blocks" | "related";

export type ImportedRelation = {
  sourceKey: string;
  targetKey: string;
  type: ImportedRelationType;
};

export type ImportedProject = {
  name: string;
  key?: string;
  description?: string;
  columns: ImportedColumn[];
  labels: ImportedLabel[];
  tasks: ImportedTask[];
  relations: ImportedRelation[];
  warnings: string[];
};

export type SourceProject = {
  id: string;
  name: string;
  detail?: string;
};

export type ReadProjectOptions = {
  includeComments: boolean;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
};

export type ImportSource = {
  listProjects(): Promise<SourceProject[]>;
  readProject(
    projectId: string,
    options: ReadProjectOptions,
  ): Promise<ImportedProject>;
};

export type ConnectOptions = {
  fetch?: FetchLike;
  signal?: AbortSignal;
};
