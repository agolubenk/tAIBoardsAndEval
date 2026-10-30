import { useState } from "react";

// A lazily loaded dialog mounts on its first open and then stays mounted, so
// closing it keeps the dialog's own focus return instead of tearing it down.
export function useOpenedOnce(open: boolean) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened;
}
