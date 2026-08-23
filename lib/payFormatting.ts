// Shared by every place that displays a job listing's stored pay_min/pay_max -
// keeps the thousands-separator and per-year vs per-hour formatting identical
// everywhere instead of re-implementing (and re-breaking) it per component.

export function formatStoredPayRange(
  payMin?: number | null,
  payMax?: number | null,
  payType?: string | null
): string {
  const suffix = payType === "annual" ? "/year" : "/hour";
  const format = (value: number) => `$${value.toLocaleString("en-US")}`;

  if (payMin && payMax && payMax !== payMin) {
    return `${format(payMin)}-${format(payMax)}${suffix}`;
  }
  if (payMin) {
    return `${format(payMin)}${suffix}`;
  }
  return "";
}
