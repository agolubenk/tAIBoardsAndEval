import { useState } from "react";

// A dialog opened by its parent's `open` prop never gets `onOpenChange(true)`,
// so the form resets here, during render, when `open` turns true.
export function useResetOnOpen(open: boolean, reset: () => void) {
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) reset();
  }
}
