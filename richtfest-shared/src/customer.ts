import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));
const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .email()
  .or(z.literal(""))
  .nullable()
  .optional()
  .transform((value) => (value === "" ? null : value));

export const customerInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: optionalEmail,
  phone: optionalText(80),
  street: optionalText(300),
  postalCode: optionalText(32),
  city: optionalText(200),
  country: optionalText(100),
  billingName: optionalText(200),
  billingStreet: optionalText(300),
  billingPostalCode: optionalText(32),
  billingCity: optionalText(200),
  billingCountry: optionalText(100),
  invoiceEmail: optionalEmail,
  vatId: optionalText(80),
  taxNumber: optionalText(80),
  paymentTerms: optionalText(500),
  notes: optionalText(5000),
});

export type CustomerInput = z.infer<typeof customerInput>;
