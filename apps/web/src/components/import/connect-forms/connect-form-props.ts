import type { ImportConnectValues } from "@/components/import/connect-values";

export type ConnectFormProps = {
  values: ImportConnectValues;
  onChange: (patch: Partial<ImportConnectValues>) => void;
  error: string | null;
  // The API's code for `error`, when a form can place it better than the first field.
  errorCode?: string | null;
  // The entry the API refused, such as one database ID among several.
  errorTarget?: string | null;
  trelloAuthorizeUrl: string | null;
};
