import { z } from "zod";
import { isValidStellarAddress } from "../../app/utils/stellar";
import { getPrecisionError, parseAmount } from "../../app/utils/amount";

/**
 * Issue #113 — shared Zod schema for the remittance form.
 *
 * Field-level rules live here so the form component only wires React Hook Form
 * to `zodResolver(remittanceSchema)` and renders `formState.errors`. Async
 * checks that need server data (duplicate-remittance detection) are layered on
 * top in the component with `setError`.
 */
export const REMITTANCE_TOKENS = ["USDC", "EURC", "PHP"] as const;
export type RemittanceToken = (typeof REMITTANCE_TOKENS)[number];

export const MEMO_MAX_LENGTH = 28;

export const remittanceSchema = z
  .object({
    recipientAddress: z
      .string()
      .trim()
      .min(1, "Recipient address is required")
      .refine(
        isValidStellarAddress,
        "Invalid Stellar address format (must be 56 characters starting with G)",
      ),
    token: z.enum(REMITTANCE_TOKENS, { message: "Select a valid token" }),
    amount: z
      .string()
      .min(1, "Amount is required")
      .refine((value) => {
        const parsed = parseAmount(value);
        return !Number.isNaN(parsed) && parsed > 0;
      }, "Amount must be greater than 0"),
    memo: z
      .string()
      .max(MEMO_MAX_LENGTH, `Memo must be ${MEMO_MAX_LENGTH} characters or less`)
      .optional()
      .or(z.literal("")),
  })
  .superRefine((values, ctx) => {
    const precisionError = getPrecisionError(values.amount, values.token);
    if (precisionError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: precisionError,
      });
    }
  });

export type RemittanceFormValues = z.infer<typeof remittanceSchema>;

export const REMITTANCE_FORM_DEFAULTS: RemittanceFormValues = {
  recipientAddress: "",
  token: "USDC",
  amount: "",
  memo: "",
};
