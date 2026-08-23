// Standalone copy of the holistic skill-match scoring used elsewhere
// (components/EmployerFindApplicants.tsx, components/ApplicantJobsMap.tsx).
// Deliberately NOT imported by those two files - match score computation is
// treated as sensitive/frozen in this project, so this copy exists only to
// give the employer Matches page a match percentage for one-sided interest
// entries without touching either existing, already-working scoring path.
// If you ever consolidate these, verify all three produce identical output
// before removing any copy.

export type SkillMatchSignals = {
  topSkills?: string[];
  desiredJobType?: string;
  capabilitySummary?: string;
  experienceLevel?: string;
};

export function getApplicantMatchSignals(profile: SkillMatchSignals | null | undefined) {
  if (!profile) {
    return [];
  }

  return [
    ...(profile.topSkills ?? []),
    profile.desiredJobType ?? "",
    profile.capabilitySummary ?? "",
    profile.experienceLevel ?? ""
  ].filter(Boolean);
}

export function calculateSkillMatch(requiredSkillsValue: string[], candidateSkillsValue: string[], jobTitle = "") {
  const requiredSkills = parseFlexibleSkills(requiredSkillsValue);
  const candidateSkills = parseFlexibleSkills(candidateSkillsValue);
  const scoredRequirements = requiredSkills.map((requiredSkill) => ({
    skill: requiredSkill,
    score: getBestRequirementScore(requiredSkill, candidateSkills)
  }));
  const matchedSkills = scoredRequirements.filter((result) => result.score > 0).map((result) => result.skill);
  const missingSkills = scoredRequirements.filter((result) => result.score === 0).map((result) => result.skill);
  const totalScore = scoredRequirements.reduce((sum, result) => sum + result.score, 0);
  const calculatedPercentage =
    requiredSkills.length > 0 ? Math.min(100, Math.round((totalScore / requiredSkills.length) * 100)) : 0;
  const percentage = Math.max(
    calculatedPercentage,
    getLeadershipCrewMatchFloor(candidateSkills, requiredSkills, jobTitle)
  );

  return {
    percentage,
    matchedSkills,
    missingSkills
  };
}

function parseFlexibleSkills(value: string[]) {
  return value
    .flatMap((skill) => skill.split(/[,\r\n]+/))
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function normalizeSkill(skill: string) {
  return skill
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-\s]+/g, " ")
    .trim();
}

const capabilityTranslationGroups = [
  ["leadership", "supervisor", "team lead", "shift lead", "crew lead", "manager", "management", "assistant manager"],
  ["operational planning", "operations", "logistics", "coordination", "planning", "scheduling"],
  ["process improvement", "lean", "continuous improvement", "efficiency", "workflow improvement"],
  ["risk assessment", "safety", "compliance", "hazard analysis", "risk management"],
  ["team development", "training", "mentoring", "coaching", "onboarding"],
  [
    "decision making under pressure",
    "decision making",
    "fast paced",
    "emergency response",
    "dispatch",
    "production leadership",
    "critical decisions"
  ],
  ["systems thinking", "process mapping", "root cause analysis", "workflow", "operations support"],
  ["adaptability", "changing priorities", "fast paced environment", "flexible", "problem solving"],
  ["execution", "delivery", "follow through", "implementation", "operations"]
].map((group) => group.map(normalizeSkill));

const hierarchyTransferGroups = [
  {
    sources: ["leadership", "team development", "supervisor", "manager", "assistant manager", "shift lead", "team lead", "crew lead"],
    targets: ["crew", "crew member", "team member", "associate", "frontline worker", "frontline", "staff member"],
    score: 0.7
  },
  {
    sources: ["leadership", "team development", "execution", "decision making", "decision making under pressure", "supervisor", "manager", "assistant manager", "shift lead", "team lead"],
    targets: ["shift lead", "team lead", "crew lead", "assistant manager", "supervisor"],
    score: 0.9
  },
  {
    sources: ["operational planning", "operations", "logistics", "process improvement", "execution", "fulfillment", "inventory"],
    targets: ["picker", "warehouse associate", "warehouse", "inventory", "fulfillment", "stocker", "stock associate"],
    score: 0.7
  },
  {
    sources: ["safety", "risk assessment", "compliance", "hazard analysis", "risk management"],
    targets: ["warehouse", "production", "operations support"],
    score: 0.45
  },
  {
    sources: ["safety", "risk assessment", "compliance", "hazard analysis", "risk management"],
    targets: ["forklift", "warehouse", "production", "operations support"],
    score: 0.35
  },
  {
    sources: ["forklift", "equipment operation", "equipment operations", "warehouse machinery", "machinery", "powered industrial truck", "pallet jack"],
    targets: ["forklift", "equipment operation", "warehouse machinery"],
    score: 0.95
  },
  {
    sources: ["adaptability", "execution", "systems thinking", "problem solving", "workflow"],
    targets: ["operations support", "associate", "team member", "fulfillment"],
    score: 0.5
  }
].map((group) => ({
  ...group,
  sources: group.sources.map(normalizeSkill),
  targets: group.targets.map(normalizeSkill)
}));

function getBestRequirementScore(requiredSkill: string, candidateSkills: string[]) {
  return candidateSkills.reduce(
    (bestScore, candidateSkill) => Math.max(bestScore, getSkillMatchScore(requiredSkill, candidateSkill)),
    0
  );
}

function getSkillMatchScore(requiredSkill: string, candidateSkill: string) {
  const requiredForms = getSkillForms(requiredSkill);
  const candidateForms = getSkillForms(candidateSkill);

  if (requiredForms.some((requiredForm) => candidateForms.includes(requiredForm))) {
    return 1;
  }

  const requiredConcepts = getCapabilityConcepts(requiredForms);
  const candidateConcepts = getCapabilityConcepts(candidateForms);
  if (requiredConcepts.some((concept) => candidateConcepts.includes(concept))) {
    return 0.85;
  }

  return getHierarchyTransferScore(requiredForms, candidateForms);
}

function getSkillForms(skill: string) {
  const normalized = normalizeSkill(skill);
  const singularized = normalized
    .split(" ")
    .map(singularizeWord)
    .join(" ");
  return Array.from(new Set([normalized, singularized].filter(Boolean)));
}

function singularizeWord(word: string) {
  if (word.endsWith("ies") && word.length > 4) {
    return `${word.slice(0, -3)}y`;
  }

  if (word.endsWith("es") && word.length > 4) {
    return word.slice(0, -2);
  }

  if (word.endsWith("s") && word.length > 3) {
    return word.slice(0, -1);
  }

  return word;
}

function getCapabilityConcepts(skillForms: string[]) {
  return capabilityTranslationGroups
    .map((group, index) =>
      group.some((term) =>
        skillForms.some(
          (skillForm) =>
            skillForm === term ||
            skillForm.includes(term) ||
            (skillForm.length >= 4 && term.includes(skillForm))
        )
      )
        ? index
        : -1
    )
    .filter((index) => index >= 0);
}

function getHierarchyTransferScore(requiredForms: string[], candidateForms: string[]) {
  return hierarchyTransferGroups.reduce((bestScore, group) => {
    const hasSource = group.sources.some((source) => skillFormsContain(candidateForms, source));
    const hasTarget = group.targets.some((target) => skillFormsContain(requiredForms, target));

    return hasSource && hasTarget ? Math.max(bestScore, group.score) : bestScore;
  }, 0);
}

function getLeadershipCrewMatchFloor(candidateSkills: string[], requiredSkills: string[], jobTitle: string) {
  const candidateForms = candidateSkills.flatMap(getSkillForms);
  const roleForms = [...requiredSkills, jobTitle].flatMap(getSkillForms);
  const hasLeadership = leadershipFloorTerms.some((term) => skillFormsContain(candidateForms, term));
  const isCrewRole = crewFloorTerms.some((term) => skillFormsContain(roleForms, term));

  return hasLeadership && isCrewRole ? 30 : 0;
}

const leadershipFloorTerms = [
  "leadership",
  "team development",
  "supervisor",
  "manager",
  "shift lead",
  "crew lead"
].map(normalizeSkill);

const crewFloorTerms = ["crew", "crew member", "team member", "associate", "entry level"].map(normalizeSkill);

function skillFormsContain(skillForms: string[], term: string) {
  return skillForms.some(
    (skillForm) =>
      skillForm === term ||
      skillForm.includes(term) ||
      (skillForm.length >= 4 && term.includes(skillForm))
  );
}
