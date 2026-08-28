import type { DocumentBuild } from "./services/document-build";
import type { ResearchReport } from "./services/research-report";
import type { ScheduledEmail } from "./services/scheduled-email";

/** Public infrastructure contract for the Document Build Workflow binding. */
export type DocumentBuildWorkflowPayload = DocumentBuild.WorkflowPayload;

/** Public infrastructure contract for the Research Report Workflow binding. */
export type ResearchReportWorkflowPayload = ResearchReport.WorkflowPayload;

/** Public infrastructure contract for the Scheduled Email Workflow binding. */
export type ScheduledEmailWorkflowPayload = ScheduledEmail.WorkflowPayload;
