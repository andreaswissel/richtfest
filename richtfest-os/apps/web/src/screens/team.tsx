import { DeliveryStatus } from "./auth";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, list, type RecordData } from "../api";
import { queryClient, useApi, useWrite } from "../query";
import { useT } from "../i18n";
import { Page, PageHeader, Section } from "../components/layout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import {
  Badge,
  Callout,
  Empty,
  Field,
  Form,
  Modal,
  Table,
} from "../components/ui/primitives";
import { LoadState } from "./foundation";

export function Team() {
  const t = useT();
  const query = useApi("/access/team");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const outboxAllowed =
    query.data?.canManageTeam === true &&
    query.data?.devOutboxAvailable === true;
  const outbox = useApi("/access/dev-outbox", outboxAllowed && outboxOpen);
  const [member, setMember] = useState<RecordData | null>(null);
  const [offboard, setOffboard] = useState<RecordData | null>(null);
  const [cancelInvite, setCancelInvite] = useState<RecordData | null>(null);
  const offboarding = useWrite(
    `/access/members/${offboard?.userId || offboard?.id}/offboard`,
    () => setOffboard(null),
  );
  const cancelling = useWrite(
    `/access/invitations/${cancelInvite?.id}/cancel`,
    () => setCancelInvite(null),
  );
  const canManage = query.data?.canManageTeam === true;
  const roles = list(query.data?.roles);
  const invite = useWrite("/access/invitations", (data) => {
    setInviteOpen(false);
  });
  const updateMember = useMutation({
    mutationFn: (body: unknown) =>
      api(`/access/members/${member?.userId || member?.id}`, body, "PATCH"),
    onSuccess: () => {
      setMember(null);
      void queryClient.invalidateQueries({ queryKey: ["/access/team"] });
    },
  });
  return (
    <Page>
      <PageHeader
        title={t("team")}
        description={t("accessNote")}
        actions={
          canManage ? (
            <Button variant="default" onClick={() => setInviteOpen(true)}>
              ＋ {t("createInvitation")}
            </Button>
          ) : undefined
        }
      />
      <LoadState query={query} />
      {invite.isSuccess && (
        <DeliveryStatus
          status={
            invite.data?.deliveryStatus ||
            invite.data?.delivery?.status ||
            invite.data?.delivery?.mode
          }
        />
      )}
      {query.data && (
        <>
          <Section title={t("members")}>
            <Table
              headers={[
                t("name"),
                t("email"),
                t("role"),
                ...(canManage ? [t("manageMember")] : []),
              ]}
              rows={list(query.data.members).map((m) => ({
                id: m.id,
                cells: [
                  m.name || m.user?.name,
                  m.email || m.user?.email,
                  <Badge>{m.roleName || m.role}</Badge>,
                  ...(canManage
                    ? [
                        <Button
                          variant="link"
                          onClick={() => {
                            setMember(m);
                            updateMember.reset();
                          }}
                        >
                          {t("manageMember")}
                        </Button>,
                      ]
                    : []),
                ],
                sort: [m.name || "", m.email || "", m.roleName || m.role || ""],
              }))}
            />
          </Section>
          <Section title={t("invitations")}>
            {list(query.data.invitations).length ? (
              <Table
                headers={[
                  t("email"),
                  t("role"),
                  t("status"),
                  t("expires"),
                  ...(canManage ? [t("manage")] : []),
                ]}
                rows={list(query.data.invitations).map((i) => ({
                  id: i.id,
                  cells: [
                    i.email,
                    i.roleName || i.role,
                    <Badge>{i.status}</Badge>,
                    formatDate(i.expiresAt),
                    ...(canManage
                      ? [
                          i.status === "pending" ? (
                            <Button
                              variant="link"
                              onClick={() => setCancelInvite(i)}
                            >
                              {t("cancelInvitation")}
                            </Button>
                          ) : null,
                        ]
                      : []),
                  ],
                  sort: [i.email, i.roleName || i.role, i.status, i.expiresAt],
                }))}
              />
            ) : (
              <Empty>{t("noInvitations")}</Empty>
            )}
          </Section>
        </>
      )}
      {outboxAllowed && (
        <Section
          title={t("developmentOutbox")}
          meta={
            <Button onClick={() => setOutboxOpen((v) => !v)}>
              {outboxOpen ? t("hidePreview") : t("showPreview")}
            </Button>
          }
        >
          <Callout>{t("developmentOutboxHint")}</Callout>
          {outboxOpen && (
            <>
              <LoadState query={outbox} />
              {list(outbox.data, "messages").map((message) => (
                <article key={message.id} className="knowledge-item">
                  <h3>{message.subject}</h3>
                  <span className="muted">
                    {message.to || message.email || message.recipient}
                  </span>
                  <p className="preserve-lines">
                    {message.text || message.body}
                  </p>
                </article>
              ))}
            </>
          )}
        </Section>
      )}
      {inviteOpen && canManage && (
        <Modal
          title={t("createInvitation")}
          onClose={() => setInviteOpen(false)}
        >
          <Form
            label={t("createInvitation")}
            pending={invite.isPending}
            error={invite.error}
            onSubmit={(form) =>
              invite.mutate({
                ...Object.fromEntries(form),
                expiresInDays: Number(form.get("expiresInDays")),
              })
            }
          >
            <Callout>{t("emailInvitationHint")}</Callout>
            <Field label={t("email")}>
              <Input autoFocus type="email" required name="email" />
            </Field>
            <Field label={t("role")}>
              <NativeSelect name="roleId" required defaultValue="">
                <option value="" disabled>
                  {t("chooseRole")}
                </option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t("invitationExpiry")}>
              <NativeSelect name="expiresInDays" defaultValue="7">
                <option value="1">{t("oneDay")}</option>
                <option value="7">{t("sevenDays")}</option>
                <option value="14">{t("fourteenDays")}</option>
              </NativeSelect>
            </Field>
          </Form>
        </Modal>
      )}
      {member && canManage && (
        <Modal
          title={`${t("manageMember")} · ${member.name || member.email}`}
          onClose={() => setMember(null)}
        >
          <Form
            label={t("saveRole")}
            pending={updateMember.isPending}
            error={updateMember.error}
            onSubmit={(form) => updateMember.mutate(Object.fromEntries(form))}
          >
            <Field label={t("role")}>
              <NativeSelect
                name="roleId"
                required
                defaultValue={member.roleId || ""}
              >
                <option value="" disabled>
                  {t("chooseRole")}
                </option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </Form>
          <Button
            variant="link"
            onClick={() => {
              setOffboard(member);
              setMember(null);
            }}
          >
            {t("offboardMember")}
          </Button>
        </Modal>
      )}
      {offboard && canManage && (
        <Modal title={t("offboardMember")} onClose={() => setOffboard(null)}>
          <Form
            label={t("offboardMember")}
            pending={offboarding.isPending}
            error={offboarding.error}
            onSubmit={(f) => offboarding.mutate({ reason: f.get("reason") })}
          >
            <Callout>{t("offboardWarning")}</Callout>
            <p>{offboard.email}</p>
            <Field label={t("reasonOptional")}>
              <Input name="reason" />
            </Field>
          </Form>
        </Modal>
      )}
      {cancelInvite && canManage && (
        <Modal
          title={t("cancelInvitation")}
          onClose={() => setCancelInvite(null)}
        >
          <Form
            label={t("cancelInvitation")}
            pending={cancelling.isPending}
            error={cancelling.error}
            onSubmit={() => cancelling.mutate({})}
          >
            <Callout>{t("cancelInvitationWarning")}</Callout>
            <p>{cancelInvite.email}</p>
          </Form>
        </Modal>
      )}
    </Page>
  );
}
function formatDate(value: unknown) {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(document.documentElement.lang);
}
