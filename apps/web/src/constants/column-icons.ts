import {
  Archive,
  BadgeCheck,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Flame,
  Inbox,
  Search,
} from "lucide-react";
import projectIcons from "./project-icons";

export const DEFAULT_COLUMN_ICON_NAMES = {
  new: "Inbox",
  grilling: "Flame",
  "to-do": "Circle",
  "in-progress": "CircleDot",
  "in-review": "Search",
  confirmation: "BadgeCheck",
  done: "CheckCircle2",
  closed: "CircleSlash",
  archived: "Archive",
  planned: "CircleDashed",
} as const;

const columnIcons = {
  ...projectIcons,
  Circle,
  CircleDot,
  Search,
  CheckCircle2,
  CircleDashed,
  Archive,
  Inbox,
  Flame,
  BadgeCheck,
  CircleSlash,
};

export type ColumnIconName = keyof typeof columnIcons;

export default columnIcons;
