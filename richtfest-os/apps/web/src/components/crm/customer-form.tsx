import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CustomerInput } from "@richtfest/shared";
import { api } from "../../api";
import { queryClient } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { Field, Form } from "../ui/primitives";

export function CustomerForm({
  customer,
  onSaved,
}: {
  customer?: CustomerInput & { id: string };
  onSaved: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<CustomerInput>(customer ?? { name: "" });
  const write = useMutation({
    mutationFn: () =>
      api(
        customer ? `/crm/customers/${customer.id}` : "/crm/customers",
        draft,
        customer ? "PATCH" : "POST",
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onSaved();
    },
  });
  const field = (
    name: keyof CustomerInput,
    label: Parameters<typeof t>[0],
    maxLength: number,
    type = "text",
  ) => (
    <Field
      label={name === "name" ? t(label) : `${t(label)} (${t("optional")})`}
    >
      <Input
        name={name}
        value={draft[name] ?? ""}
        onChange={(event) =>
          setDraft((current) => ({ ...current, [name]: event.target.value }))
        }
        onInvalid={(event) => {
          const section = event.currentTarget.closest("details");
          if (section) section.open = true;
        }}
        maxLength={maxLength}
        type={type}
        required={name === "name"}
        autoFocus={name === "name"}
      />
    </Field>
  );
  return (
    <Form
      label={customer ? t("save") : t("newCustomer")}
      pending={write.isPending}
      error={write.error}
      onSubmit={() => write.mutate()}
    >
      <fieldset disabled={write.isPending} className="grid gap-stack min-w-0">
        {field("name", "company", 200)}
        <div className="grid gap-stack sm:grid-cols-2">
          {field("email", "email", 254, "email")}
          {field("phone", "customerPhone", 80, "tel")}
        </div>
        <details className="border-t pt-3" open>
          <summary className="cursor-pointer font-medium text-ui">
            {t("customerAddress")}
          </summary>
          <div className="grid gap-stack pt-3">
            {field("street", "customerStreet", 300)}
            <div className="grid gap-stack sm:grid-cols-2">
              {field("postalCode", "customerPostalCode", 32)}
              {field("city", "customerCity", 200)}
            </div>
            {field("country", "customerCountry", 100)}
          </div>
        </details>
        <details className="border-t pt-3">
          <summary className="cursor-pointer font-medium text-ui">
            {t("customerBilling")}
          </summary>
          <div className="grid gap-stack pt-3">
            <Button
              type="button"
              variant="outline"
              className="justify-self-start"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  billingName: current.name,
                  billingStreet: current.street ?? "",
                  billingPostalCode: current.postalCode ?? "",
                  billingCity: current.city ?? "",
                  billingCountry: current.country ?? "",
                }))
              }
            >
              {t("customerCopyAddress")}
            </Button>
            {field("billingName", "customerBillingName", 200)}
            {field("billingStreet", "customerStreet", 300)}
            <div className="grid gap-stack sm:grid-cols-2">
              {field("billingPostalCode", "customerPostalCode", 32)}
              {field("billingCity", "customerCity", 200)}
            </div>
            {field("billingCountry", "customerCountry", 100)}
            {field("invoiceEmail", "customerInvoiceEmail", 254, "email")}
            <div className="grid gap-stack sm:grid-cols-2">
              {field("vatId", "customerVatId", 80)}
              {field("taxNumber", "customerTaxNumber", 80)}
            </div>
            {field("paymentTerms", "customerPaymentTerms", 500)}
          </div>
        </details>
        <Field label={`${t("customerNotes")} (${t("optional")})`}>
          <Textarea
            name="notes"
            rows={2}
            maxLength={5000}
            value={draft.notes ?? ""}
            onChange={(event) =>
              setDraft((current) => ({ ...current, notes: event.target.value }))
            }
          />
        </Field>
      </fieldset>
    </Form>
  );
}
