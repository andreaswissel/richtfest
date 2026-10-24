ALTER TABLE "support_reports"
  DROP CONSTRAINT "support_reports_kind_check",
  ADD CONSTRAINT "support_reports_kind_check" CHECK ("kind" IN ('bug', 'feature', 'feedback'));
