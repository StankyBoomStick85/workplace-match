// Translation glossary for Tier 1 capability statements.
//
// WHAT THIS IS: a small CORRECTION LAYER, not a dictionary. Workplace Match
// serves everyone - civilians, every branch of service, any background - and
// the synthesis model is expected to translate any role, title, or
// organization from its own general knowledge. An entry belongs here only when
// that general knowledge is wrong or ambiguous for a real profile (example:
// general Army knowledge says an E-6 is a supervisor, but on a Special Forces
// team an E-6 supervises no one). When a term in the evidence matches an
// entry (by term or alias), the entry is authoritative and overrides the
// model's own understanding.
//
// HOW TO EDIT: plain data, one object per term. Add entries for any field
// (healthcare, trades, law enforcement, other branches...). Fields:
//   term            - the canonical term as it tends to appear in evidence
//   aliases         - other spellings/abbreviations that mean the same thing
//                     (matched case-insensitively on word boundaries)
//   field           - broad domain, for your own organization of the list
//   context         - organization context the entry applies to, when the
//                     same word means different things in different places
//                     (e.g. "Special Forces team" vs "conventional unit");
//                     omit when it applies everywhere
//   employerMeaning - what a hiring manager should understand, in plain words
//   allowedFacts    - facts the model MAY state when this term is in a cited
//                     claim (team sizes, scales). Numbers here count as
//                     sourced for the number-provenance check, but only for a
//                     proof line whose cited claims contain this term.
//   niche           - true when the skill is specialized enough that it goes
//                     in the separate niche list, never the core statements
//   neverOutput     - true when the term itself must never appear in output
//   notes           - extra instruction for the model
//
// Seeded 2026-10-22, mostly Special Forces terms where general knowledge misleads.

export type GlossaryEntry = {
  term: string;
  aliases: string[];
  field: string;
  context?: string;
  employerMeaning: string;
  allowedFacts?: string[];
  niche?: boolean;
  neverOutput?: boolean;
  notes?: string;
};

export const TRANSLATION_GLOSSARY: GlossaryEntry[] = [
  // ---------- Special Forces team structure ----------
  {
    term: "Team",
    aliases: ["ODA", "SFOD-A", "SFODA", "Operational Detachment-Alpha", "Operational Detachment Alpha", "Detachment", "DET"],
    field: "military",
    context: "Special Forces team",
    employerMeaning: "A small, self-sufficient specialist team that operates independently, often far from support.",
    allowedFacts: ["team size: 12 people"],
  },
  {
    term: "Team Leader (officer)",
    aliases: ["Detachment Commander", "Team Leader", "ODA Commander"],
    field: "military",
    context: "Special Forces team",
    employerMeaning: "Owns the team's intent and answers for its success or failure - the CEO of the team.",
  },
  {
    term: "Warrant Officer / Assistant Detachment Commander",
    aliases: ["Assistant Detachment Commander", "Warrant Officer", "180A", "Detachment Technician"],
    field: "military",
    context: "Special Forces team",
    employerMeaning:
      "Second-in-command of the team. When the team splits to cover more ground, independently leads half of it with full decision authority. Frequently the liaison to senior government and diplomatic partners.",
    allowedFacts: ["half-team size: about 6 people"],
    notes: "Always came up through the enlisted team ranks first - so this person has also done the individual specialist work.",
  },
  {
    term: "Team Sergeant",
    aliases: ["Team Sergeant", "Operations Sergeant (team)", "ODA Team Sergeant", "18Z"],
    field: "military",
    context: "Special Forces team",
    employerMeaning: "Director of operations for a 12-person team; owns execution, people, and resources - the COO of the team.",
    allowedFacts: ["team size: 12 people", "leads 11 others"],
  },
  {
    term: "Assistant Team Sergeant",
    aliases: ["Assistant Team Sergeant", "Assistant Operations Sergeant", "ATS"],
    field: "military",
    context: "Special Forces team",
    employerMeaning: "Third in charge of the team; acts as the operations lead whenever the Team Sergeant is absent or not deployed.",
  },
  {
    term: "Ops & Intel Sergeant",
    aliases: ["Operations and Intelligence Sergeant", "Ops and Intel Sergeant", "O&I Sergeant", "18F"],
    field: "military",
    context: "Special Forces team",
    employerMeaning: "Plans the team's projects and assignments, runs its analysis and planning, and frequently coordinates with senior government and diplomatic partners.",
  },
  {
    term: "Engineer Sergeant",
    aliases: ["Engineer Sergeant", "Senior Engineer Sergeant", "Junior Engineer Sergeant", "Special Forces Engineer", "18C"],
    field: "military",
    context: "Special Forces team",
    employerMeaning: "The team's construction, demolitions, and infrastructure specialist.",
    allowedFacts: ["one senior and one junior per team"],
  },
  {
    term: "Split-team operations",
    aliases: ["split team", "split-team", "split ODA", "split detachment"],
    field: "military",
    context: "Special Forces team",
    employerMeaning: "Running two independent units at once in different locations, each with its own leadership pair.",
    allowedFacts: ["each half: about 6 people"],
  },

  // ---------- Organization sizes ----------
  {
    term: "Company",
    aliases: ["SFOD-B", "SFODB", "ODB", "Operational Detachment-Bravo", "company headquarters"],
    field: "military",
    employerMeaning: "An organization of about 6 teams.",
    allowedFacts: ["about 6 teams", "80-100 people"],
  },
  {
    term: "Battalion",
    aliases: ["Battalion", "BN"],
    field: "military",
    employerMeaning: "An organization of several companies.",
    allowedFacts: ["about 400 people"],
  },
  {
    term: "Operations Sergeant (battalion staff)",
    aliases: ["Battalion Operations Sergeant", "S3 Operations Sergeant", "Battalion S3", "S3 Air NCO"],
    field: "military",
    context: "battalion staff",
    employerMeaning: "Plans and coordinates the projects and day-to-day operations of the whole parent organization.",
    allowedFacts: ["about 400 people"],
  },
  {
    term: "First Sergeant",
    aliases: ["First Sergeant", "1SG"],
    field: "military",
    employerMeaning: "Senior leader responsible for every person in a company.",
    allowedFacts: ["100+ people"],
  },
  {
    term: "Sergeant Major",
    aliases: ["Sergeant Major", "Command Sergeant Major", "CSM", "SGM"],
    field: "military",
    employerMeaning: "Senior adviser to the organization's top leader, at battalion level or larger.",
  },
  {
    term: "Acting [role]",
    aliases: ["Acting", "acted as", "served as acting"],
    field: "general",
    employerMeaning: "Selected over peers to fill a higher role before being promoted to it.",
  },

  // ---------- Rank is context-dependent ----------
  {
    term: "Rank / pay grade",
    aliases: ["E-6", "E-7", "E-8", "E6", "E7", "E8", "SSG", "SFC", "MSG", "Staff Sergeant", "Sergeant First Class", "Master Sergeant"],
    field: "military",
    employerMeaning:
      "Rank only tells you scope once you know the organization. Conventional units: E-6 = supervisor, E-7 = manager, E-8 = senior manager. Special Forces teams: E-6 = senior operator (expert individual contributor, supervises no one); E-7 = team lead and project manager for specific areas, at times the senior person on the ground; E-8 = director of operations.",
    notes: "Never name the rank. Translate the scope for the organization the evidence describes.",
  },

  // ---------- Performance evaluations ----------
  {
    term: "NCOER",
    aliases: ["NCOER", "Noncommissioned Officer Evaluation Report", "NCO Evaluation Report", "OER"],
    field: "military",
    employerMeaning: "Annual performance review by two levels of management.",
    neverOutput: true,
  },
  {
    term: "Senior rater",
    aliases: ["Senior Rater", "SR"],
    field: "military",
    employerMeaning: "Second-level manager who ranks the person against every peer they have supervised.",
  },
  {
    term: "Most Qualified",
    aliases: ["Most Qualified", "MQ"],
    field: "military",
    employerMeaning: "Top performance tier, capped at under 24% of a rater's population.",
    allowedFacts: ["capped under 24% of a rater's population"],
  },
  {
    term: "Peer ranking",
    aliases: ["Rated #", "Ranked #", "top 3%", "top 5%", "of E7s", "SFCs senior rated"],
    field: "military",
    employerMeaning: "Head-to-head ranking against peers. Use the numbers exactly as written.",
  },
  {
    term: "Promotion board score",
    aliases: ["promotion board", "board score"],
    field: "military",
    employerMeaning: "Competitive panel evaluation. Use the score as written.",
  },

  // ---------- Duties and appointments ----------
  {
    term: "Jumpmaster",
    aliases: ["Jumpmaster", "Jump Master", "SLJM", "Static Line Jumpmaster", "HELO Cast Master", "Cast Master"],
    field: "military",
    employerMeaning:
      "Safety-critical inspector who personally checks other people's equipment and controls the jump; accountable for their lives.",
    niche: true,
  },
  {
    term: "Range Safety Officer",
    aliases: ["Range Safety Officer", "RSO", "OIC/RSO"],
    field: "military",
    employerMeaning: "Responsible for the safety of a live-fire exercise and everyone on it.",
  },
  {
    term: "Property book holder / hand receipt",
    aliases: ["property book", "hand receipt", "Property Book Manager", "sub-hand receipt"],
    field: "military",
    employerMeaning: "Personally signed for equipment and is financially liable for any loss.",
  },
  {
    term: "Ordering officer",
    aliases: ["Field Ordering Officer", "FOO", "Ordering Officer", "OPFUND"],
    field: "military",
    employerMeaning: "Authorized to spend organizational funds; personally accountable for every transaction.",
  },
  {
    term: "Deployment",
    aliases: ["deployment", "deployed", "combat deployment", "imminent danger pay area"],
    field: "military",
    employerMeaning:
      "Extended assignment abroad, often in austere conditions with zero room for error. A combat deployment is performed under direct physical threat.",
    notes: "Never name locations or operations.",
  },
  {
    term: "Convoy / movement leader",
    aliases: ["convoy", "convoy commander", "convoy leader", "movement leader", "ground movement", "ground movements", "ground leader"],
    field: "military",
    employerMeaning:
      "Led transport teams responsible for people's safety and on-time delivery of high-value equipment by road and air.",
  },
  {
    term: "Partner force training / FID",
    aliases: ["FID", "Foreign Internal Defense", "partner force", "partner nation", "JCET", "host nation"],
    field: "military",
    employerMeaning: "Trained and advised foreign organizations across language and culture.",
  },
  {
    term: "Fires / close air support",
    aliases: ["Joint Fires Observer", "JFO", "close air support", "CAS", "fire support", "FIST", "Forward Observer", "fires"],
    field: "military",
    employerMeaning: "Real-time coordination of air and ground assets with zero room for error.",
    niche: true,
  },
  {
    term: "Recruiting / production",
    aliases: ["recruiting", "recruiter", "production", "USAREC"],
    field: "military",
    employerMeaning: "Recruiting against an annual hiring target: prospecting, screening, and bringing on qualified candidates. It is recruiting, never sales.",
  },
  {
    term: "Selection prep",
    aliases: ["Pre-SFAS", "SFAS", "Special Forces Assessment and Selection", "selection"],
    field: "military",
    employerMeaning: "Prepared candidates for a highly selective assessment.",
    notes: "State pass rates only as written in the documents.",
  },
  {
    term: "Qualification course (SFQC)",
    aliases: ["SFQC", "Q Course", "Special Forces Qualification Course"],
    field: "military",
    employerMeaning: "A long, highly selective training pipeline.",
    allowedFacts: ["1.5 to 2.5 years depending on specialty and language difficulty"],
    notes: "Never name the course.",
  },
  {
    term: "Language test scores",
    aliases: ["DLPT", "OPI", "Oral Proficiency Interview", "Defense Language Proficiency Test", "1+/1+", "2/1+"],
    field: "general",
    employerMeaning: "Standardized language proficiency scale; 2 = working proficiency.",
    niche: true,
  },
  {
    term: "Fitness test score",
    aliases: ["ACFT", "APFT", "Army Combat Fitness Test", "PT test"],
    field: "military",
    employerMeaning: "Scored out of 600; 540 or above is top tier.",
    allowedFacts: ["maximum score 600", "540+ is top tier"],
  },
  {
    term: "Medals",
    aliases: ["Medal", "Bronze Star", "Commendation Medal", "Achievement Medal", "Meritorious Service Medal"],
    field: "military",
    employerMeaning: "Formal recognition for performance. A Bronze Star means significant achievement in a dangerous assignment.",
    notes: "Count only, never name the medal.",
  },
  {
    term: "Combat badges",
    aliases: ["Combat Infantryman Badge", "Combat Action Badge", "CIB", "CAB"],
    field: "military",
    employerMeaning: "Recognition for performing under direct threat.",
    notes: "Never name the badge. May support a statement that the person performs under direct threat.",
  },
  {
    term: "Security clearance",
    aliases: ["security clearance", "Secret clearance", "Top Secret", "TS/SCI"],
    field: "general",
    employerMeaning: "A time-limited eligibility to handle classified information.",
    notes: "May be stated as a fact with its expiration date. Never say who granted it. Never call it permanently active.",
  },
  {
    term: "Embassy",
    aliases: ["Embassy", "Country Team", "Ambassador", "Defense Attache"],
    field: "general",
    employerMeaning: "Liaison with senior government and diplomatic partners.",
    neverOutput: true,
  },
];

function aliasPattern(alias: string): RegExp {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word boundaries only where the alias starts/ends with a word character, so
  // aliases like "1+/1+" or "#" still match.
  const start = /^\w/.test(alias) ? "\\b" : "";
  const end = /\w$/.test(alias) ? "\\b" : "";
  return new RegExp(start + escaped + end, "i");
}

// Glossary entries whose term or any alias occurs in the given text.
export function matchGlossaryEntries(text: string, glossary: GlossaryEntry[] = TRANSLATION_GLOSSARY): GlossaryEntry[] {
  return glossary.filter((entry) => [entry.term, ...entry.aliases].some((a) => a.trim() && aliasPattern(a).test(text)));
}

export function formatGlossaryForPrompt(glossary: GlossaryEntry[] = TRANSLATION_GLOSSARY): string {
  return glossary
    .map((e) => {
      const lines = [`- ${e.term}${e.aliases.length ? ` (also: ${e.aliases.join(", ")})` : ""}${e.context ? ` [applies to: ${e.context}]` : ""}`];
      lines.push(`  Means: ${e.employerMeaning}`);
      if (e.allowedFacts?.length) lines.push(`  Facts you may state: ${e.allowedFacts.join("; ")}`);
      if (e.niche) lines.push(`  NICHE: goes in the niche list, never a core statement.`);
      if (e.neverOutput) lines.push(`  Never output this term itself.`);
      if (e.notes) lines.push(`  Note: ${e.notes}`);
      return lines.join("\n");
    })
    .join("\n");
}
