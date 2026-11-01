// Everything a felling reads about one tree, gathered before the tasks go.
export type FelledTask = {
  id: string;
  projectId: string;
  number: number | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  userId: string | null;
  columnId: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  revision: number;
};

export type FelledActivity = {
  taskId: string;
  type: string;
  content: string | null;
  userId: string | null;
  createdAt: Date;
  eventData: unknown;
};

export type SubtaskEdge = { parentId: string; childId: string };

// A blocks/related link that leaves the felled set; it ends up in a seed.
export type OuterLink = {
  felledTaskId: string;
  otherTaskId: string;
  otherTitle: string;
  relationType: string;
  direction: "out" | "in";
};

export type TreeMaterial = {
  root: FelledTask;
  projectName: string;
  tasks: FelledTask[];
  edges: SubtaskEdge[];
  activities: FelledActivity[];
  labels: { taskId: string; name: string }[];
  assets: { taskId: string; name: string }[];
  outerLinks: OuterLink[];
};
