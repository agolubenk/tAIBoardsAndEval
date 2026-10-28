import type { SourceLogoProps } from "@/components/import/source-logos/source-logo-size";
import { cn } from "@/lib/cn";

export function NotionLogo({ size }: SourceLogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn("text-foreground", size === "sm" ? "size-4" : "size-5")}
    >
      <rect
        x="3"
        y="2.5"
        width="18"
        height="19"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8.5 17V7.5h1.2l5 7.2V7.5h1.3V17h-1.2l-5-7.2V17Z"
        fill="currentColor"
      />
    </svg>
  );
}
