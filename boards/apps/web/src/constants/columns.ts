import {
  BadgeCheck,
  Check,
  Circle,
  CircleDot,
  CircleSlash,
  Flame,
  Inbox,
  Search,
} from "lucide-react";

// The board's process; the API creates the same columns (project-processes.ts).
// A column still under its default name shows the translated status label.
export const DEFAULT_COLUMNS = [
  { id: "new", name: "New", icon: Inbox },
  { id: "grilling", name: "Grilling", icon: Flame },
  { id: "to-do", name: "To Do", icon: Circle },
  { id: "in-progress", name: "In Progress", icon: CircleDot },
  { id: "in-review", name: "In Review", icon: Search },
  { id: "confirmation", name: "Confirmation", icon: BadgeCheck },
  { id: "done", name: "Done", icon: Check },
  { id: "closed", name: "Closed", icon: CircleSlash },
] as const;
