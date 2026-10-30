import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CommandFooter } from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

export function PaletteFooter() {
  const { t } = useTranslation();

  return (
    <CommandFooter>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <KbdGroup>
            <Kbd>
              <ArrowUpIcon />
            </Kbd>
            <Kbd>
              <ArrowDownIcon />
            </Kbd>
          </KbdGroup>
          <span>{t("navigation:commandPalette.footer.navigate")}</span>
        </div>
        <div className="flex items-center gap-2">
          <Kbd>
            <CornerDownLeftIcon />
          </Kbd>
          <span>{t("navigation:commandPalette.footer.open")}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Kbd>Esc</Kbd>
        <span>{t("navigation:commandPalette.footer.close")}</span>
      </div>
    </CommandFooter>
  );
}
