import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { changeRequestsApi } from "../api/rbacApi";
import { useAuth } from "../auth/AuthContext";
import { P } from "../auth/permissions";
import { Dialog, ErrorNotice } from "./ui";

/**
 * Drop into an existing recommendation view. Turns a recommendation into a
 * change request; it never changes live configuration itself. The backend
 * derives the config diff, affected departments and source versions from the
 * recommendation, and refuses if the user lacks changes.request for any of them.
 */
export default function RequestChangeButton({
  recommendationId,
  affectedDepartmentIds,
}: {
  recommendationId: string;
  affectedDepartmentIds: string[];
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!can(P.CHANGES_REQUEST, { departmentIds: affectedDepartmentIds })) return null;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = await changeRequestsApi.createFromRecommendation(recommendationId, reason.trim());
      setOpen(false);
      navigate(`/approvals?tab=mine&id=${encodeURIComponent(created.id)}`);
    } catch (e) {
      setError(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button type="button" className="ot-btn ot-btn-primary" onClick={() => setOpen(true)}>
        Request this change
      </button>
      <Dialog
        open={open}
        title="Request this change"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="ot-btn ot-btn-primary"
              disabled={submitting || reason.trim().length < 10}
              onClick={() => void submit()}
            >
              {submitting ? "Sending request…" : "Send for approval"}
            </button>
          </>
        }
      >
        <p>
          Nothing changes in live operations until an approver signs off and the change is applied. The request records the
          simulation and configuration version it came from.
        </p>
        <label className="ot-field">
          <span>Why this change is needed</span>
          <textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required />
          <small>At least 10 characters. Approvers see this.</small>
        </label>
        <ErrorNotice error={error} />
      </Dialog>
    </>
  );
}
