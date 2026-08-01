-- Adzuna's API returns salary_is_predicted on each result: whether
-- salary_min/salary_max is Adzuna's own prediction model output rather than
-- a rate the employer actually posted. This was never captured, so predicted
-- salaries have been displayed as if they were posted pay (e.g. a $53,079/yr
-- "estimate" for a role whose real posted rate, from the description text,
-- is $15.00-$18.75/hour — about $31k-$39k annualized).
ALTER TABLE public.adzuna_cache
  ADD COLUMN salary_is_predicted boolean NOT NULL DEFAULT true;

-- Existing rows predate this column, so we have no record of whether their
-- salary_min/salary_max was Adzuna's guess or the employer's own figure.
-- Defaulting to true (treat as an estimate) is the safer failure mode: the
-- alternative (defaulting to false) would keep presenting unverified guesses
-- as confirmed posted pay, which is exactly the bug this migration exists to
-- fix. adzuna_cache has only a 6-hour expiry and is refreshed wholesale on
-- every cache cycle, so this default only affects display for a brief
-- transitional window until the next refresh brings in the real flag.
