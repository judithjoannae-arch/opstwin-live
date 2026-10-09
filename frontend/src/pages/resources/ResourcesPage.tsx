import { useState } from "react";
import { isApiError } from "../../api/http";
import { resourcesApi } from "../../api/opsApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { Resource, ResourceCreate, StageKey, TicketCategory } from "../../types/operations";
import { CATEGORIES, CATEGORY_LABELS, STAGES, STAGE_LABELS } from "../../utils/format";
import { DataLabel, DemoTag } from "../../components/DataLabel";
import { Dialog, EmptyState, ErrorNotice, Loading, Notice, PageHeader } from "../../components/ui";

const REASONS = ["Sick leave", "Annual leave", "Training", "Off shift", "Reassigned temporarily", "Other"];

interface EditorState {
  mode: "create" | "edit";
  resource: Resource | null;
  form: ResourceCreate;
}

function emptyForm(stage: StageKey): ResourceCreate {
  return { name: "", stage, skills: [], shift_start: "08:00", shift_end: "16:00", is_reserve: false };
}

export default function ResourcesPage() {
  const { can, scopeFor } = useAuth();
  const [stageFilter, setStageFilter] = useState("");
  const [availability, setAvailability] = useState("");
  const staff = useResource(
    (signal) =>
      resourcesApi.list(
        { stage: stageFilter || undefined, available: availability === "" ? undefined : availability === "available" },
        signal,
      ),
    [stageFilter, availability],
  );

  const manageScope = scopeFor(P.RESOURCES_MANAGE);
  const manageableStages = STAGES.filter((s) => manageScope === "all" || manageScope.includes(s));
  const canManage = (stage: StageKey) => can(P.RESOURCES_MANAGE, { departmentId: stage });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailableFor, setUnavailableFor] = useState<Resource | null>(null);
  const [reason, setReason] = useState(REASONS[0]);
  const [reasonDetail, setReasonDetail] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);

  const run = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setNotice(message);
      staff.reload();
      return true;
    } catch (e) {
      setError(
        isApiError(e) && e.status === 409
          ? new Error("This staff record changed since you loaded it. The list has been refreshed; try again.")
          : e,
      );
      staff.reload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const markUnavailable = async () => {
    if (!unavailableFor) return;
    const text = reasonDetail.trim() ? `${reason}: ${reasonDetail.trim()}` : reason;
    const ok = await run(
      () => resourcesApi.update(unavailableFor.id, { version: unavailableFor.version, is_available: false, availability_reason: text }),
      `${unavailableFor.name} is marked unavailable. New twin snapshots will exclude them.`,
    );
    if (ok) {
      setUnavailableFor(null);
      setReasonDetail("");
    }
  };

  const markAvailable = (r: Resource) =>
    void run(
      () => resourcesApi.update(r.id, { version: r.version, is_available: true, availability_reason: null }),
      `${r.name} is available again.`,
    );

  const saveEditor = async () => {
    if (!editor) return;
    const f = editor.form;
    const body = { ...f, name: f.name.trim() };
    const ok =
      editor.mode === "create"
        ? await run(() => resourcesApi.create(body), `Added ${body.name}.`)
        : await run(() => resourcesApi.update(editor.resource!.id, { version: editor.resource!.version, ...body }), `Saved ${body.name}.`);
    if (ok) setEditor(null);
  };

  const toggleSkill = (skill: TicketCategory) =>
    setEditor((e) =>
      e
        ? {
            ...e,
            form: {
              ...e.form,
              skills: e.form.skills.includes(skill) ? e.form.skills.filter((s) => s !== skill) : [...e.form.skills, skill],
            },
          }
        : e,
    );

  const rows = staff.data ?? [];
  const editorValid =
    !!editor && editor.form.name.trim().length >= 2 && editor.form.skills.length > 0;

  return (
    <div className="ot-page">
      <PageHeader
        title="Resources and staffing"
        description="Real staff records. Availability changes take effect immediately and are picked up by the next twin snapshot. Hypothetical staffing belongs in the scenario builder, not here."
        actions={
          manageableStages.length > 0 && (
            <button
              type="button"
              className="ot-btn ot-btn-primary"
              onClick={() => setEditor({ mode: "create", resource: null, form: emptyForm(manageableStages[0]) })}
            >
              Add staff member
            </button>
          )
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      <ErrorNotice error={error} />

      <div className="ot-toolbar">
        <label className="ot-field ot-field-inline">
          <span>Stage</span>
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field ot-field-inline">
          <span>Availability</span>
          <select value={availability} onChange={(e) => setAvailability(e.target.value)}>
            <option value="">Everyone</option>
            <option value="available">Available</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </label>
        <span className="pb-2">
          <DataLabel origin="observed" />
        </span>
      </div>

      {staff.loading && !staff.data ? (
        <Loading label="Loading staff" />
      ) : staff.error ? (
        <ErrorNotice error={staff.error} onRetry={staff.reload} />
      ) : rows.length === 0 ? (
        <EmptyState title="No staff match these filters">Clear a filter, or add a staff member.</EmptyState>
      ) : (
        <div className="ot-table-wrap">
          <table className="ot-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Stage</th>
                <th scope="col">Skills</th>
                <th scope="col">Shift</th>
                <th scope="col">Active tickets</th>
                <th scope="col">Availability</th>
                <th scope="col">
                  <span className="ot-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">
                    <strong>{r.name}</strong>
                    {r.is_reserve && <span className="ot-tag">{r.reserve_active ? "Reserve, active" : "Reserve"}</span>}
                    {r.is_demo && <DemoTag />}
                  </td>
                  <td>{STAGE_LABELS[r.stage]}</td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {r.skills.map((s) => (
                        <span key={s} className="rounded border border-line px-1.5 text-xs text-muted">
                          {CATEGORY_LABELS[s]}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="whitespace-nowrap tabular-nums">
                    {r.shift_start === r.shift_end ? "On call" : `${r.shift_start}–${r.shift_end}`}
                    {r.shift_end < r.shift_start && <span className="block text-xs text-muted">overnight</span>}
                  </td>
                  <td className="tabular-nums">{r.active_ticket_count}</td>
                  <td>
                    {r.is_available ? (
                      <span className="text-ok">Available</span>
                    ) : (
                      <span className="text-warn">
                        Unavailable
                        {r.availability_reason && <span className="block text-xs text-muted">{r.availability_reason}</span>}
                      </span>
                    )}
                  </td>
                  <td className="ot-cell-actions">
                    {canManage(r.stage) && (
                      <>
                        {r.is_available ? (
                          <button type="button" className="ot-btn ot-btn-quiet" disabled={busy} onClick={() => setUnavailableFor(r)}>
                            Mark unavailable
                          </button>
                        ) : (
                          <button type="button" className="ot-btn ot-btn-quiet" disabled={busy} onClick={() => markAvailable(r)}>
                            Mark available
                          </button>
                        )}
                        <button
                          type="button"
                          className="ot-btn ot-btn-quiet"
                          onClick={() =>
                            setEditor({
                              mode: "edit",
                              resource: r,
                              form: {
                                name: r.name,
                                stage: r.stage,
                                skills: [...r.skills],
                                shift_start: r.shift_start,
                                shift_end: r.shift_end,
                                is_reserve: r.is_reserve,
                              },
                            })
                          }
                        >
                          Edit
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={!!unavailableFor}
        title={unavailableFor ? `Mark ${unavailableFor.name} unavailable` : "Mark unavailable"}
        onClose={() => setUnavailableFor(null)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setUnavailableFor(null)}>
              Cancel
            </button>
            <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void markUnavailable()}>
              Mark unavailable
            </button>
          </>
        }
      >
        {unavailableFor && unavailableFor.active_ticket_count > 0 && (
          <Notice tone="warning">
            {unavailableFor.name} has {unavailableFor.active_ticket_count} active ticket
            {unavailableFor.active_ticket_count === 1 ? "" : "s"}. They stay assigned until someone reassigns them.
          </Notice>
        )}
        <label className="ot-field">
          <span>Reason</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>Details (optional)</span>
          <input value={reasonDetail} onChange={(e) => setReasonDetail(e.target.value)} placeholder="Avoid personal or medical details" />
        </label>
      </Dialog>

      <Dialog
        open={!!editor}
        title={editor?.mode === "create" ? "Add staff member" : `Edit ${editor?.resource?.name ?? ""}`}
        onClose={() => setEditor(null)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setEditor(null)}>
              Cancel
            </button>
            <button type="button" className="ot-btn ot-btn-primary" disabled={busy || !editorValid} onClick={() => void saveEditor()}>
              {editor?.mode === "create" ? "Add staff member" : "Save changes"}
            </button>
          </>
        }
      >
        {editor && (
          <>
            <label className="ot-field">
              <span>Name</span>
              <input value={editor.form.name} onChange={(e) => setEditor({ ...editor, form: { ...editor.form, name: e.target.value } })} />
            </label>
            <label className="ot-field">
              <span>Stage</span>
              <select
                value={editor.form.stage}
                onChange={(e) => setEditor({ ...editor, form: { ...editor.form, stage: e.target.value as StageKey } })}
              >
                {manageableStages.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="ot-checklist">
              <legend>Skills (ticket categories they can handle)</legend>
              {CATEGORIES.map((c) => (
                <label key={c} className="ot-check">
                  <input type="checkbox" checked={editor.form.skills.includes(c)} onChange={() => toggleSkill(c)} />
                  <span>{CATEGORY_LABELS[c]}</span>
                </label>
              ))}
            </fieldset>
            <div className="grid grid-cols-2 gap-x-4">
              <label className="ot-field">
                <span>Shift starts</span>
                <input type="time" value={editor.form.shift_start} onChange={(e) => setEditor({ ...editor, form: { ...editor.form, shift_start: e.target.value } })} />
              </label>
              <label className="ot-field">
                <span>Shift ends</span>
                <input type="time" value={editor.form.shift_end} onChange={(e) => setEditor({ ...editor, form: { ...editor.form, shift_end: e.target.value } })} />
              </label>
            </div>
            {editor.form.shift_start === editor.form.shift_end ? (
              <p className="text-sm text-muted">Same start and end means on call around the clock.</p>
            ) : editor.form.shift_end < editor.form.shift_start ? (
              <p className="text-sm text-muted">Overnight shift: ends the next morning.</p>
            ) : null}
            <label className="ot-check border-t-0">
              <input
                type="checkbox"
                checked={editor.form.is_reserve}
                onChange={(e) => setEditor({ ...editor, form: { ...editor.form, is_reserve: e.target.checked } })}
              />
              <span>
                Reserve capacity
                <small>Only activated through an approved operational change.</small>
              </span>
            </label>
          </>
        )}
      </Dialog>
    </div>
  );
}
