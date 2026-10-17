import type { DocumentType } from "@richtfest/shared";
import type { useT } from "../../i18n";
import type { InquiryDirection, InquiryEntryKind, InquiryStatus } from "./types";

type T = ReturnType<typeof useT>;

export const inquiryStatusLabel = (status: InquiryStatus, t: T) => t(({ open: "inquiryStatusOpen", waiting: "inquiryStatusWaiting", answered: "inquiryStatusAnswered", closed: "inquiryStatusClosed" } as const)[status]);
export const inquiryEntryKindLabel = (kind: InquiryEntryKind, t: T) => t(({ request: "inquiryEntryRequest", email: "inquiryEntryEmail", call: "inquiryEntryCall", note: "inquiryEntryNote", document: "inquiryEntryDocument" } as const)[kind]);
export const inquiryDirectionLabel = (direction: InquiryDirection, t: T) => t(({ incoming: "inquiryDirectionIncoming", outgoing: "inquiryDirectionOutgoing", internal: "inquiryDirectionInternal" } as const)[direction]);

export const documentTypes: DocumentType[] = ["plans", "construction_description", "development_plan", "acoustic_report", "fire_safety_concept", "noise_data", "permit", "correspondence", "other"];
export const documentTypeLabel = (type: DocumentType, t: T) => t(({
  plans: "documentTypePlans", construction_description: "documentTypeConstructionDescription", development_plan: "documentTypeDevelopmentPlan",
  acoustic_report: "documentTypeAcousticReport", fire_safety_concept: "documentTypeFireSafetyConcept", noise_data: "documentTypeNoiseData",
  permit: "documentTypePermit", correspondence: "documentTypeCorrespondence", other: "documentTypeOther",
} as const)[type]);
