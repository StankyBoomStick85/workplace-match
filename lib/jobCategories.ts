export const GIG_KEYWORDS = [
  "uber",
  "lyft",
  "doordash",
  "delivery",
  "driver",
  "dasher",
  "courier",
  "rideshare",
  "temporary",
  "temp ",
  "flex",
  "gig"
];

export function isGigJob(job: { title: string; job_type?: string | null }): boolean {
  const text = `${job.title} ${job.job_type ?? ""}`.toLowerCase();
  return GIG_KEYWORDS.some((kw) => text.includes(kw));
}
