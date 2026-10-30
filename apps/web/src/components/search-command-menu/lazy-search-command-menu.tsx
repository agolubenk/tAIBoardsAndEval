import { lazy, Suspense } from "react";
import { useOpenedOnce } from "@/hooks/use-opened-once";

// The search dialog's code is not on the first load: it arrives with the
// first open (R-090).
const SearchCommandMenu = lazy(() => import("./index"));

type LazySearchCommandMenuProps = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

function LazySearchCommandMenu({ open, setOpen }: LazySearchCommandMenuProps) {
  const opened = useOpenedOnce(open);
  if (!opened) return null;

  return (
    <Suspense fallback={null}>
      <SearchCommandMenu open={open} setOpen={setOpen} />
    </Suspense>
  );
}

export default LazySearchCommandMenu;
