import {
  BadgeCheck,
  Check,
  Circle,
  CircleDot,
  CircleSlash,
  Flame,
  Inbox,
  Rocket,
  ScanSearch,
  Search,
  Wrench,
} from "lucide-react";

// The boards' processes, tasks then the bug-only columns; the API creates the
// same columns (project-processes.ts). A column still under its default name
// shows the translated status label.
export const DEFAULT_COLUMNS = [
  { id: "new", name: "New", icon: Inbox },
  { id: "grilling", name: "Grilling", icon: Flame },
  { id: "to-do", name: "To Do", icon: Circle },
  { id: "in-progress", name: "In Progress", icon: CircleDot },
  { id: "in-review", name: "In Review", icon: Search },
  { id: "confirmation", name: "Confirmation", icon: BadgeCheck },
  { id: "done", name: "Done", icon: Check },
  { id: "closed", name: "Closed", icon: CircleSlash },
  { id: "triage", name: "Triage", icon: ScanSearch },
  { id: "prod-check", name: "Prod Check", icon: Rocket },
  { id: "fixed", name: "Fixed", icon: Wrench },
] as const;
