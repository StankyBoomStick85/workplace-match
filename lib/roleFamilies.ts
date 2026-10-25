// Curated role families for a candidate's direction ("Where I'm heading").
// Maintained by hand. A family is a kind of work, never a job title: these
// labels are what the employer summary's THRIVES IN line is written from, so
// they must read naturally to a hiring manager and contain no title words
// (manager, director, officer, ...). "Other" is not in this list; a candidate
// who picks it supplies their own free-text family.
//
// matchTerms: lowercase phrases that count as naming the family when the
// summary paraphrases it (e.g. "program management" for "Program and project
// management"). The label itself always counts too.

export type RoleFamily = {
  id: string;
  label: string;
  matchTerms: string[];
};

export const ROLE_FAMILIES: RoleFamily[] = [
  { id: "operations_leadership", label: "Operations leadership", matchTerms: ["operations leadership", "operations"] },
  { id: "executive_leadership", label: "Executive leadership", matchTerms: ["executive leadership", "general management"] },
  { id: "program_project_management", label: "Program and project management", matchTerms: ["program management", "project management", "program and project management"] },
  { id: "business_development", label: "Business development and partnerships", matchTerms: ["business development", "partnerships", "partnership development"] },
  { id: "sales_account_management", label: "Sales and account management", matchTerms: ["sales", "account management"] },
  { id: "customer_success", label: "Customer success and client services", matchTerms: ["customer success", "client services", "customer experience"] },
  { id: "recruiting_talent", label: "Recruiting and talent acquisition", matchTerms: ["recruiting", "talent acquisition"] },
  { id: "people_operations", label: "People operations and HR", matchTerms: ["people operations", "human resources", "hr"] },
  { id: "training_development", label: "Training and learning development", matchTerms: ["training", "learning and development", "instructional design"] },
  { id: "logistics_supply_chain", label: "Logistics and supply chain", matchTerms: ["logistics", "supply chain"] },
  { id: "security_risk", label: "Security and risk management", matchTerms: ["security", "risk management"] },
  { id: "emergency_management", label: "Emergency management and crisis response", matchTerms: ["emergency management", "crisis response", "crisis management"] },
  { id: "safety_compliance", label: "Safety and compliance", matchTerms: ["safety", "compliance"] },
  { id: "consulting_advisory", label: "Consulting and advisory", matchTerms: ["consulting", "advisory"] },
  { id: "public_sector", label: "Government and public sector work", matchTerms: ["government", "public sector"] },
  { id: "technology_it", label: "Technology and IT", matchTerms: ["technology", "information technology", "it operations"] },
  { id: "cybersecurity", label: "Cybersecurity", matchTerms: ["cybersecurity", "cyber security", "information security"] },
  { id: "data_analytics", label: "Data and analytics", matchTerms: ["data", "analytics"] },
  { id: "product_management", label: "Product management", matchTerms: ["product management", "product"] },
  { id: "engineering", label: "Engineering", matchTerms: ["engineering"] },
  { id: "skilled_trades", label: "Skilled trades and construction", matchTerms: ["skilled trades", "trades", "construction"] },
  { id: "manufacturing_production", label: "Manufacturing and production", matchTerms: ["manufacturing", "production"] },
  { id: "facilities_maintenance", label: "Facilities and maintenance", matchTerms: ["facilities", "maintenance"] },
  { id: "healthcare_medical", label: "Healthcare and emergency medical", matchTerms: ["healthcare", "health care", "emergency medical", "medical"] },
  { id: "finance_accounting", label: "Finance and accounting", matchTerms: ["finance", "accounting"] },
  { id: "administration", label: "Administration and office operations", matchTerms: ["administration", "office operations", "administrative"] },
  { id: "marketing_communications", label: "Marketing and communications", matchTerms: ["marketing", "communications"] },
  { id: "startup_founder", label: "Startup and founder roles", matchTerms: ["startup", "start-up", "founder", "entrepreneurship"] },
];

export const ROLE_FAMILY_BY_ID = new Map(ROLE_FAMILIES.map((f) => [f.id, f] as const));

// The id a candidate's own free-text family is stored under.
export const OTHER_ROLE_FAMILY_ID = "other";
