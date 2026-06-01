import type { PendingApproval } from "@/stores/hermes/chat";

export const SHOW_APPROVAL_MODAL_EVENT = "SHOW_APPROVAL_MODAL";

export type SecurityLevel = "L1_Passive" | "L2_ReadOnly" | "L3_Sensitive" | "L4_Locked";

export interface ApprovalGatewayEventDetail {
  type: typeof SHOW_APPROVAL_MODAL_EVENT;
  approval: PendingApproval;
  securityLevel: SecurityLevel;
}

const L4_LOCKED_TOOLS = new Set(["terminal", "bash"]);

export function classifyToolCall(toolName: string | undefined | null): SecurityLevel {
  const normalized = String(toolName || "").trim().toLowerCase();
  return L4_LOCKED_TOOLS.has(normalized) ? "L4_Locked" : "L3_Sensitive";
}

export function isL4LockedTool(toolName: string | undefined | null): boolean {
  return classifyToolCall(toolName) === "L4_Locked";
}

export function dispatchApprovalModalEvent(approval: PendingApproval): void {
  if (typeof window === "undefined") return;

  const securityLevel = approval.securityLevel || classifyToolCall(approval.tool);
  if (securityLevel !== "L4_Locked") return;

  window.dispatchEvent(new CustomEvent<ApprovalGatewayEventDetail>(SHOW_APPROVAL_MODAL_EVENT, {
    detail: {
      type: SHOW_APPROVAL_MODAL_EVENT,
      approval,
      securityLevel,
    },
  }));
}
