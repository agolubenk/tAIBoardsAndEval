import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ApiErrorIssue = { path: string; message: string };

export type ApiErrorBody = {
  message: string;
  code: string;
  issues?: ApiErrorIssue[];
  missingPermissions?: string[];
  target?: string;
};

export class ApiError extends HTTPException {
  readonly code: string;
  readonly issues?: ApiErrorIssue[];
  readonly missingPermissions?: string[];
  readonly target?: string;

  constructor(status: ContentfulStatusCode, body: ApiErrorBody) {
    super(status, { message: body.message });
    this.code = body.code;
    this.issues = body.issues;
    this.missingPermissions = body.missingPermissions;
    this.target = body.target;
  }
}
